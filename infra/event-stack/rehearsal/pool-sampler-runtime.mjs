import { spawn } from "node:child_process";
import { access, chmod, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class PoolSamplerRuntime {
  constructor({ repoRoot, sshKey, knownHosts, nodePath = process.execPath, spawnImpl = spawn, runner = runCommand, killImpl = process.kill, sleep = delay }) {
    this.repoRoot = requiredPath(repoRoot, "repository root");
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.nodePath = requiredPath(nodePath, "Node executable");
    this.spawnImpl = spawnImpl;
    this.runner = runner;
    this.killImpl = killImpl;
    this.sleep = sleep;
    this.scriptPath = resolve(this.repoRoot, "infra/capacity/sample-host-pool.mjs");
  }

  async ensure({ manifest, lifecycleState, evidenceDirectory }) {
    const output = resolve(evidenceDirectory, "pool-host-samples.jsonl");
    const logPath = resolve(evidenceDirectory, "pool-host-sampler.log");
    const existing = await this.inspect(output);
    if (existing) return { status: "running", ...existing, output, logPath, adopted: true };
    if (await exists(output)) throw new Error("pool host sampler evidence exists without its owning process; start a new rehearsal generation");
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await chmod(dirname(output), 0o700);
    const args = [this.scriptPath, ...poolHostArguments(manifest, lifecycleState),
      "--ssh-key", this.sshKey,
      "--known-hosts", this.knownHosts,
      "--interval-seconds", "5",
      "--process-poll-ms", "50",
      "--output", output
    ];
    const log = await open(logPath, "a", 0o600);
    let child;
    try {
      child = this.spawnImpl(this.nodePath, args, { detached: true, stdio: ["ignore", log.fd, log.fd] });
      if (!Number.isInteger(child.pid) || child.pid < 2) throw new Error("pool host sampler did not return a process id");
      if (typeof child.unref !== "function") throw new Error("pool host sampler cannot be detached from the operator");
      child.unref();
    } finally {
      await log.close();
    }
    await this.sleep(2_000);
    const observed = await this.inspect(output);
    if (!observed || observed.pid !== child.pid) throw new Error("pool host sampler did not remain running");
    return { status: "running", ...observed, output, logPath, adopted: false, startedAt: new Date().toISOString() };
  }

  async inspect(output) {
    const normalized = requiredPath(output, "sampler output");
    const result = await this.runner("ps", ["-axo", "pid=,command="]);
    const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(this.scriptPath) && line.includes(`--output ${normalized}`));
    if (matches.length > 1) throw new Error("multiple pool host samplers own the same evidence path");
    if (!matches.length) return null;
    const match = /^(\d+)\s+/.exec(matches[0]);
    if (!match) throw new Error("pool host sampler process inventory is invalid");
    return { pid: Number(match[1]) };
  }

  async stop(state) {
    if (!state?.output) throw new Error("pool host sampler state is invalid");
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
    throw new Error("pool host sampler did not stop");
  }
}

export function poolHostArguments(manifest, lifecycleState) {
  const ingest = manifest.droplets.find((entry) => entry.role === "ingest");
  const compositors = manifest.droplets.filter((entry) => ["compositor", "compositor-spare"].includes(entry.role));
  if (!ingest || compositors.length !== 9) throw new Error("pool sampler requires one ingest and nine compositor hosts");
  const specs = [ingest, ...compositors.sort((left, right) => left.name.localeCompare(right.name))];
  return specs.flatMap((spec) => {
    const ip = lifecycleState.droplets?.[spec.name]?.publicIpv4;
    if (!ip) throw new Error(`pool sampler has no public IPv4 for ${spec.name}`);
    return ["--host", `${spec.providerName},${spec.role === "ingest" ? "ingest" : "compositor"},root@${ip}`];
  });
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
