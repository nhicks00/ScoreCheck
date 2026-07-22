import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { CaddyTlsStateStore } from "./caddy-tls-state.mjs";
import { EgressRuntime } from "./rehearsal/egress-runtime.mjs";
import { renderPrometheusConfig } from "../monitoring/render-config.mjs";
import {
  buildAgentPlans,
  isRetryableDeploymentTransportError,
  loadProtectedEnv,
  runCommand,
  runDeploymentScript,
  serializeAgentTargets,
  verifyProtectedSecretDirectory
} from "./stack-deployer.mjs";

const RECOVERY_TARGET_DIRECTORY = "/opt/scorecheck-monitoring";

export class LocalIngestRecoveryPlatform {
  constructor({
    repoRoot,
    manifest,
    lifecycleState,
    anchors,
    secretsDirectory,
    sshPrivateKey,
    knownHostsPath,
    ingestTlsStateDirectory,
    acmeEmail,
    cloud,
    runner = runCommand,
    scriptRunner = runDeploymentScript,
    fetchImpl = globalThis.fetch,
    sleep = delay,
    egressRuntime = null,
    ingestTlsStateStore = null
  }) {
    this.repoRoot = protectedAbsolute(repoRoot, "repository root");
    this.manifest = manifest;
    this.lifecycleState = lifecycleState;
    const reservedIpv4 = anchors?.reservedIpv4?.ingest;
    assertIpv4(reservedIpv4, "retained ingest Reserved IPv4");
    this.reservedIpv4 = reservedIpv4;
    this.secretsDirectory = protectedAbsolute(secretsDirectory, "secrets directory");
    this.sshPrivateKey = protectedAbsolute(sshPrivateKey, "SSH private key");
    this.knownHostsPath = protectedAbsolute(knownHostsPath, "known_hosts path");
    this.ingestTlsStateDirectory = protectedAbsolute(ingestTlsStateDirectory, "ingest TLS state directory");
    if (typeof acmeEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(acmeEmail)) throw new Error("ingest recovery requires a valid ACME email");
    if (!cloud) throw new Error("ingest recovery requires the DigitalOcean provider");
    if (typeof runner !== "function" || typeof scriptRunner !== "function" || typeof fetchImpl !== "function" || typeof sleep !== "function") throw new Error("ingest recovery runtime dependencies are invalid");
    this.acmeEmail = acmeEmail;
    this.cloud = cloud;
    this.runner = runner;
    this.scriptRunner = scriptRunner;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.egress = egressRuntime ?? new EgressRuntime({ sshKey: this.sshPrivateKey, knownHosts: this.knownHostsPath, runner, sleep });
    this.ingestTlsState = ingestTlsStateStore ?? new CaddyTlsStateStore({
      directory: this.ingestTlsStateDirectory,
      sshPrivateKey: this.sshPrivateKey,
      knownHostsPath: this.knownHostsPath,
      runner,
      remoteDirectory: "/opt/mediamtx"
    });
    this.ingestHostname = onlyEndpoint(manifest, "ingest");
    this.monitorHostname = onlyEndpoint(manifest, "observability");
    this.agentPlans = null;
  }

  async assertPrimaryIngestHealthy(host) {
    await this.#ssh(host.publicIpv4, primaryIngestHealthCommand());
    const topology = this.#topologyContext();
    const address = await this.cloud.getReservedIpv4(topology.reservedIpv4);
    if (address.locked) throw new Error("ingest Reserved IPv4 is locked while verifying the primary");
    if (String(address.dropletId) === String(host.dropletId)) await this.#requirePublicHealth(this.ingestHostname);
    else if (String(address.dropletId) !== String(topology.spare.dropletId)) throw new Error("ingest Reserved IPv4 is owned by an unexpected Droplet");
  }

  async assertProtectedInputs() {
    await this.#validateProtectedInputs();
  }

  async assertPrimaryIngestFailed(host, { allowReservedOnSpare = false } = {}) {
    const topology = this.#topologyContext();
    const address = await this.cloud.getReservedIpv4(topology.reservedIpv4);
    if (address.locked) throw new Error("ingest Reserved IPv4 is locked while verifying primary failure");
    if (String(address.dropletId) === String(topology.spare.dropletId)) {
      if (!allowReservedOnSpare) throw new Error("ingest Reserved IPv4 moved before the takeover transaction started");
      return;
    }
    if (String(address.dropletId) !== String(host.dropletId)) throw new Error("ingest Reserved IPv4 is owned by an unexpected Droplet");
    let locallyHealthy = false;
    try {
      await this.#ssh(host.publicIpv4, primaryIngestHealthCommand());
      locallyHealthy = true;
    } catch (error) {
      if (!isPrimaryFailureProbe(error)) throw new Error("primary ingest failure could not be verified with the protected SSH identity");
    }
    if (locallyHealthy) throw new Error("primary ingest remains locally healthy");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await this.#publicHealth(this.ingestHostname)) throw new Error("failed primary ingest still serves the public endpoint");
      if (attempt < 2) await this.sleep(2_000);
    }
  }

  async assertSpareIdle(host) {
    await this.egress.preflight(host.publicIpv4);
    await this.#ssh(host.publicIpv4, "test \"$(docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null || true)\" != true && ! ip link show camera-lan >/dev/null 2>&1");
  }

  async assertCompositorOutputsHealthy(compositors) {
    for (const compositor of compositors) {
      const active = await this.egress.listActive(compositor.publicIpv4);
      if (active.length > 1 || (this.lifecycleState.phase === "live" && active.length !== 1)) {
        throw new Error(`Camera ${compositor.cameraNumber} compositor output count is invalid`);
      }
      if (active.length === 0) {
        await this.egress.preflight(compositor.publicIpv4);
        continue;
      }
      const owner = await this.egress.readOwnership(compositor.publicIpv4, compositor.cameraNumber);
      await this.egress.reconcileOwned({
        host: compositor.publicIpv4,
        court: compositor.cameraNumber,
        profile: owner.outputProfile,
        owner,
        expectedId: active[0].id
      });
    }
  }

  async assertSpareIngestHealthy(host) {
    await this.#ssh(host.publicIpv4, "cd /opt/mediamtx && ./recovery-role.sh status-active");
  }

  async assertSpareIngestStaged(host) {
    await this.#ssh(host.publicIpv4, "cd /opt/mediamtx && ./recovery-role.sh status-staged");
  }

  async stageSpareIngest(topology) {
    await this.#validateProtectedInputs();
    const tls = await this.ingestTlsState.restore({ publicIpv4: topology.spare.publicIpv4, hosts: [topology.ingestHostname] });
    if (tls.status !== "restored") throw new Error("retained ingest TLS state is required before staging the spare");
    const wireguardConfig = join(this.secretsDirectory, "wireguard/camera-lan.conf");
    await assertProtectedFile(wireguardConfig, "ingest WireGuard configuration");
    await this.#script("infra/mediamtx/deploy-wireguard.sh", {
      SCORECHECK_SSH_KNOWN_HOSTS: this.knownHostsPath,
      MEDIAMTX_SSH_HOST: `root@${topology.spare.publicIpv4}`,
      MEDIAMTX_SSH_KEY: this.sshPrivateKey,
      MEDIAMTX_WIREGUARD_CONFIG: wireguardConfig,
      MEDIAMTX_WIREGUARD_MODE: "staged"
    });
    const environment = await loadProtectedEnv(join(this.secretsDirectory, "ingest.env"));
    await this.#script("infra/mediamtx/deploy.sh", {
      ...environment,
      SCORECHECK_SSH_KNOWN_HOSTS: this.knownHostsPath,
      MEDIAMTX_SSH_HOST: `root@${topology.spare.publicIpv4}`,
      MEDIAMTX_SSH_KEY: this.sshPrivateKey,
      MEDIAMTX_PUBLIC_IP: topology.reservedIpv4,
      MEDIAMTX_PRIVATE_IP: topology.spare.privateIpv4,
      MEDIAMTX_PUBLIC_HOST: topology.ingestHostname,
      MEDIAMTX_ACME_EMAIL: this.acmeEmail,
      MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify(topology.compositors.map((entry) => ({ ip: entry.privateIpv4, courts: [entry.cameraNumber] }))),
      MEDIAMTX_DEPLOY_MODE: "staged"
    });
    await this.#ssh(topology.spare.publicIpv4, "cd /opt/mediamtx && ./recovery-role.sh status-staged");
    return { status: "staged", tlsStateSha256: tls.stateSha256 };
  }

  async captureOutputGenerations(compositors) {
    const output = {};
    for (const compositor of compositors) {
      const active = await this.egress.listActive(compositor.publicIpv4);
      if (active.length !== 1) throw new Error(`Camera ${compositor.cameraNumber} must have exactly one active Egress before ingest takeover`);
      const owner = await this.egress.readOwnership(compositor.publicIpv4, compositor.cameraNumber);
      if (owner.event !== this.manifest.event) throw new Error(`Camera ${compositor.cameraNumber} Egress belongs to a different event`);
      await this.egress.reconcileOwned({
        host: compositor.publicIpv4,
        court: compositor.cameraNumber,
        profile: owner.outputProfile,
        owner,
        expectedId: active[0].id
      });
      output[compositor.cameraNumber] = owner;
    }
    return output;
  }

  async attachIngestNetworkPolicy(spare) {
    const topology = this.#topologyContext();
    await this.#ssh(spare.publicIpv4, `cd /opt/mediamtx && ./recovery-role.sh firewall-attach ${topology.vpcCidr}`);
    await this.cloud.attachTagToDroplet(topology.ingestFirewallTag, spare.dropletId);
  }

  async activateSpareIngest(topology) {
    await this.#ssh(topology.spare.publicIpv4, `cd /opt/mediamtx && ./recovery-role.sh activate ${topology.vpcCidr}`);
  }

  async moveReservedIpv4(input) {
    return this.cloud.moveReservedIpv4(input);
  }

  async waitIngestPublicHealth(host) {
    const address = await this.cloud.getReservedIpv4(this.#topologyContext().reservedIpv4);
    if (String(address.dropletId) !== String(host.dropletId) || address.locked) throw new Error("ingest Reserved IPv4 ownership is not converged");
    await this.#requirePublicHealth(this.ingestHostname);
  }

  async rebindCompositorIngress({ compositor, generation, fromPrivateIpv4, toPrivateIpv4 }) {
    const active = await this.egress.listActive(compositor.publicIpv4);
    if (active.length > 1) throw new Error(`Camera ${compositor.cameraNumber} compositor admitted multiple Egress jobs`);
    if (active.length === 1) {
      if (active[0].id !== generation.egressId) throw new Error(`Camera ${compositor.cameraNumber} active Egress changed before ingest rebind`);
      await this.egress.stopExact({
        host: compositor.publicIpv4,
        court: compositor.cameraNumber,
        egressId: generation.egressId,
        profile: generation.outputProfile,
        owner: ownerForRestart(generation)
      });
    }
    await this.#ssh(compositor.publicIpv4, `cd /opt/compositor && ./rebind-ingest.sh ${fromPrivateIpv4} ${toPrivateIpv4} ${this.ingestHostname}`);
  }

  async resumeOutputGeneration({ compositor, generation }) {
    return this.egress.ensureStarted({
      host: compositor.publicIpv4,
      court: compositor.cameraNumber,
      profile: generation.outputProfile,
      owner: ownerForRestart(generation)
    });
  }

  async switchIngestMonitoring({ from, to }) {
    const plans = await this.#loadAgentPlans();
    const destination = plans.find((entry) => entry.id === to.name);
    if (!destination) throw new Error("monitoring destination agent is missing");
    const mediamtxPlan = asMediamtxAgent(destination);
    await this.#deployAgent(mediamtxPlan);
    const desired = plans
      .filter((entry) => entry.id !== from.name)
      .map((entry) => entry.id === to.name ? mediamtxPlan : entry);
    await this.#replaceMonitoringTargets(desired);
    await this.#verifyMonitoringRoles(new Map([[to.name, "mediamtx"]]), new Set([from.name]));
  }

  async verifyRecoveredIngest({ topology, outputGenerations }) {
    const active = topology.activeIngest ?? topology.spare;
    const address = await this.cloud.getReservedIpv4(topology.reservedIpv4);
    if (String(address.dropletId) !== String(active.dropletId) || address.locked) throw new Error("recovered ingest Reserved IPv4 identity is invalid");
    if (active.name === topology.spare.name) await this.assertSpareIngestHealthy(active);
    else await this.#ssh(active.publicIpv4, primaryIngestHealthCommand());
    await this.#requirePublicHealth(topology.ingestHostname);
    await this.#waitForMediaPaths(active.publicIpv4);
    for (const compositor of topology.compositors) {
      const generation = outputGenerations[compositor.cameraNumber];
      const activeEgress = await this.egress.listActive(compositor.publicIpv4);
      if (activeEgress.length !== 1) throw new Error(`Camera ${compositor.cameraNumber} output did not resume exactly once`);
      await this.egress.reconcileOwned({
        host: compositor.publicIpv4,
        court: compositor.cameraNumber,
        profile: generation.outputProfile,
        owner: ownerForRestart(generation),
        expectedId: activeEgress[0].id
      });
      await this.#ssh(compositor.publicIpv4, `grep -Fqx 'MEDIAMTX_PRIVATE_HOST=\"${active.privateIpv4}\"' /opt/compositor/.env && docker inspect bvm-egress --format '{{json .HostConfig.ExtraHosts}}' | grep -Fq '${topology.ingestHostname}:${active.privateIpv4}'`);
    }
    await this.#verifyMonitoringRoles(new Map([[active.name, "mediamtx"]]));
  }

  async deactivateSpareIngest(spare) {
    await this.#ssh(spare.publicIpv4, "cd /opt/mediamtx && ./recovery-role.sh deactivate");
  }

  async detachIngestNetworkPolicy(spare) {
    const topology = this.#topologyContext();
    await this.cloud.detachTagFromDroplet(topology.ingestFirewallTag, spare.dropletId);
    await this.#ssh(spare.publicIpv4, `cd /opt/mediamtx && ./recovery-role.sh firewall-detach ${topology.vpcCidr}`);
  }

  async restoreSpareCompositor(spare) {
    await this.#ssh(spare.publicIpv4, "cd /opt/mediamtx && ./recovery-role.sh restore-compositor");
    const plans = await this.#loadAgentPlans();
    const sparePlan = plans.find((entry) => entry.id === spare.name);
    if (!sparePlan) throw new Error("spare monitoring agent plan is missing");
    await this.#deployAgent(sparePlan);
    await this.#replaceMonitoringTargets(plans);
    await this.#verifyMonitoringRoles(new Map([[spare.name, "worker"], [this.#topologyContext().primary.name, "mediamtx"]]));
  }

  async #waitForMediaPaths(host) {
    const required = Array.from({ length: 8 }, (_, index) => [
      `court${index + 1}_raw`, `court${index + 1}_preview`, `court${index + 1}_program`
    ]).flat();
    const encoded = Buffer.from(JSON.stringify(required)).toString("base64");
    await this.#ssh(host, `curl -fsS http://127.0.0.1:9997/v3/paths/list | REQUIRED_B64='${encoded}' python3 -c 'import base64,json,os,sys; required=json.loads(base64.b64decode(os.environ["REQUIRED_B64"])); items=json.load(sys.stdin).get("items",[]); ready={x.get("name") for x in items if x.get("ready") is True}; missing=[x for x in required if x not in ready]; assert not missing, "missing ready paths: "+",".join(missing)'`);
  }

  async #loadAgentPlans() {
    if (this.agentPlans) return this.agentPlans;
    const path = join(this.secretsDirectory, "agent-tokens.json");
    await assertProtectedFile(path, "agent token configuration");
    this.agentPlans = buildAgentPlans({
      manifest: this.manifest,
      state: this.lifecycleState,
      tokenConfig: JSON.parse(await readFile(path, "utf8"))
    });
    return this.agentPlans;
  }

  async #deployAgent(plan) {
    await this.#script("infra/monitoring/deploy-agent.sh", {
      SCORECHECK_SSH_KNOWN_HOSTS: this.knownHostsPath,
      MONITOR_AGENT_SSH_HOST: `root@${plan.publicIpv4}`,
      MONITOR_AGENT_SSH_KEY: this.sshPrivateKey,
      ...plan.environment
    });
  }

  async #replaceMonitoringTargets(plans) {
    const payload = serializeAgentTargets(plans);
    const environment = await loadProtectedEnv(join(this.secretsDirectory, "observability.env"));
    const token = environment.MONITOR_API_TOKEN;
    if (!token) throw new Error("MONITOR_API_TOKEN is required for recovery monitoring configuration");
    const directory = await mkdtemp(join(tmpdir(), "scorecheck-ingest-recovery-targets-"));
    await chmod(directory, 0o700);
    const localPath = join(directory, "targets.txt");
    const localPrometheusPath = join(directory, "prometheus.yml");
    const remotePath = `${RECOVERY_TARGET_DIRECTORY}/.recovery-agent-targets-${process.pid}.txt`;
    const remotePrometheusPath = `${RECOVERY_TARGET_DIRECTORY}/.recovery-prometheus-${process.pid}.yml`;
    try {
      await writeFile(localPath, payload, { mode: 0o600, flag: "wx" });
      await writeFile(localPrometheusPath, renderPrometheusConfig(payload, token), { mode: 0o600, flag: "wx" });
      await this.#rsync(localPath, `root@${this.#topologyContext().observability.publicIpv4}:${remotePath}`);
      await this.#rsync(localPrometheusPath, `root@${this.#topologyContext().observability.publicIpv4}:${remotePrometheusPath}`);
      await this.#ssh(this.#topologyContext().observability.publicIpv4, `chmod 0600 '${remotePath}' '${remotePrometheusPath}' && cd ${RECOVERY_TARGET_DIRECTORY} && ./replace-agent-targets.sh '${remotePath}' '${remotePrometheusPath}'`);
    } finally {
      await this.#ssh(this.#topologyContext().observability.publicIpv4, `rm -f '${remotePath}' '${remotePrometheusPath}'`, { allowFailure: true }).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
    await this.#requirePublicHealth(this.monitorHostname);
  }

  async #verifyMonitoringRoles(expected, absent = new Set()) {
    const environment = await loadProtectedEnv(join(this.secretsDirectory, "observability.env"));
    const token = environment.MONITOR_API_TOKEN;
    if (!token) throw new Error("MONITOR_API_TOKEN is required for recovery verification");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await this.fetchImpl(`https://${this.monitorHostname}/v1/snapshot`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5_000)
        });
        if (response.ok) {
          const snapshot = await response.json();
          const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : [];
          const rolesMatch = [...expected].every(([id, role]) => agents.some((entry) => entry.agentId === id && entry.role === role && entry.state === "HEALTHY" && Number(entry.ageMs) <= 10_000));
          const absentMatch = [...absent].every((id) => !agents.some((entry) => entry.agentId === id));
          const mediamtx = agents.filter((entry) => entry.role === "mediamtx");
          if (rolesMatch && absentMatch && mediamtx.length === 1) return;
        }
      } catch {}
      await this.sleep(1_000);
    }
    throw new Error("monitoring did not converge to the recovered ingest role");
  }

  async #validateProtectedInputs() {
    await verifyProtectedSecretDirectory(this.secretsDirectory);
    await assertProtectedFile(this.sshPrivateKey, "SSH private key");
    await assertProtectedFile(this.knownHostsPath, "known_hosts path");
  }

  async #script(relativePath, environment) {
    return this.scriptRunner({
      runner: this.runner,
      script: join(this.repoRoot, relativePath),
      environment,
      timeoutMs: 10 * 60_000
    });
  }

  async #ssh(ip, command, options = {}) {
    assertIpv4(ip, "SSH host");
    const args = [
      "-i", this.sshPrivateKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
      "-o", "ConnectTimeout=10",
      `root@${ip}`,
      command
    ];
    const attempts = options.retrySafe === false ? 1 : 3;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.runner("ssh", args, { capture: true, allowFailure: options.allowFailure === true });
      } catch (error) {
        if (attempt === attempts || !isRetryableDeploymentTransportError(error)) throw error;
        await this.sleep(attempt * 2_000);
      }
    }
    throw new Error("ingest recovery SSH retry loop exited unexpectedly");
  }

  async #rsync(source, destination) {
    const shell = [
      "ssh", "-i", shellQuote(this.sshPrivateKey), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", shellQuote(`UserKnownHostsFile=${this.knownHostsPath}`), "-o", "ConnectTimeout=10"
    ].join(" ");
    return this.runner("rsync", ["-a", "-e", shell, source, destination], { capture: true });
  }

  async #requirePublicHealth(hostname) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await this.#publicHealth(hostname)) return;
      await this.sleep(1_000);
    }
    throw new Error(`${hostname} did not become publicly healthy`);
  }

  async #publicHealth(hostname) {
    try {
      const response = await this.fetchImpl(`https://${hostname}/healthz`, { signal: AbortSignal.timeout(5_000), redirect: "manual" });
      return response.ok;
    } catch {
      return false;
    }
  }

  #topologyContext() {
    const primary = this.manifest.droplets.find((entry) => entry.role === "ingest");
    const spare = this.manifest.droplets.find((entry) => entry.role === "compositor-spare");
    const observability = this.manifest.droplets.find((entry) => entry.role === "observability");
    const resource = (spec) => ({ ...this.lifecycleState.droplets[spec.name], name: spec.name, dropletId: String(this.lifecycleState.droplets[spec.name].id) });
    return {
      primary: resource(primary),
      spare: resource(spare),
      observability: resource(observability),
      reservedIpv4: this.reservedIpv4,
      vpcCidr: this.manifest.provider.vpcCidr,
      ingestFirewallTag: primary.tag
    };
  }
}

export function ownerForRestart(generation) {
  return {
    event: generation.event,
    destinationId: generation.destinationId,
    outputGeneration: generation.outputGeneration,
    rendererGitSha: generation.rendererGitSha,
    rendererDeploymentId: generation.rendererDeploymentId
  };
}

export function asMediamtxAgent(plan) {
  return {
    ...plan,
    role: "mediamtx",
    courts: "",
    environment: {
      MONITOR_AGENT_ID: plan.id,
      MONITOR_AGENT_ROLE: "mediamtx",
      MONITOR_AGENT_TOKEN: plan.token,
      MONITOR_AGENT_BIND: plan.privateIpv4,
      MONITOR_AGENT_PORT: "9108",
      MONITOR_AGENT_INTERVAL_MS: "5000",
      MONITOR_AGENT_COURTS: "",
      MONITOR_AGENT_CONTAINERS: "mediamtx",
      MONITOR_DISK_PATH: "/",
      FFMPEG_PROGRESS_DIR: "/monitoring/ffmpeg",
      DOCKER_API_URL: "http://127.0.0.1:2375",
      MEDIAMTX_API_URL: "http://127.0.0.1:9997",
      MEDIAMTX_METRICS_URL: "http://127.0.0.1:9998/metrics",
      LIVEKIT_METRICS_URL: "",
      EGRESS_METRICS_URL: "",
      EGRESS_HEALTH_URL: "",
      MONITOR_EGRESS_MAX_WEB_REQUESTS: "1",
      MONITOR_CONTENT_ANALYZER_COURTS: "",
      MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: "",
      MONITOR_CONTENT_ANALYZER_FFMPEG_PATH: "/usr/bin/ffmpeg",
      MONITOR_CONTENT_ANALYZER_FFPROBE_PATH: "/usr/bin/ffprobe"
    }
  };
}

function primaryIngestHealthCommand() {
  return "cd /opt/mediamtx && test \"$(docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null || true)\" = true && test \"$(docker inspect bvm-mediamtx-caddy --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)\" = healthy && curl -fsS http://127.0.0.1:9997/v3/config/global/get >/dev/null";
}

function onlyEndpoint(manifest, role) {
  const matches = manifest?.endpoints?.filter((entry) => entry.role === role) ?? [];
  if (matches.length !== 1 || typeof matches[0].hostname !== "string" || !/^[a-z0-9.-]+$/u.test(matches[0].hostname)) throw new Error(`manifest requires exactly one ${role} endpoint`);
  return matches[0].hostname;
}

async function assertProtectedFile(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected regular file with mode 0600 or stricter`);
}

function protectedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function assertIpv4(value, label) {
  const parts = typeof value === "string" ? value.split(".") : [];
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) throw new Error(`${label} must be an IPv4 address`);
}

function isPrimaryFailureProbe(error) {
  const message = error instanceof Error ? error.message : String(error);
  return isRetryableDeploymentTransportError(error)
    || /ssh failed with exit 1(?:\D|$)/u.test(message)
    || /(?:No route to host|Connection refused|Operation timed out)/iu.test(message);
}

function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
