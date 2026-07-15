#!/usr/bin/env node

import { open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseZombieEventLine } from "./zombie-evidence.mjs";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const HEADER = "sampled_at,ingest_cpu_ratio,ingest_sample_lag_ms,compositor_cpu_ratio,compositor_sample_lag_ms,egress_shm_ratio,sample_ok\n";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument near ${key ?? "end of command"}`);
    values[key.slice(2)] = value;
  }
  for (const required of ["ingest-host", "compositor-host", "ssh-key", "known-hosts", "interval-seconds", "output", "process-output"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  for (const name of ["ingest-host", "compositor-host"]) {
    if (!/^[a-zA-Z0-9_.@:-]{1,253}$/.test(values[name])) throw new Error(`--${name} is invalid`);
  }
  const intervalSeconds = Number(values["interval-seconds"]);
  const durationSeconds = values["duration-seconds"] == null ? 0 : Number(values["duration-seconds"]);
  const processPollMs = values["process-poll-ms"] == null ? 50 : Number(values["process-poll-ms"]);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 60) throw new Error("--interval-seconds must be an integer from 5 through 60");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error("--duration-seconds must be non-negative");
  if (!Number.isInteger(processPollMs) || processPollMs < 25 || processPollMs > 250) throw new Error("--process-poll-ms must be from 25 through 250");
  const output = path.resolve(expandHome(values.output));
  const processOutput = path.resolve(expandHome(values["process-output"]));
  if (output === processOutput) throw new Error("--output and --process-output must be different files");
  return {
    ingestHost: values["ingest-host"],
    compositorHost: values["compositor-host"],
    sshKey: expandHome(values["ssh-key"]),
    knownHosts: expandHome(values["known-hosts"]),
    intervalSeconds,
    durationSeconds,
    processPollMs,
    output,
    processOutput
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = await open(args.output, "wx", 0o600);
  let processFile;
  try {
    processFile = await open(args.processOutput, "wx", 0o600);
  } catch (error) {
    await file.close();
    throw error;
  }

  await file.write(HEADER);
  const watcherScript = await readFile(path.join(DIRECTORY, "watch-zombies.py"), "utf8");
  let processWrite = Promise.resolve();
  let hostWrite = Promise.resolve();
  const hostSlots = new Map();
  let lastHostSlotMs = -Infinity;
  let hostSamples = 0;
  const writeProcessEvent = (event) => {
    const { observedAtMs: _observedAtMs, sampleSlotAtMs: _sampleSlotAtMs, ...persisted } = event;
    processWrite = processWrite.then(async () => {
      await processFile.write(`${JSON.stringify(persisted)}\n`);
      if (event.event === "host_sample") await processFile.sync();
    });
    if (event.event === "host_sample") recordHostSample(event);
  };
  const recordHostSample = (event) => {
    if (event.sampleSlotAtMs <= lastHostSlotMs) throw new Error(`${event.role} host sample arrived after its slot was sealed`);
    const slot = hostSlots.get(event.sampleSlotAtMs) ?? {};
    if (slot[event.role]) throw new Error(`duplicate ${event.role} host sample for ${event.sampleSlotAt}`);
    slot[event.role] = event;
    hostSlots.set(event.sampleSlotAtMs, slot);
    flushHostSlots(event.sampleSlotAtMs, false);
  };
  const flushHostSlots = (throughMs, final) => {
    for (const slotMs of [...hostSlots.keys()].sort((left, right) => left - right)) {
      if (slotMs > throughMs) break;
      const slot = hostSlots.get(slotMs);
      if (!final && slotMs === throughMs && (!slot.ingest || !slot.compositor)) continue;
      const ingest = slot.ingest;
      const compositor = slot.compositor;
      const ok = Boolean(ingest?.sampleOk && compositor?.sampleOk);
      const row = ok
        ? [new Date(slotMs).toISOString(), ingest.cpuRatio, ingest.sampleLagMs, compositor.cpuRatio, compositor.sampleLagMs, compositor.shmRatio, 1]
        : [new Date(slotMs).toISOString(), "", ingest?.sampleLagMs ?? "", "", compositor?.sampleLagMs ?? "", "", 0];
      hostWrite = hostWrite.then(async () => {
        await file.write(`${row.join(",")}\n`);
        await file.sync();
      });
      hostSlots.delete(slotMs);
      lastHostSlotMs = slotMs;
      hostSamples += 1;
    }
  };

  let stopping = false;
  const watchers = [];
  const stop = () => {
    stopping = true;
    for (const watcher of watchers) watcher.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let watcherFailureResolved = false;
  let resolveWatcherFailure;
  const watcherFailureSignal = new Promise((resolve) => { resolveWatcherFailure = resolve; });
  const reportWatcherFailure = (error) => {
    if (watcherFailureResolved) return;
    watcherFailureResolved = true;
    resolveWatcherFailure(error);
  };
  watchers.push(
    startZombieWatcher(args.ingestHost, "ingest", args, watcherScript, writeProcessEvent, reportWatcherFailure),
    startZombieWatcher(args.compositorHost, "compositor", args, watcherScript, writeProcessEvent, reportWatcherFailure)
  );

  const startedAt = Date.now();
  let nextProgressAt = startedAt + 60_000;
  let caughtError = null;
  try {
    await Promise.race([
      Promise.all(watchers.map((watcher) => watcher.started)),
      watcherFailureSignal.then((error) => { throw error; }),
      delay(10_000).then(() => { throw new Error("host watcher startup timed out"); })
    ]);
    while (!stopping && (args.durationSeconds === 0 || Date.now() - startedAt < args.durationSeconds * 1_000)) {
      const remainingMs = args.durationSeconds === 0
        ? 250
        : Math.min(250, Math.max(0, (args.durationSeconds * 1_000) - (Date.now() - startedAt)));
      await delay(remainingMs);
      const watcherFailure = watchers.find((watcher) => watcher.failure)?.failure;
      if (watcherFailure) throw watcherFailure;
      if (Date.now() >= nextProgressAt) {
        process.stderr.write(`host_sampler_progress=${new Date().toISOString()} samples=${hostSamples}\n`);
        nextProgressAt += 60_000;
      }
    }
  } catch (error) {
    caughtError = error;
  } finally {
    for (const watcher of watchers) watcher.stop();
    await Promise.allSettled(watchers.map((watcher) => watcher.closed));
    await processWrite;
    flushHostSlots(Infinity, true);
    await hostWrite;
    await file.close();
    await processFile.close();
  }
  if (caughtError) throw caughtError;
}

export function startZombieWatcher(host, role, args, script, onEvent, onFailure) {
  const child = spawn("ssh", [
    "-i", args.sshKey,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${args.knownHosts}`,
    "-o", "ConnectTimeout=3",
    "-o", "ServerAliveInterval=2",
    "-o", "ServerAliveCountMax=1",
    host,
    "python3", "-", "--role", role,
    "--poll-ms", String(args.processPollMs),
    "--sample-interval-seconds", String(args.intervalSeconds)
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let failure = null;
  let intentionalStop = false;
  let sawStarted = false;
  let forceKillTimer = null;
  let resolveStarted;
  let rejectStarted;
  let resolveClosed;
  const started = new Promise((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  const fail = (error) => {
    if (failure) return;
    failure = error;
    onFailure(error);
    rejectStarted(error);
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }, 1_000);
    forceKillTimer.unref();
  };
  const consumeLine = (line) => {
    if (line.trim() === "") return;
    try {
      const event = parseZombieEventLine(line);
      if (event.role !== role) throw new Error(`host watcher emitted wrong role ${event.role}`);
      onEvent(event);
      if (event.event === "zombie_open" && event.classification === "unclassified" && !event.initialObservation) {
        fail(new Error(`${role} observed a new unclassified zombie pid=${event.pid} command=${event.command} parent=${event.parentCommand ?? "unknown"}`));
        return;
      }
      if (event.event === "watcher_started" && !sawStarted) {
        sawStarted = true;
        resolveStarted();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("host watcher emitted invalid evidence"));
    }
  };

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf("\n")) >= 0) {
      consumeLine(stdout.slice(0, newline));
      stdout = stdout.slice(newline + 1);
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  child.once("error", (error) => fail(error));
  child.once("close", (code) => {
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (stdout.trim()) consumeLine(stdout);
    if (!sawStarted && !failure) fail(new Error(`${role} host watcher exited before startup`));
    if (!intentionalStop && !failure) fail(new Error(`${role} host watcher exited unexpectedly with ${code}: ${stderr.trim().slice(0, 160)}`));
    resolveClosed();
  });
  child.stdin.end(script);

  return {
    started,
    closed,
    get failure() { return failure; },
    stop() {
      intentionalStop = true;
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
    }
  };
}

function expandHome(value) {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`host sampler error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
