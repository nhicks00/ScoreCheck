#!/usr/bin/env node

import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const HEADER = "sampled_at,ingest_cpu_ratio,ingest_zombies,compositor_cpu_ratio,compositor_zombies,egress_shm_ratio,sample_ok\n";
const REMOTE_SAMPLE = String.raw`set -eu
role="$1"
cpu_before=$(awk '/^cpu / { idle=$5+$6; total=0; for (i=2; i<=NF; i++) total+=$i; print total, idle; exit }' /proc/stat)
sleep 1
cpu_after=$(awk '/^cpu / { idle=$5+$6; total=0; for (i=2; i<=NF; i++) total+=$i; print total, idle; exit }' /proc/stat)
cpu_ratio=$(awk -v before="$cpu_before" -v after="$cpu_after" 'BEGIN {
  split(before, a, " "); split(after, b, " "); total=b[1]-a[1]; idle=b[2]-a[2];
  if (total <= 0) exit 1;
  printf "%.6f", 1-(idle/total)
}')
zombies=$(ps -eo stat= | awk '$1 ~ /^Z/ { count++ } END { print count+0 }')
shm_ratio=0
if [ "$role" = compositor ]; then
  shm_ratio=$(docker exec bvm-egress df -Pk /dev/shm | awk 'NR==2 && $2>0 { printf "%.6f", $3/$2; found=1 } END { if (!found) exit 1 }')
fi
printf '%s,%s,%s\n' "$cpu_ratio" "$zombies" "$shm_ratio"`;

export function parseRemoteSample(text) {
  const fields = text.trim().split(",");
  if (fields.length !== 3) throw new Error("remote sample did not contain three fields");
  const cpuRatio = Number(fields[0]);
  const zombies = Number(fields[1]);
  const shmRatio = Number(fields[2]);
  if (!Number.isFinite(cpuRatio) || cpuRatio < 0 || cpuRatio > 1) throw new Error("remote CPU ratio is invalid");
  if (!Number.isInteger(zombies) || zombies < 0) throw new Error("remote zombie count is invalid");
  if (!Number.isFinite(shmRatio) || shmRatio < 0 || shmRatio > 1) throw new Error("remote shared-memory ratio is invalid");
  return { cpuRatio, zombies, shmRatio };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument near ${key ?? "end of command"}`);
    values[key.slice(2)] = value;
  }
  for (const required of ["ingest-host", "compositor-host", "ssh-key", "interval-seconds", "output"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  for (const name of ["ingest-host", "compositor-host"]) {
    if (!/^[a-zA-Z0-9_.@:-]{1,253}$/.test(values[name])) throw new Error(`--${name} is invalid`);
  }
  const intervalSeconds = Number(values["interval-seconds"]);
  const durationSeconds = values["duration-seconds"] == null ? 0 : Number(values["duration-seconds"]);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 2 || intervalSeconds > 60) throw new Error("--interval-seconds must be from 2 through 60");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error("--duration-seconds must be non-negative");
  return {
    ingestHost: values["ingest-host"],
    compositorHost: values["compositor-host"],
    sshKey: expandHome(values["ssh-key"]),
    intervalSeconds,
    durationSeconds,
    output: path.resolve(expandHome(values.output))
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = await open(args.output, "wx", 0o600);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await file.write(HEADER);

  const startedAt = Date.now();
  let nextSampleAt = startedAt;
  let samples = 0;
  try {
    while (!stopping && (args.durationSeconds === 0 || Date.now() - startedAt <= args.durationSeconds * 1_000)) {
      const waitMs = nextSampleAt - Date.now();
      if (waitMs > 0) await delay(waitMs);
      if (stopping) break;

      const [ingest, compositor] = await Promise.allSettled([
        sampleRemote(args.ingestHost, "ingest", args),
        sampleRemote(args.compositorHost, "compositor", args)
      ]);
      const sampledAt = new Date().toISOString();
      const ok = ingest.status === "fulfilled" && compositor.status === "fulfilled";
      const row = ok
        ? [sampledAt, ingest.value.cpuRatio, ingest.value.zombies, compositor.value.cpuRatio, compositor.value.zombies, compositor.value.shmRatio, 1]
        : [sampledAt, "", "", "", "", "", 0];
      await file.write(`${row.join(",")}\n`);
      await file.sync();
      samples += 1;
      if (samples % 12 === 0) process.stderr.write(`host_sampler_progress=${sampledAt} samples=${samples}\n`);
      nextSampleAt += args.intervalSeconds * 1_000;
      if (Date.now() > nextSampleAt) {
        const missedSlots = Math.floor((Date.now() - nextSampleAt) / (args.intervalSeconds * 1_000)) + 1;
        nextSampleAt += missedSlots * args.intervalSeconds * 1_000;
      }
    }
  } finally {
    await file.close();
  }
}

async function sampleRemote(host, role, args) {
  const timeoutMs = Math.max(2_500, Math.floor(args.intervalSeconds * 800));
  const output = await run("ssh", [
    "-i", args.sshKey,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=3",
    "-o", "ServerAliveInterval=2",
    "-o", "ServerAliveCountMax=1",
    host,
    "sh", "-c", `${shellQuote(REMOTE_SAMPLE)} sh ${role}`
  ], timeoutMs);
  return parseRemoteSample(output);
}

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} sample timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} sample failed with exit ${code}: ${stderr.trim().slice(0, 160)}`));
    });
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
