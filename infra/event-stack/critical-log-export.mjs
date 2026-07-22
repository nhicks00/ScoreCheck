#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HEARTBEAT_MS = 60_000;
const READY_MARKER = "__SCORECHECK_LOG_STREAM_READY__";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CRITICAL_PATTERN = /\b(?:error|warning|warn|fatal|panic|crash(?:ed)?|fail(?:ed|ure)?|timeout|stall(?:ed)?|disconnect(?:ed)?|reconnect(?:ed)?|restart(?:ed)?|oom|publisher|publishing|reader|whep|egress|chrom(?:e|ium)|normaliz(?:e|er|ing)|admission|failover|takeover|youtube|started|stopped|created|destroyed)\b/iu;

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  const handle = await open(options.output, "a", 0o600);
  await chmod(options.output, 0o600);
  let writeQueue = Promise.resolve();
  const append = (row) => {
    writeQueue = writeQueue.then(async () => {
      await handle.write(`${JSON.stringify(row)}\n`);
      await handle.sync();
    });
    return writeQueue;
  };
  const children = new Map();
  const ready = new Set();
  let stopping = false;
  let failed = false;
  let finish;
  const finished = new Promise((resolvePromise) => { finish = resolvePromise; });

  const stopChildren = () => {
    for (const child of children.values()) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const fail = async (host, reason) => {
    if (stopping) return;
    stopping = true;
    failed = true;
    await append(record(options, "collector_error", { host, reason: sanitizeCriticalLogLine(reason) }));
    stopChildren();
    finish();
  };

  for (const spec of options.hosts) {
    const remote = `cd ${roleDirectory(spec.role)} && docker compose config -q && printf '${READY_MARKER}\\n' && exec docker compose logs --follow --tail 0 --timestamps --no-color`;
    const child = spawn("ssh", [
      "-i", options.sshKey,
      "-o", `UserKnownHostsFile=${options.knownHosts}`,
      "-o", "StrictHostKeyChecking=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=2",
      spec.target,
      remote
    ], { stdio: ["ignore", "pipe", "pipe"] });
    children.set(spec.name, child);
    let stderr = "";
    const consumeLine = (line, stream) => {
      if (line === READY_MARKER) {
        if (!ready.has(spec.name)) {
          ready.add(spec.name);
          void append(record(options, "stream_ready", { host: spec.name, role: spec.role }));
        }
        return;
      }
      if (criticalLogLine(line)) void append(record(options, "critical_log", { host: spec.name, role: spec.role, stream, message: sanitizeCriticalLogLine(line) }));
    };
    readline.createInterface({ input: child.stdout }).on("line", (line) => consumeLine(line, "stdout"));
    readline.createInterface({ input: child.stderr }).on("line", (line) => consumeLine(line, "stderr"));
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000); });
    child.on("error", (error) => { void fail(spec.name, error.message); });
    child.on("close", (code, signal) => {
      if (!stopping) void fail(spec.name, `log stream exited with code ${code ?? "null"} signal ${signal ?? "none"}: ${stderr}`);
    });
  }

  const heartbeat = setInterval(() => {
    void append(record(options, "heartbeat", { readyHosts: [...ready].sort(), expectedHosts: options.hosts.length }));
  }, HEARTBEAT_MS);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopChildren();
    finish();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await append(record(options, "collector_started", { expectedHosts: options.hosts.length }));
  await finished;
  clearInterval(heartbeat);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await delay(250);
  if (!failed) await append(record(options, "collector_stopped", { readyHosts: [...ready].sort(), expectedHosts: options.hosts.length }));
  await writeQueue;
  await handle.close();
  if (failed) process.exitCode = 1;
}

export function criticalLogLine(line) {
  return typeof line === "string" && line.length > 0 && CRITICAL_PATTERN.test(line);
}

export function sanitizeCriticalLogLine(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_JWT]")
    .replace(/(rtmps?:\/\/[^\s/]+\/live2\/)[^\s?]+/giu, "$1[REDACTED]")
    .replace(/([?#&](?:token|jwt|key|secret|password|passphrase|signature|sig|auth)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/(["']?(?:token|jwt|secret|password|passphrase|api[_-]?key|stream[_-]?key|authorization)["']?\s*:\s*["'])[^"']+/giu, "$1[REDACTED]")
    .replace(/\b((?:PROGRAM_PAGE_TOKEN|MONITOR_API_TOKEN|LIVEKIT_API_SECRET|PUSHOVER_APP_TOKEN|PUSHOVER_USER_KEY|SUPABASE_SERVICE_ROLE_KEY|YOUTUBE_(?:KEY|STREAM_KEY))\s*[=:]\s*)\S+/giu, "$1[REDACTED]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|STREAM_KEY|YOUTUBE_KEY)\s*[=:]\s*)\S+/gu, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .slice(0, 1_000);
}

export function roleDirectory(role) {
  if (role === "ingest") return "/opt/mediamtx";
  if (role === "commentary") return "/opt/livekit";
  if (role === "observability") return "/opt/scorecheck-monitoring";
  if (["compositor", "compositor-spare"].includes(role)) return "/opt/compositor";
  throw new Error(`unsupported critical-log host role ${role}`);
}

function record(options, type, values) {
  return { schemaVersion: 1, event: options.event, observedAt: new Date().toISOString(), type, ...values };
}

function parseArgs(args) {
  const values = new Map();
  const hosts = [];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("critical-log arguments must be --name value pairs");
    if (key === "--host") hosts.push(parseHost(value));
    else if (values.has(key)) throw new Error(`duplicate critical-log argument ${key}`);
    else values.set(key, value);
  }
  const event = values.get("--event");
  if (typeof event !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(event)) throw new Error("critical-log event is invalid");
  if (!hosts.length || new Set(hosts.map((entry) => entry.name)).size !== hosts.length) throw new Error("critical-log hosts must be present and unique");
  return {
    event,
    output: requiredPath(values.get("--output"), "critical-log output"),
    sshKey: requiredPath(values.get("--ssh-key"), "critical-log SSH key"),
    knownHosts: requiredPath(values.get("--known-hosts"), "critical-log known_hosts"),
    hosts
  };
}

function parseHost(value) {
  const match = /^([a-z0-9][a-z0-9-]{2,63}),(ingest|commentary|observability|compositor|compositor-spare),(root@(?:\d{1,3}\.){3}\d{1,3})$/u.exec(value ?? "");
  if (!match) throw new Error("critical-log host must be name,role,root@IPv4");
  return { name: match[1], role: match[2], target: match[3] };
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return resolve(value);
}
