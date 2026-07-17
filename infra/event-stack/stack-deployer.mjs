#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { collectReconstructionProvenance, sha256 as provenanceSha256 } from "./reconstruction-provenance.mjs";

const REQUIRED_DEPLOYMENT_SECRET_FILES = Object.freeze([
  "agent-tokens.json",
  "commentary.env",
  "ingest.env",
  "observability.env",
  ...["a", "b", "c", "d", "e", "f", "g", "h"].map((suffix) => `compositors/bvm-compositor-${suffix}.env`),
  "compositors/bvm-compositor-spare.env"
]);

export class LocalStackDeployer {
  constructor({ repoRoot, secretsDirectory, sshPrivateKey, knownHostsPath, runner = runCommand, fetchImpl = globalThis.fetch }) {
    this.repoRoot = resolve(repoRoot);
    this.secretsDirectory = protectedAbsolute(secretsDirectory, "secrets directory");
    this.sshPrivateKey = protectedAbsolute(sshPrivateKey, "SSH private key");
    this.knownHostsPath = protectedAbsolute(knownHostsPath, "event known_hosts path");
    this.runner = runner;
    this.fetchImpl = fetchImpl;
    this.agentConfig = null;
  }

  async deploy({ manifest, spec, resource, state }) {
    await this.#validateProtectedInputs();
    const hostKeySha256 = await this.#ensureSsh(resource.publicIpv4);
    const common = {
      SCORECHECK_SSH_KNOWN_HOSTS: this.knownHostsPath
    };
    if (spec.role === "commentary") {
      const env = await loadProtectedEnv(join(this.secretsDirectory, "commentary.env"));
      const commentaryHosts = commentaryEndpointHosts(manifest);
      await this.#script("infra/commentary/deploy.sh", {
        ...env,
        ...common,
        LIVEKIT_COMMENTARY_SSH_HOST: `root@${resource.publicIpv4}`,
        LIVEKIT_COMMENTARY_SSH_KEY: this.sshPrivateKey,
        LIVEKIT_COMMENTARY_PUBLIC_IP: servicePublicIpv4({ manifest, state, spec, resource }),
        LIVEKIT_COMMENTARY_RTC_HOST: commentaryHosts.rtc,
        LIVEKIT_COMMENTARY_TURN_HOST: commentaryHosts.turn
      });
    } else if (spec.role === "ingest") {
      const env = await loadProtectedEnv(join(this.secretsDirectory, "ingest.env"));
      const wireguardConfig = join(this.secretsDirectory, "wireguard/camera-lan.conf");
      if (await exists(wireguardConfig)) {
        await assertProtectedFile(wireguardConfig, "ingest WireGuard configuration");
        await this.#script("infra/mediamtx/deploy-wireguard.sh", {
          ...common,
          MEDIAMTX_SSH_HOST: `root@${resource.publicIpv4}`,
          MEDIAMTX_SSH_KEY: this.sshPrivateKey,
          MEDIAMTX_WIREGUARD_CONFIG: wireguardConfig
        });
      }
      await this.#script("infra/mediamtx/deploy.sh", {
        ...env,
        ...common,
        MEDIAMTX_SSH_HOST: `root@${resource.publicIpv4}`,
        MEDIAMTX_SSH_KEY: this.sshPrivateKey,
        MEDIAMTX_PUBLIC_IP: servicePublicIpv4({ manifest, state, spec, resource }),
        MEDIAMTX_PUBLIC_HOST: endpointForRole(manifest, "ingest"),
        MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify(compositorContentAnalyzerBindings({ manifest, state }))
      });
    } else if (["compositor", "compositor-spare"].includes(spec.role)) {
      const environmentPath = join(this.secretsDirectory, "compositors", `${spec.name}.env`);
      await assertProtectedFile(environmentPath, `${spec.name} environment`);
      await this.#script("infra/compositor/deploy.sh", {
        ...common,
        COMPOSITOR_SSH_HOST: `root@${resource.publicIpv4}`,
        COMPOSITOR_SSH_KEY: this.sshPrivateKey,
        COMPOSITOR_ENV_FILE: environmentPath
      });
    } else if (spec.role === "observability") {
      const env = await loadProtectedEnv(join(this.secretsDirectory, "observability.env"));
      const plans = await this.#agentPlans(manifest, state);
      await this.#script("infra/monitoring/deploy.sh", {
        ...env,
        ...common,
        MONITOR_SSH_HOST: `root@${resource.publicIpv4}`,
        MONITOR_SSH_KEY: this.sshPrivateKey,
        MONITOR_PUBLIC_HOST: endpointForRole(manifest, "observability"),
        MONITOR_AGENT_TARGETS: serializeAgentTargets(plans)
      });
    } else {
      throw new Error(`unsupported deployment role ${spec.role}`);
    }
    const revision = await gitRevision(this.repoRoot, this.runner);
    const expectedConfigHashes = await this.#expectedConfigHashes(spec, false);
    const reconstruction = await collectReconstructionProvenance({
      spec,
      resource,
      expectedConfigHashes,
      runRemote: (command) => this.#ssh(resource.publicIpv4, command)
    });
    return { healthy: true, revision, evidence: { hostKeySha256, reconstruction } };
  }

  async finalizeStack({ manifest, state }) {
    const plans = await this.#agentPlans(manifest, state);
    for (const plan of plans) {
      await this.#ensureSsh(plan.publicIpv4);
      await this.#script("infra/monitoring/deploy-agent.sh", {
        SCORECHECK_SSH_KNOWN_HOSTS: this.knownHostsPath,
        MONITOR_AGENT_SSH_HOST: `root@${plan.publicIpv4}`,
        MONITOR_AGENT_SSH_KEY: this.sshPrivateKey,
        ...plan.environment
      });
    }
    return { healthy: true, evidence: { deployedAgents: plans.map((entry) => entry.id) } };
  }

  async verifyStack({ manifest, state }) {
    const checks = [];
    for (const spec of manifest.droplets) {
      const resource = state.droplets[spec.name];
      await this.#ensureSsh(resource.publicIpv4);
      const command = verificationCommand(spec.role);
      await this.#ssh(resource.publicIpv4, command);
      const reconstruction = await collectReconstructionProvenance({
        spec,
        resource,
        expectedConfigHashes: await this.#expectedConfigHashes(spec, true),
        runRemote: (remoteCommand) => this.#ssh(resource.publicIpv4, remoteCommand)
      });
      checks.push({ name: spec.name, role: spec.role, status: "healthy", reconstruction });
    }
    for (const endpoint of manifest.endpoints.filter(publicHttpHealthEndpoint)) {
      const healthPath = ["ingest", "observability"].includes(endpoint.role) ? "/healthz" : "";
      const response = await this.fetchImpl(`https://${endpoint.hostname}${healthPath}`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "manual"
      });
      if (response.status < 200 || response.status >= 400) throw new Error(`${endpoint.hostname} public TLS health returned HTTP ${response.status}`);
    }
    return { healthy: true, evidence: { resources: checks, verifiedAt: new Date().toISOString() } };
  }

  async #agentPlans(manifest, state) {
    if (!this.agentConfig) {
      const path = join(this.secretsDirectory, "agent-tokens.json");
      await assertProtectedFile(path, "agent token configuration");
      this.agentConfig = JSON.parse(await readFile(path, "utf8"));
    }
    return buildAgentPlans({ manifest, state, tokenConfig: this.agentConfig });
  }

  async #validateProtectedInputs() {
    await assertProtectedFile(this.sshPrivateKey, "SSH private key");
    await verifyProtectedSecretDirectory(this.secretsDirectory);
    await mkdir(dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.knownHostsPath), 0o700);
  }

  async #expectedConfigHashes(spec, includeAgent) {
    const bindings = roleConfigBindings(this.repoRoot, this.secretsDirectory, spec);
    const wireguardConfig = join(this.secretsDirectory, "wireguard/camera-lan.conf");
    if (spec.role === "ingest" && await exists(wireguardConfig)) {
      bindings.push([wireguardConfig, "/etc/wireguard/camera-lan.conf"]);
    }
    if (includeAgent) bindings.push(
      [join(this.repoRoot, "infra/monitoring/agent-compose.yml"), "/opt/scorecheck-monitor-agent/agent-compose.yml"],
      [join(this.repoRoot, `infra/monitoring/.generated/agent-${spec.name}.env`), "/opt/scorecheck-monitor-agent/.env"]
    );
    const output = {};
    for (const [localPath, remotePath] of bindings) {
      const body = await readFile(localPath);
      output[remotePath] = provenanceSha256(body);
    }
    return output;
  }

  async #ensureSsh(ip) {
    if (!ip) throw new Error("Droplet has no public IPv4 for SSH bootstrap");
    await mkdir(dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    let known = false;
    try {
      await this.runner("ssh-keygen", ["-F", ip, "-f", this.knownHostsPath], { allowFailure: false });
      known = true;
    } catch {}
    if (!known) {
      const scan = await this.runner("ssh-keyscan", ["-T", "10", "-H", ip], { capture: true });
      if (!scan.stdout.trim()) throw new Error(`could not capture SSH host key for ${ip}`);
      await writeFile(this.knownHostsPath, scan.stdout, { flag: "a", mode: 0o600 });
      await chmod(this.knownHostsPath, 0o600);
    }
    let lastError;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        await this.#ssh(ip, "cloud-init status --wait >/dev/null && test -S /var/run/docker.sock");
        const keyLines = await this.runner("ssh-keygen", ["-F", ip, "-f", this.knownHostsPath], { capture: true });
        return sha256(keyLines.stdout);
      } catch (error) {
        lastError = error;
        await delay(5_000);
      }
    }
    throw new Error(`SSH/cloud-init did not become ready for ${ip}: ${lastError?.message ?? "unknown error"}`);
  }

  async #ssh(ip, remoteCommand) {
    return this.runner("ssh", [
      "-i", this.sshPrivateKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
      "-o", "ConnectTimeout=10",
      `root@${ip}`,
      remoteCommand
    ], { capture: true });
  }

  async #script(relativePath, environment) {
    return this.runner(join(this.repoRoot, relativePath), [], { env: deploymentScriptEnvironment(environment), capture: true });
  }
}

export function deploymentScriptEnvironment(environment, inherited = process.env, nodeExecutable = process.execPath) {
  const inheritedPath = typeof inherited.PATH === "string" && inherited.PATH.trim() ? inherited.PATH.trim() : "/usr/bin:/bin:/usr/sbin:/sbin";
  const nodeDirectory = dirname(resolve(nodeExecutable));
  const path = [nodeDirectory, ...inheritedPath.split(":").filter((entry) => entry && entry !== nodeDirectory)].join(":");
  return { ...inherited, ...environment, PATH: path };
}

export function buildAgentPlans({ manifest, state, tokenConfig }) {
  if (!tokenConfig || tokenConfig.schemaVersion !== 1 || !tokenConfig.tokens || typeof tokenConfig.tokens !== "object" || Array.isArray(tokenConfig.tokens)) {
    throw new Error("agent token configuration is invalid");
  }
  const expectedNames = manifest.droplets.map((entry) => entry.name).sort();
  if (JSON.stringify(Object.keys(tokenConfig.tokens).sort()) !== JSON.stringify(expectedNames)) {
    throw new Error("agent token configuration must contain exactly one token per event Droplet");
  }
  const ingestSpecs = manifest.droplets.filter((entry) => entry.role === "ingest");
  if (ingestSpecs.length !== 1) throw new Error("event manifest must contain exactly one ingest service");
  const ingestResource = state.droplets[ingestSpecs[0].name];
  if (!ingestResource?.privateIpv4) throw new Error("ingest service is missing private IPv4 state");
  const analyzerOrigin = `rtsp://${ingestResource.privateIpv4}:8554`;
  return manifest.droplets.map((spec) => {
    const resource = state.droplets[spec.name];
    if (!resource?.publicIpv4 || !resource?.privateIpv4) throw new Error(`${spec.name} is missing public/private IPv4 state`);
    const token = tokenConfig.tokens[spec.name];
    if (typeof token !== "string" || token.length < 24 || token.length > 256) throw new Error(`${spec.name} agent token is invalid`);
    const id = spec.name;
    const role = agentRole(spec.role);
    const courts = Number.isInteger(spec.court) ? String(spec.court) : "";
    const environment = {
      MONITOR_AGENT_ID: id,
      MONITOR_AGENT_ROLE: role,
      MONITOR_AGENT_TOKEN: token,
      MONITOR_AGENT_BIND: resource.privateIpv4,
      MONITOR_AGENT_COURTS: courts,
      ...agentRoleEnvironment(spec.role),
      ...(spec.role === "compositor" ? {
        MONITOR_CONTENT_ANALYZER_COURTS: courts,
        MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: analyzerOrigin
      } : {})
    };
    return { id, role, token, courts, publicIpv4: resource.publicIpv4, privateIpv4: resource.privateIpv4, environment };
  });
}

export function compositorContentAnalyzerBindings({ manifest, state }) {
  const activeCompositors = manifest.droplets.filter((entry) => entry.role === "compositor");
  if (activeCompositors.length !== 8) throw new Error("event manifest must contain exactly eight assigned compositors");
  const bindings = activeCompositors.map((spec) => ({
    ip: state.droplets[spec.name]?.privateIpv4,
    courts: [spec.court]
  }));
  if (bindings.some((binding) => typeof binding.ip !== "string" || !binding.ip)) {
    throw new Error("every assigned compositor must have private IPv4 state");
  }
  if (bindings.some((binding) => !Number.isInteger(binding.courts[0]) || binding.courts[0] < 1 || binding.courts[0] > 8)) {
    throw new Error("every assigned compositor must own exactly one court from 1 through 8");
  }
  if (new Set(bindings.map((binding) => binding.ip)).size !== bindings.length) throw new Error("assigned compositor private IPv4 addresses must be unique");
  if (new Set(bindings.map((binding) => binding.courts[0])).size !== 8) throw new Error("assigned compositor courts must be unique");
  return bindings.sort((left, right) => left.courts[0] - right.courts[0]);
}

export function serializeAgentTargets(plans) {
  return plans.map((plan) => `${plan.id}|${plan.role}|http://${plan.privateIpv4}:9108|${plan.token}|${plan.courts}`).join(",");
}

export async function loadProtectedEnv(path) {
  await assertProtectedFile(path, basename(path));
  const output = {};
  for (const [index, rawLine] of (await readFile(path, "utf8")).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`${basename(path)} line ${index + 1} is not KEY=VALUE`);
    const key = line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || Object.hasOwn(output, key)) throw new Error(`${basename(path)} line ${index + 1} has an invalid or duplicate key`);
    const rawValue = line.slice(separator + 1);
    let value = rawValue;
    if (rawValue.startsWith('"')) {
      try { value = JSON.parse(rawValue); } catch { throw new Error(`${basename(path)} line ${index + 1} has invalid quoted text`); }
    } else if (/\s/.test(rawValue)) {
      throw new Error(`${basename(path)} line ${index + 1} must quote whitespace`);
    }
    output[key] = String(value);
  }
  return output;
}

async function assertProtectedFile(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected regular file with mode 0600 or stricter`);
}

export async function verifyProtectedSecretDirectory(root) {
  const directory = await stat(root);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error("secrets directory must be mode 0700 or stricter");
  const markerPath = join(root, "RENDER_COMPLETE.json");
  await assertProtectedFile(markerPath, "secret render marker");
  let marker;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
  catch { throw new Error("secret render marker is not valid JSON"); }
  if (marker.schemaVersion !== 1 || !marker.files || typeof marker.files !== "object" || Array.isArray(marker.files) || Object.keys(marker.files).length === 0) {
    throw new Error("secret render marker is invalid");
  }
  const names = new Set(Object.keys(marker.files));
  if (REQUIRED_DEPLOYMENT_SECRET_FILES.some((name) => !names.has(name))) {
    throw new Error("secret render marker is missing a required deployment file");
  }
  for (const [name, expected] of Object.entries(marker.files)) {
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("/") || name.includes("..") || name.includes("//") || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error("secret render marker contains an invalid file binding");
    }
    const path = join(root, name);
    await assertProtectedFile(path, `rendered secret ${name}`);
    if (sha256(await readFile(path)) !== expected) throw new Error(`rendered secret ${name} failed integrity verification`);
  }
  return marker;
}

function protectedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

function requiredAddressSlot(state, slot) {
  const value = state.addressSlots[slot]?.ip;
  if (!value) throw new Error(`lifecycle state has no ${slot} reserved IPv4`);
  return value;
}

export function servicePublicIpv4({ manifest, state, spec, resource }) {
  const endpoints = manifest.endpoints.filter((entry) => entry.role === spec.role);
  if (endpoints.length === 0) throw new Error(`manifest has no public endpoint for ${spec.role}`);
  const modes = [...new Set(endpoints.map((entry) => entry.addressMode))];
  if (modes.length !== 1) throw new Error(`manifest mixes public address modes for ${spec.role}`);
  if (modes[0] === "dynamic-ipv4") {
    if (!resource?.publicIpv4) throw new Error(`${spec.name} has no dynamic public IPv4`);
    return resource.publicIpv4;
  }
  if (modes[0] === "reserved-ipv4") {
    const slots = [...new Set(endpoints.map((entry) => entry.addressSlot))];
    if (slots.length !== 1) throw new Error(`manifest has ambiguous reserved IPv4 slots for ${spec.role}`);
    return requiredAddressSlot(state, slots[0]);
  }
  throw new Error(`manifest has unsupported public address mode for ${spec.role}`);
}

function endpointForRole(manifest, role) {
  const values = manifest.endpoints.filter((entry) => entry.role === role);
  if (values.length === 0) throw new Error(`manifest has no endpoint for ${role}`);
  return values[0].hostname;
}

function publicHttpHealthEndpoint(endpoint) {
  if (["ingest", "observability"].includes(endpoint.role)) return true;
  if (endpoint.role !== "commentary") return false;
  const firstLabel = endpoint.hostname.split(".", 1)[0];
  return firstLabel === "rtc" || firstLabel.startsWith("rtc-");
}

export function commentaryEndpointHosts(manifest) {
  return {
    rtc: endpointForPrefix(manifest, "commentary", "rtc"),
    turn: endpointForPrefix(manifest, "commentary", "turn")
  };
}

function endpointForPrefix(manifest, role, prefix) {
  const values = manifest.endpoints.filter((entry) => {
    if (entry.role !== role) return false;
    const firstLabel = entry.hostname.split(".", 1)[0];
    return firstLabel === prefix || firstLabel.startsWith(`${prefix}-`);
  });
  if (values.length !== 1) throw new Error(`manifest must have exactly one ${prefix} endpoint for ${role}`);
  return values[0].hostname;
}

function agentRole(role) {
  if (role === "ingest") return "mediamtx";
  if (role === "compositor") return "compositor";
  if (role === "compositor-spare") return "worker";
  return role;
}

function agentRoleEnvironment(role) {
  if (role === "ingest") return {
    MONITOR_AGENT_CONTAINERS: "mediamtx",
    FFMPEG_PROGRESS_DIR: "/monitoring/ffmpeg",
    MEDIAMTX_API_URL: "http://127.0.0.1:9997",
    MEDIAMTX_METRICS_URL: "http://127.0.0.1:9998/metrics"
  };
  if (["compositor", "compositor-spare"].includes(role)) return {
    MONITOR_AGENT_CONTAINERS: "bvm-redis,bvm-livekit,bvm-egress",
    EGRESS_METRICS_URL: "http://127.0.0.1:9090/metrics",
    EGRESS_HEALTH_URL: "http://127.0.0.1:9091/",
    MONITOR_EGRESS_MAX_WEB_REQUESTS: "1"
  };
  if (role === "commentary") return {
    LIVEKIT_METRICS_URL: "http://127.0.0.1:6789/metrics"
  };
  return {};
}

export function roleConfigBindings(repoRoot, secretsDirectory, spec) {
  if (spec.role === "commentary") return [
    [join(repoRoot, "infra/commentary/docker-compose.yml"), "/opt/livekit/docker-compose.yaml"],
    [join(repoRoot, "infra/commentary/.generated/livekit.yaml"), "/opt/livekit/livekit.yaml"],
    [join(repoRoot, "infra/commentary/.generated/caddy.yaml"), "/opt/livekit/caddy.yaml"],
    [join(repoRoot, "infra/commentary/redis.conf"), "/opt/livekit/redis.conf"]
  ];
  if (spec.role === "ingest") return [
    [join(repoRoot, "infra/mediamtx/docker-compose.yml"), "/opt/mediamtx/docker-compose.yml"],
    [join(repoRoot, "infra/mediamtx/.generated/mediamtx.yml"), "/opt/mediamtx/mediamtx.yml"],
    [join(repoRoot, "infra/mediamtx/.generated/Caddyfile"), "/opt/mediamtx/Caddyfile"],
    [join(repoRoot, "infra/mediamtx/scorecheck-ffmpeg-runner.sh"), "/opt/mediamtx/scorecheck-ffmpeg-runner.sh"]
  ];
  if (["compositor", "compositor-spare"].includes(spec.role)) return [
    [join(repoRoot, "infra/compositor/docker-compose.yml"), "/opt/compositor/docker-compose.yml"],
    [join(repoRoot, "infra/compositor/livekit.yaml"), "/opt/compositor/livekit.yaml"],
    [join(repoRoot, "infra/compositor/egress.yaml"), "/opt/compositor/egress.yaml"],
    [join(secretsDirectory, "compositors", `${spec.name}.env`), "/opt/compositor/.env"],
    [join(repoRoot, "infra/compositor/start-court.sh"), "/opt/compositor/start-court.sh"],
    [join(repoRoot, "infra/compositor/stop-court.sh"), "/opt/compositor/stop-court.sh"]
  ];
  if (spec.role === "observability") return [
    [join(repoRoot, "infra/monitoring/docker-compose.yml"), "/opt/scorecheck-monitoring/docker-compose.yml"],
    [join(repoRoot, "infra/monitoring/Caddyfile"), "/opt/scorecheck-monitoring/Caddyfile"],
    [join(repoRoot, "infra/monitoring/.generated/service.env"), "/opt/scorecheck-monitoring/.env"],
    [join(repoRoot, "infra/monitoring/.generated/prometheus.yml"), "/opt/scorecheck-monitoring/.generated/prometheus.yml"],
    [join(repoRoot, "infra/monitoring/.generated/alertmanager.yml"), "/opt/scorecheck-monitoring/.generated/alertmanager.yml"],
    [join(repoRoot, "infra/monitoring/rules/scorecheck.rules.yml"), "/opt/scorecheck-monitoring/rules/scorecheck.rules.yml"]
  ];
  throw new Error(`unsupported deployment role ${spec.role}`);
}

function verificationCommand(role) {
  const agent = "cd /opt/scorecheck-monitor-agent && cid=$(docker compose -f agent-compose.yml ps -q monitor-agent) && test -n \"$cid\" && test \"$(docker inspect \"$cid\" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')\" = healthy";
  if (role === "ingest") return `${agent} && curl -fsS http://127.0.0.1:9997/v3/config/global/get >/dev/null && if test -f /etc/wireguard/camera-lan.conf; then wg show camera-lan >/dev/null && ip -4 address show dev camera-lan | grep -q '10\\.89\\.0\\.1/24' && ip route show 192.168.8.0/24 | grep -q 'dev camera-lan'; fi`;
  if (role === "commentary") return `${agent} && curl -fsS http://127.0.0.1:7880/ >/dev/null && curl -fsS http://127.0.0.1:6789/metrics >/dev/null`;
  if (["compositor", "compositor-spare"].includes(role)) {
    return `${agent} && test \"$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')\" = healthy && curl -fsS http://127.0.0.1:9090/metrics >/dev/null`;
  }
  if (role === "observability") return `${agent} && cd /opt/scorecheck-monitoring && docker compose ps --status running --quiet | grep -q .`;
  throw new Error(`unsupported verification role ${role}`);
}

async function gitRevision(repoRoot, runner) {
  const result = await runner("git", ["-C", repoRoot, "rev-parse", "HEAD"], { capture: true });
  const revision = result.stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("could not resolve deployment Git revision");
  return revision;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) resolvePromise({ code, stdout, stderr });
      else reject(new Error(`${basename(command)} failed with exit ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
