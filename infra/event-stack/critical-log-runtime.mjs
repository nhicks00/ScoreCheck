import { spawn } from "node:child_process";
import { access, chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const HEARTBEAT_MS = 60_000;
const MAX_GAP_MS = 75_000;

export class CriticalLogRuntime {
  constructor({ repoRoot, sshKey, knownHosts, nodePath = process.execPath, spawnImpl = spawn, runner = runCommand, killImpl = process.kill, sleep = delay }) {
    this.repoRoot = requiredPath(repoRoot, "repository root");
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.nodePath = requiredPath(nodePath, "Node executable");
    this.spawnImpl = spawnImpl;
    this.runner = runner;
    this.killImpl = killImpl;
    this.sleep = sleep;
    this.scriptPath = resolve(this.repoRoot, "infra/event-stack/critical-log-export.mjs");
  }

  async ensure({ manifest, lifecycleState, evidenceDirectory }) {
    const output = resolve(evidenceDirectory, "critical-logs.jsonl");
    const logPath = resolve(evidenceDirectory, "critical-log-export.log");
    const existing = await this.inspect(output);
    if (existing) return { status: "running", ...existing, output, logPath, adopted: true, expectedHosts: criticalLogHosts(manifest, lifecycleState).map((entry) => entry.name) };
    if (await exists(output)) throw new Error("critical-log evidence exists without its owning process; start a new production generation");
    const hosts = criticalLogHosts(manifest, lifecycleState);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const args = [
      this.scriptPath,
      "--event", manifest.event,
      "--output", output,
      "--ssh-key", this.sshKey,
      "--known-hosts", this.knownHosts,
      ...hosts.flatMap((host) => ["--host", `${host.name},${host.role},${host.target}`])
    ];
    const log = await open(logPath, "a", 0o600);
    let child;
    try {
      child = this.spawnImpl(this.nodePath, args, { detached: true, stdio: ["ignore", log.fd, log.fd] });
      if (!Number.isInteger(child.pid) || child.pid < 2 || typeof child.unref !== "function") throw new Error("critical-log exporter did not return a detachable process");
      child.unref();
    } finally {
      await log.close();
    }
    await this.sleep(1_000);
    const observed = await this.inspect(output);
    if (!observed || observed.pid !== child.pid || !(await exists(output))) throw new Error("critical-log exporter did not remain running or produce evidence");
    const expectedHosts = hosts.map((entry) => entry.name).sort();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const rows = await readRows(output);
      const ready = [...new Set(rows.filter((row) => row.type === "stream_ready").map((row) => row.host))].sort();
      if (JSON.stringify(ready) === JSON.stringify(expectedHosts)) {
        await chmod(output, 0o600);
        return { status: "running", ...observed, output, logPath, adopted: false, expectedHosts, startedAt: new Date().toISOString() };
      }
      if (rows.some((row) => row.type === "collector_error") || !(await this.inspect(output))) break;
      await this.sleep(250);
    }
    try { this.killImpl(-child.pid, "SIGTERM"); } catch {}
    throw new Error("critical-log exporter did not establish every host stream within 15 seconds");
  }

  async inspect(output) {
    const normalized = requiredPath(output, "critical-log output");
    const result = await this.runner("ps", ["-axo", "pid=,command="]);
    const matches = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.includes(this.scriptPath) && line.includes(`--output ${normalized}`));
    if (matches.length > 1) throw new Error("multiple critical-log exporters own the same evidence path");
    if (!matches.length) return null;
    const match = /^(\d+)\s+/u.exec(matches[0]);
    if (!match) throw new Error("critical-log exporter process inventory is invalid");
    return { pid: Number(match[1]) };
  }

  async stop(state) {
    if (!state?.output) throw new Error("critical-log exporter state is invalid");
    let current = await this.inspect(state.output);
    if (!current) return { ...state, status: "stopped", stoppedAt: new Date().toISOString() };
    this.killImpl(-current.pid, "SIGTERM");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await this.sleep(100);
      current = await this.inspect(state.output);
      if (!current) return { ...state, status: "stopped", stoppedAt: new Date().toISOString() };
    }
    this.killImpl(-current.pid, "SIGKILL");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.sleep(100);
      if (!(await this.inspect(state.output))) return { ...state, status: "stopped", stoppedAt: new Date().toISOString(), forced: true };
    }
    throw new Error("critical-log exporter did not stop");
  }
}

export async function evaluateCriticalLogEvidence({ path, event, expectedHosts, startMs, endMs }) {
  const rows = await readRows(requiredPath(path, "critical-log evidence"));
  const eventRows = rows.filter((row) => row.event === event);
  const heartbeats = eventRows.filter((row) => row.type === "heartbeat" && Date.parse(row.observedAt) >= startMs && Date.parse(row.observedAt) <= endMs);
  const expected = [...expectedHosts].sort();
  const ready = [...new Set(eventRows.filter((row) => row.type === "stream_ready").map((row) => row.host))].sort();
  const problems = [];
  if (JSON.stringify(ready) !== JSON.stringify(expected)) problems.push("critical-log exporter did not establish every host stream");
  if (eventRows.some((row) => row.type === "collector_error")) problems.push("critical-log exporter recorded a stream failure");
  if (!eventRows.some((row) => row.type === "collector_started")) problems.push("critical-log exporter start evidence is missing");
  if (!eventRows.some((row) => row.type === "collector_stopped")) problems.push("critical-log exporter stop evidence is missing");
  if (!heartbeats.length) problems.push("critical-log exporter produced no in-window heartbeat evidence");
  let maximumGapMs = 0;
  for (let index = 1; index < heartbeats.length; index += 1) {
    const gapMs = Date.parse(heartbeats[index].observedAt) - Date.parse(heartbeats[index - 1].observedAt);
    if (gapMs <= 0) problems.push("critical-log exporter heartbeat timestamps are not strictly increasing");
    maximumGapMs = Math.max(maximumGapMs, gapMs);
  }
  if (heartbeats.length && Date.parse(heartbeats[0].observedAt) - startMs > MAX_GAP_MS) problems.push("critical-log exporter heartbeat started too late");
  if (heartbeats.length && endMs - Date.parse(heartbeats.at(-1).observedAt) > MAX_GAP_MS) problems.push("critical-log exporter heartbeat ended too early");
  if (maximumGapMs > MAX_GAP_MS) problems.push(`critical-log exporter maximum heartbeat gap was ${maximumGapMs}ms`);
  if (heartbeats.some((row) => row.schemaVersion !== 1 || row.expectedHosts !== expected.length || !Array.isArray(row.readyHosts) || JSON.stringify([...row.readyHosts].sort()) !== JSON.stringify(expected))) problems.push("critical-log exporter heartbeat is incomplete or malformed");
  const expectedHeartbeats = Math.max(1, Math.floor((endMs - startMs) / HEARTBEAT_MS));
  const coverageRatio = heartbeats.length / expectedHeartbeats;
  if (coverageRatio < 0.95) problems.push("critical-log exporter heartbeat coverage was below 95%");
  return {
    passed: problems.length === 0,
    expectedHosts: expected.length,
    readyHosts: ready.length,
    heartbeats: heartbeats.length,
    expectedHeartbeats,
    coverageRatio,
    maximumGapMs,
    criticalRecords: eventRows.filter((row) => row.type === "critical_log").length,
    problems
  };
}

export function criticalLogHosts(manifest, lifecycleState) {
  if (!manifest || !Array.isArray(manifest.droplets) || manifest.droplets.length !== 12) throw new Error("critical-log exporter requires the exact twelve-host manifest");
  return [...manifest.droplets].sort((left, right) => left.name.localeCompare(right.name)).map((spec) => {
    const ip = lifecycleState?.droplets?.[spec.name]?.publicIpv4;
    if (typeof ip !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(ip)) throw new Error(`critical-log exporter has no public IPv4 for ${spec.name}`);
    return { name: spec.name, role: spec.role, target: `root@${ip}` };
  });
}

async function readRows(path) {
  if (!(await exists(path))) return [];
  return (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return resolve(value);
}

async function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${command} failed with exit ${code}`)));
  });
}
