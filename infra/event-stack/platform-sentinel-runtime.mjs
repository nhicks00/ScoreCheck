import { spawn } from "node:child_process";
import { access, chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const SENTINEL_INTERVAL_MS = 60_000;
const MAX_SENTINEL_GAP_MS = 75_000;

export class PlatformSentinelRuntime {
  constructor({ repoRoot, environment, nodePath = process.execPath, spawnImpl = spawn, runner = runCommand, killImpl = process.kill, sleep = delay }) {
    this.repoRoot = requiredPath(repoRoot, "repository root");
    this.environment = requiredPath(environment, "sentinel environment");
    this.nodePath = requiredPath(nodePath, "Node executable");
    this.spawnImpl = spawnImpl;
    this.runner = runner;
    this.killImpl = killImpl;
    this.sleep = sleep;
    this.scriptPath = resolve(this.repoRoot, "infra/event-stack/platform-sentinel.mjs");
  }

  async ensure({ manifest, renderer, evidenceDirectory }) {
    const output = resolve(evidenceDirectory, "platform-sentinel.jsonl");
    const logPath = resolve(evidenceDirectory, "platform-sentinel.log");
    const existing = await this.inspect(output);
    if (existing) return { status: "running", ...existing, output, logPath, adopted: true };
    if (await exists(output)) throw new Error("platform sentinel evidence exists without its owning process; start a new production generation");
    const endpoints = sentinelEndpoints(manifest, renderer);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const args = [
      this.scriptPath,
      "--event", manifest.event,
      "--environment", this.environment,
      "--output", output,
      "--monitor-url", endpoints.monitor,
      "--ingest-url", endpoints.ingest,
      "--commentary-url", endpoints.commentary,
      "--renderer-url", endpoints.renderer
    ];
    const log = await open(logPath, "a", 0o600);
    let child;
    try {
      child = this.spawnImpl(this.nodePath, args, { detached: true, stdio: ["ignore", log.fd, log.fd] });
      if (!Number.isInteger(child.pid) || child.pid < 2 || typeof child.unref !== "function") throw new Error("platform sentinel did not return a detachable process");
      child.unref();
    } finally {
      await log.close();
    }
    await this.sleep(1_000);
    const observed = await this.inspect(output);
    if (!observed || observed.pid !== child.pid || !(await exists(output))) throw new Error("platform sentinel did not remain running or produce evidence");
    await chmod(output, 0o600);
    return { status: "running", ...observed, output, logPath, adopted: false, startedAt: new Date().toISOString() };
  }

  async inspect(output) {
    const normalized = requiredPath(output, "sentinel output");
    const result = await this.runner("ps", ["-axo", "pid=,command="]);
    const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(this.scriptPath) && line.includes(`--output ${normalized}`));
    if (matches.length > 1) throw new Error("multiple platform sentinels own the same evidence path");
    if (!matches.length) return null;
    const match = /^(\d+)\s+/.exec(matches[0]);
    if (!match) throw new Error("platform sentinel process inventory is invalid");
    return { pid: Number(match[1]) };
  }

  async stop(state) {
    if (!state?.output) throw new Error("platform sentinel state is invalid");
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
    throw new Error("platform sentinel did not stop");
  }
}

export async function evaluatePlatformSentinelEvidence({ path, event, startMs, endMs }) {
  const rows = (await readFile(requiredPath(path, "sentinel evidence"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const samples = rows.filter((row) => row.event === event && Date.parse(row.observedAt) >= startMs && Date.parse(row.observedAt) <= endMs);
  const problems = [];
  if (!samples.length) problems.push("platform sentinel produced no in-window evidence");
  let maximumGapMs = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const gapMs = Date.parse(samples[index].observedAt) - Date.parse(samples[index - 1].observedAt);
    if (gapMs <= 0) problems.push("platform sentinel timestamps are not strictly increasing");
    maximumGapMs = Math.max(maximumGapMs, gapMs);
  }
  if (samples.length && Date.parse(samples[0].observedAt) - startMs > MAX_SENTINEL_GAP_MS) problems.push("platform sentinel started too late");
  if (samples.length && endMs - Date.parse(samples.at(-1).observedAt) > MAX_SENTINEL_GAP_MS) problems.push("platform sentinel ended too early");
  if (maximumGapMs > MAX_SENTINEL_GAP_MS) problems.push(`platform sentinel maximum gap was ${maximumGapMs}ms`);
  if (samples.some((sample) => sample.schemaVersion !== 1 || sample.passed !== true || sample.healthchecksDelivery?.ok !== true || sample.endpoints?.length !== 4)) problems.push("platform sentinel recorded a failed or malformed sample");
  const expected = Math.max(1, Math.floor((endMs - startMs) / SENTINEL_INTERVAL_MS));
  const coverageRatio = samples.length / expected;
  if (coverageRatio < 0.95) problems.push("platform sentinel sample coverage was below 95%");
  return { passed: problems.length === 0, samples: samples.length, expected, coverageRatio, maximumGapMs, problems };
}

export function sentinelEndpoints(manifest, renderer) {
  const endpoint = (role) => manifest?.endpoints?.find((entry) => entry.role === role)?.hostname;
  const monitor = endpoint("observability");
  const ingest = endpoint("ingest");
  const commentary = manifest?.endpoints?.find((entry) => entry.role === "commentary" && entry.hostname.startsWith("rtc."))?.hostname;
  if (![monitor, ingest, commentary].every((value) => typeof value === "string" && value.includes("."))) throw new Error("platform sentinel manifest endpoints are incomplete");
  let origin;
  try { origin = new URL(renderer?.origin); } catch { throw new Error("platform sentinel renderer origin is invalid"); }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("platform sentinel renderer origin must be an immutable HTTPS origin");
  return {
    monitor: `https://${monitor}/healthz`,
    ingest: `https://${ingest}/healthz`,
    commentary: `https://${commentary}/`,
    renderer: new URL("/api/health", origin).toString()
  };
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
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
