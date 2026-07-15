#!/usr/bin/env node

import { open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startZombieWatcher } from "./sample-hosts.mjs";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const HOST_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const SSH_HOST = /^[a-zA-Z0-9_.@:-]{1,253}$/;

export function parsePoolSamplerArgs(argv) {
  const hosts = [];
  const values = {};
  for (let index = 0; index < argv.length;) {
    const key = argv[index++];
    const value = argv[index++];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument near ${key ?? "end of command"}`);
    if (key === "--host") hosts.push(parseHost(value));
    else {
      if (values[key]) throw new Error(`${key} may be provided only once`);
      values[key] = value;
    }
  }
  for (const required of ["--ssh-key", "--interval-seconds", "--output"]) {
    if (!values[required]) throw new Error(`${required} is required`);
  }
  if (hosts.length !== 10) throw new Error("--host must be provided exactly ten times: one ingest and nine compositors, including the warm spare");
  if (hosts.filter((host) => host.role === "ingest").length !== 1 || hosts.filter((host) => host.role === "compositor").length !== 9) {
    throw new Error("pool sampling requires exactly one ingest host and nine compositor hosts, including the warm spare");
  }
  if (new Set(hosts.map((host) => host.hostId)).size !== hosts.length) throw new Error("pool host IDs must be unique");
  if (new Set(hosts.map((host) => host.sshHost)).size !== hosts.length) throw new Error("pool SSH hosts must be unique");
  const intervalSeconds = Number(values["--interval-seconds"]);
  const durationSeconds = values["--duration-seconds"] == null ? 0 : Number(values["--duration-seconds"]);
  const processPollMs = values["--process-poll-ms"] == null ? 50 : Number(values["--process-poll-ms"]);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 60) throw new Error("--interval-seconds must be an integer from 5 through 60");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error("--duration-seconds must be non-negative");
  if (!Number.isInteger(processPollMs) || processPollMs < 25 || processPollMs > 250) throw new Error("--process-poll-ms must be from 25 through 250");
  return {
    hosts,
    sshKey: expandHome(values["--ssh-key"]),
    intervalSeconds,
    durationSeconds,
    processPollMs,
    output: path.resolve(expandHome(values["--output"]))
  };
}

function parseHost(value) {
  const fields = String(value).split(",");
  if (fields.length !== 3) throw new Error("--host must use HOST_ID,ROLE,SSH_HOST");
  const [hostId, role, sshHost] = fields;
  if (!HOST_ID.test(hostId)) throw new Error("--host HOST_ID is invalid");
  if (!new Set(["ingest", "compositor"]).has(role)) throw new Error("--host ROLE must be ingest or compositor");
  if (!SSH_HOST.test(sshHost)) throw new Error("--host SSH_HOST is invalid");
  return { hostId, role, sshHost };
}

async function main() {
  const args = parsePoolSamplerArgs(process.argv.slice(2));
  const file = await open(args.output, "wx", 0o600);
  const watcherScript = await readFile(path.join(DIRECTORY, "watch-zombies.py"), "utf8");
  let writeChain = Promise.resolve();
  let hostSamples = 0;
  const writeEvent = (hostId, event) => {
    const { observedAtMs: _observedAtMs, sampleSlotAtMs: _sampleSlotAtMs, ...persisted } = event;
    writeChain = writeChain.then(async () => {
      await file.write(`${JSON.stringify({ ...persisted, hostId })}\n`);
      if (event.event === "host_sample" || event.event === "zombie_open") await file.sync();
    });
    if (event.event === "host_sample") hostSamples += 1;
  };

  let stopping = false;
  const watchers = [];
  const stop = () => {
    stopping = true;
    for (const watcher of watchers) watcher.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let failureResolved = false;
  let resolveFailure;
  const failureSignal = new Promise((resolve) => { resolveFailure = resolve; });
  const reportFailure = (error) => {
    if (failureResolved) return;
    failureResolved = true;
    resolveFailure(error);
  };
  for (const host of args.hosts) {
    watchers.push(startZombieWatcher(
      host.sshHost,
      host.role,
      args,
      watcherScript,
      (event) => writeEvent(host.hostId, event),
      reportFailure
    ));
  }

  const startedAt = Date.now();
  let nextProgressAt = startedAt + 60_000;
  let caughtError = null;
  try {
    await Promise.race([
      Promise.all(watchers.map((watcher) => watcher.started)),
      failureSignal.then((error) => { throw error; }),
      startupTimeout(15_000)
    ]);
    while (!stopping && (args.durationSeconds === 0 || Date.now() - startedAt < args.durationSeconds * 1_000)) {
      const remainingMs = args.durationSeconds === 0
        ? 250
        : Math.min(250, Math.max(0, (args.durationSeconds * 1_000) - (Date.now() - startedAt)));
      await delay(remainingMs);
      const failure = watchers.find((watcher) => watcher.failure)?.failure;
      if (failure) throw failure;
      if (Date.now() >= nextProgressAt) {
        process.stderr.write(`pool_host_sampler_progress=${new Date().toISOString()} samples=${hostSamples}\n`);
        nextProgressAt += 60_000;
      }
    }
  } catch (error) {
    caughtError = error;
  } finally {
    for (const watcher of watchers) watcher.stop();
    await Promise.allSettled(watchers.map((watcher) => watcher.closed));
    await writeChain;
    await file.close();
  }
  if (caughtError) throw caughtError;
}

function expandHome(value) {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startupTimeout(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("pool host watcher startup timed out")), ms);
    timer.unref();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`pool host sampler error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
