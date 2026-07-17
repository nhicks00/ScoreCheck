#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { chmod, open, readFile, rename, rm, stat, writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const process = require("node:process");

const POLL_MS = 1_000;
const STARTUP_GRACE_MS = 15_000;
const STALE_PROGRESS_MS = 12_000;
const MAX_RESTARTS = 3;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(options.config, "utf8"));
  validateConfig(config, options.marker);
  let child = null;
  let childExit = null;
  let restartCount = 0;
  let lastRestartAt = null;
  let lastFailure = null;
  let launchedAtMs = 0;
  let closing = false;

  const writeStatus = async (state) => writeJsonAtomic(config.statusPath, {
    schemaVersion: 1,
    court: config.court,
    marker: config.marker,
    state,
    supervisorPid: process.pid,
    ffmpegPid: child?.pid ?? null,
    restartCount,
    lastRestartAt,
    lastFailure,
    updatedAt: new Date().toISOString()
  });

  const launch = async () => {
    await rm(config.progressPath, { force: true });
    const log = await open(config.logPath, "a", 0o600);
    try {
      childExit = null;
      child = spawn(config.ffmpegPath, config.ffmpegArgs, { stdio: ["ignore", log.fd, log.fd] });
      if (!Number.isInteger(child.pid) || child.pid < 2) throw new Error("FFmpeg child did not return a process id");
      child.once("exit", (code, signal) => { childExit = { code, signal }; });
      child.once("error", (error) => { childExit = { error: error.message }; });
      launchedAtMs = Date.now();
      await writeStatus("running");
    } finally {
      await log.close();
    }
  };

  const stopChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    for (let attempt = 0; attempt < 50 && child.exitCode === null && child.signalCode === null; attempt += 1) await sleep(100);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  const close = async () => {
    if (closing) return;
    closing = true;
    await writeStatus("stopping").catch(() => {});
    await stopChild().catch(() => {});
    await writeStatus("stopped").catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());

  await launch();
  while (!closing) {
    await sleep(POLL_MS);
    let progressMtimeMs = null;
    let progressMissing = false;
    if (!childExit && Date.now() - launchedAtMs > STARTUP_GRACE_MS) {
      try {
        const info = await stat(config.progressPath);
        progressMtimeMs = info.mtimeMs;
      } catch (error) {
        if (error?.code === "ENOENT") progressMissing = true;
        else throw error;
      }
    }
    const failure = publisherFailure({ nowMs: Date.now(), launchedAtMs, childExit, progressMtimeMs, progressMissing });
    if (!failure) {
      await writeStatus("running");
      continue;
    }
    lastFailure = failure.slice(0, 240);
    await writeStatus("restarting");
    await stopChild();
    if (restartCount >= MAX_RESTARTS) {
      await writeStatus("failed");
      throw new Error(`synthetic publisher exhausted ${MAX_RESTARTS} restarts: ${lastFailure}`);
    }
    restartCount += 1;
    lastRestartAt = new Date().toISOString();
    await sleep(1_000);
    await launch();
  }
}

function parseArgs(args) {
  const result = { marker: null, config: null };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (["--marker", "--config"].includes(value)) result[value.slice(2)] = args[++index];
    else throw new Error(`unsupported synthetic publisher worker option ${value}`);
  }
  if (!result.marker || !result.config) throw new Error("synthetic publisher worker arguments are incomplete");
  if (!canonicalAbsolutePath(result.config)) throw new Error("synthetic publisher worker configuration path is invalid");
  return result;
}

function validateConfig(value, marker) {
  const identity = /^scorecheck-rehearsal-[a-zA-Z0-9-]{8,80}-camera-([1-8])$/.exec(marker);
  if (value?.schemaVersion !== 1 || value.marker !== marker || !/^scorecheck-rehearsal-[a-zA-Z0-9-]{8,80}-camera-[1-8]$/.test(marker)
    || !Number.isInteger(value.court) || value.court < 1 || value.court > 8
    || Number(identity?.[1]) !== value.court
    || typeof value.ffmpegPath !== "string" || !Array.isArray(value.ffmpegArgs)
    || !value.ffmpegArgs.includes(`comment=${marker}`)
    || ![value.progressPath, value.logPath, value.statusPath].every(canonicalAbsolutePath)) {
    throw new Error("synthetic publisher worker configuration is invalid");
  }
}

function canonicalAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.includes("..") && !/[\r\n\0]/.test(value) && resolve(value) === value;
}

function publisherFailure({ nowMs, launchedAtMs, childExit, progressMtimeMs, progressMissing }) {
  if (childExit) return `FFmpeg exited code=${childExit.code ?? "null"} signal=${childExit.signal ?? "null"}${childExit.error ? ` error=${childExit.error}` : ""}`;
  if (nowMs - launchedAtMs <= STARTUP_GRACE_MS) return null;
  if (progressMissing) return "FFmpeg progress missing after startup grace";
  if (!Number.isFinite(progressMtimeMs)) return "FFmpeg progress timestamp is invalid";
  const ageMs = nowMs - progressMtimeMs;
  return ageMs > STALE_PROGRESS_MS ? `FFmpeg progress stale for ${Math.round(ageMs)}ms` : null;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`synthetic publisher supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, publisherFailure, validateConfig };
