#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CaddyTlsStateStore } from "./caddy-tls-state.mjs";
import { collectReconstructionProvenance, sha256 as provenanceSha256 } from "./reconstruction-provenance.mjs";

export const DEPLOYMENT_SCRIPT_TIMEOUT_MS = 10 * 60 * 1_000;
export const AGENT_DEPLOY_CONCURRENCY = 3;
export const MAX_CLOCK_OFFSET_MS = 1_000;
export const MAX_CLOCK_PROBE_RTT_MS = 5_000;
const HEALTHCHECKS_API = "https://healthchecks.io/api/v3";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const REQUIRED_DEPLOYMENT_SECRET_FILES = Object.freeze([
  "agent-tokens.json",
  "commentary.env",
  "ingest.env",
  "observability.env",
  ...["a", "b", "c", "d", "e", "f", "g", "h"].map((suffix) => `compositors/bvm-compositor-${suffix}.env`),
  "compositors/bvm-compositor-spare.env"
]);

export class LocalStackDeployer {
  constructor({
    repoRoot,
    secretsDirectory,
    sshPrivateKey,
    knownHostsPath,
    commentaryTlsStateDirectory = null,
    ingestTlsStateDirectory = null,
    observabilityTlsStateDirectory = null,
    acmeEmail = null,
    runner = runCommand,
    fetchImpl = globalThis.fetch,
    commentaryTlsStateStore = null,
    ingestTlsStateStore = null,
    observabilityTlsStateStore = null
  }) {
    this.repoRoot = resolve(repoRoot);
    this.secretsDirectory = protectedAbsolute(secretsDirectory, "secrets directory");
    this.sshPrivateKey = protectedAbsolute(sshPrivateKey, "SSH private key");
    this.knownHostsPath = protectedAbsolute(knownHostsPath, "event known_hosts path");
    this.runner = runner;
    this.fetchImpl = fetchImpl;
    this.agentConfig = null;
    this.acmeEmail = acmeEmail;
    this.commentaryTlsState = commentaryTlsStateStore ?? (commentaryTlsStateDirectory ? new CaddyTlsStateStore({
      directory: commentaryTlsStateDirectory,
      sshPrivateKey: this.sshPrivateKey,
      knownHostsPath: this.knownHostsPath,
      runner
    }) : null);
    this.ingestTlsState = ingestTlsStateStore ?? (ingestTlsStateDirectory ? new CaddyTlsStateStore({
      directory: ingestTlsStateDirectory,
      sshPrivateKey: this.sshPrivateKey,
      knownHostsPath: this.knownHostsPath,
      runner,
      remoteDirectory: "/opt/mediamtx"
    }) : null);
    this.observabilityTlsState = observabilityTlsStateStore ?? (observabilityTlsStateDirectory ? new CaddyTlsStateStore({
      directory: observabilityTlsStateDirectory,
      sshPrivateKey: this.sshPrivateKey,
      knownHostsPath: this.knownHostsPath,
      runner,
      remoteDirectory: "/opt/scorecheck-monitoring"
    }) : null);
  }

  async deploy({ manifest, spec, resource, state }) {
    await this.#validateProtectedInputs();
    const hostKeySha256 = await this.#ensureSsh(resource.publicIpv4);
    let commentaryTlsEvidence = null;
    let ingestTlsEvidence = null;
    let observabilityTlsEvidence = null;
    const common = {
      SCORECHECK_SSH_KNOWN_HOSTS: this.knownHostsPath
    };
    if (spec.role === "commentary") {
      const env = await loadProtectedEnv(join(this.secretsDirectory, "commentary.env"));
      const commentaryHosts = commentaryEndpointHosts(manifest);
      if (!this.commentaryTlsState) throw new Error("commentary TLS state store is required");
      if (typeof this.acmeEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(this.acmeEmail)) throw new Error("SCORECHECK_ACME_EMAIL is required for commentary certificate automation");
      const restoredTlsState = await this.commentaryTlsState.restore({
        publicIpv4: resource.publicIpv4,
        hosts: [commentaryHosts.rtc, commentaryHosts.turn]
      });
      await this.#script("infra/commentary/deploy.sh", {
        ...env,
        ...common,
        LIVEKIT_COMMENTARY_SSH_HOST: `root@${resource.publicIpv4}`,
        LIVEKIT_COMMENTARY_SSH_KEY: this.sshPrivateKey,
        LIVEKIT_COMMENTARY_PUBLIC_IP: servicePublicIpv4({ manifest, state, spec, resource }),
        LIVEKIT_COMMENTARY_RTC_HOST: commentaryHosts.rtc,
        LIVEKIT_COMMENTARY_TURN_HOST: commentaryHosts.turn,
        LIVEKIT_COMMENTARY_ACME_EMAIL: this.acmeEmail
      });
      const capturedTlsState = await this.commentaryTlsState.capture({
        publicIpv4: resource.publicIpv4,
        hosts: [commentaryHosts.rtc, commentaryHosts.turn]
      });
      commentaryTlsEvidence = {
        restored: restoredTlsState.status,
        captured: capturedTlsState.status,
        stateSha256: capturedTlsState.stateSha256,
        fileCount: capturedTlsState.fileCount,
        certificates: capturedTlsState.certificates
      };
    } else if (spec.role === "ingest") {
      const env = await loadProtectedEnv(join(this.secretsDirectory, "ingest.env"));
      const ingestHost = endpointForRole(manifest, "ingest");
      if (!this.ingestTlsState) throw new Error("ingest TLS state store is required");
      if (typeof this.acmeEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(this.acmeEmail)) throw new Error("SCORECHECK_ACME_EMAIL is required for ingest certificate automation");
      const restoredTlsState = await this.ingestTlsState.restore({
        publicIpv4: resource.publicIpv4,
        hosts: [ingestHost]
      });
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
        MEDIAMTX_PRIVATE_IP: resource.privateIpv4,
        MEDIAMTX_PUBLIC_HOST: ingestHost,
        MEDIAMTX_ACME_EMAIL: this.acmeEmail,
        MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify(compositorContentAnalyzerBindings({ manifest, state }))
      });
      const capturedTlsState = await this.ingestTlsState.capture({
        publicIpv4: resource.publicIpv4,
        hosts: [ingestHost]
      });
      ingestTlsEvidence = {
        restored: restoredTlsState.status,
        captured: capturedTlsState.status,
        stateSha256: capturedTlsState.stateSha256,
        fileCount: capturedTlsState.fileCount,
        certificates: capturedTlsState.certificates
      };
    } else if (["compositor", "compositor-spare"].includes(spec.role)) {
      const environmentPath = join(this.secretsDirectory, "compositors", `${spec.name}.env`);
      await assertProtectedFile(environmentPath, `${spec.name} environment`);
      const ingestSpec = manifest.droplets.find((entry) => entry.role === "ingest");
      const ingestPrivateIpv4 = ingestSpec ? state.droplets[ingestSpec.name]?.privateIpv4 : null;
      if (!ingestPrivateIpv4) throw new Error("compositor deployment requires the ingest private IPv4 address");
      await this.#script("infra/compositor/deploy.sh", {
        ...common,
        COMPOSITOR_SSH_HOST: `root@${resource.publicIpv4}`,
        COMPOSITOR_SSH_KEY: this.sshPrivateKey,
        COMPOSITOR_ENV_FILE: environmentPath,
        COMPOSITOR_INGEST_PRIVATE_IP: ingestPrivateIpv4,
        COMPOSITOR_INGEST_HOST: endpointForRole(manifest, "ingest")
      });
    } else if (spec.role === "observability") {
      const env = await loadProtectedEnv(join(this.secretsDirectory, "observability.env"));
      const plans = await this.#agentPlans(manifest, state);
      const host = endpointForRole(manifest, "observability");
      if (!this.observabilityTlsState) throw new Error("observability TLS state store is required");
      if (typeof this.acmeEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(this.acmeEmail)) throw new Error("SCORECHECK_ACME_EMAIL is required for observability certificate automation");
      const restoredTlsState = await this.observabilityTlsState.restore({
        publicIpv4: resource.publicIpv4,
        hosts: [host]
      });
      await this.#script("infra/monitoring/deploy.sh", {
        ...env,
        ...common,
        MONITOR_SSH_HOST: `root@${resource.publicIpv4}`,
        MONITOR_SSH_KEY: this.sshPrivateKey,
        MONITOR_PUBLIC_HOST: host,
        MONITOR_ACME_EMAIL: this.acmeEmail,
        MONITOR_AGENT_TARGETS: serializeAgentTargets(plans)
      });
      const capturedTlsState = await this.observabilityTlsState.capture({
        publicIpv4: resource.publicIpv4,
        hosts: [host]
      });
      observabilityTlsEvidence = {
        restored: restoredTlsState.status,
        captured: capturedTlsState.status,
        stateSha256: capturedTlsState.stateSha256,
        fileCount: capturedTlsState.fileCount,
        certificates: capturedTlsState.certificates
      };
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
    return { healthy: true, revision, evidence: {
      hostKeySha256,
      reconstruction,
      ...(commentaryTlsEvidence ? { commentaryTlsState: commentaryTlsEvidence } : {}),
      ...(ingestTlsEvidence ? { ingestTlsState: ingestTlsEvidence } : {}),
      ...(observabilityTlsEvidence ? { observabilityTlsState: observabilityTlsEvidence } : {})
    } };
  }

  async prepareForTeardown({ manifest, state }) {
    const commentarySpec = manifest.droplets.find((entry) => entry.role === "commentary");
    const ingestSpec = manifest.droplets.find((entry) => entry.role === "ingest");
    const observabilitySpec = manifest.droplets.find((entry) => entry.role === "observability");
    if (!commentarySpec || !ingestSpec || !observabilitySpec) throw new Error("event manifest is missing a TLS service");
    if (!this.commentaryTlsState || !this.ingestTlsState || !this.observabilityTlsState) throw new Error("all Caddy TLS state stores are required before teardown");
    const commentaryHosts = commentaryEndpointHosts(manifest);
    const commentaryStartCommand = "cd /opt/livekit && docker compose -f docker-compose.yaml start caddy";
    const ingestStartCommand = "cd /opt/mediamtx && docker compose start caddy";
    const observabilityStartCommand = "cd /opt/scorecheck-monitoring && docker compose start monitor-service caddy";
    let commentary = null;
    let ingest = null;
    let observability = null;
    let monitorServiceStopped = false;
    try {
      commentary = await this.#preserveCaddyState({
        state,
        spec: commentarySpec,
        store: this.commentaryTlsState,
        hosts: [commentaryHosts.rtc, commentaryHosts.turn],
        stopCommand: "cd /opt/livekit && test -f docker-compose.yaml && docker compose -f docker-compose.yaml stop caddy",
        startCommand: commentaryStartCommand
      });
      ingest = await this.#preserveCaddyState({
        state,
        spec: ingestSpec,
        store: this.ingestTlsState,
        hosts: [endpointForRole(manifest, "ingest")],
        stopCommand: "cd /opt/mediamtx && test -f docker-compose.yml && docker compose stop caddy",
        startCommand: ingestStartCommand
      });
      observability = await this.#preserveCaddyState({
        state,
        spec: observabilitySpec,
        store: this.observabilityTlsState,
        hosts: [endpointForRole(manifest, "observability")],
        stopCommand: "cd /opt/scorecheck-monitoring && test -f docker-compose.yml && docker compose stop caddy",
        startCommand: "cd /opt/scorecheck-monitoring && docker compose start caddy"
      });
      const observabilityResource = state.droplets[observabilitySpec.name];
      if (observabilityResource?.publicIpv4 && observabilityResource.status !== "destroyed") {
        const stopped = await this.#ssh(observabilityResource.publicIpv4, "cd /opt/scorecheck-monitoring && test -f docker-compose.yml && docker compose stop monitor-service", { allowFailure: true });
        if (stopped.code !== 0 && state.deployments[observabilitySpec.name]?.status === "healthy") {
          throw new Error("healthy observability monitor service could not be stopped before dead-man maintenance");
        }
        monitorServiceStopped = stopped.code === 0;
      }
      const healthchecks = await this.#pauseEventHealthchecks(await loadProtectedEnv(join(this.secretsDirectory, "observability.env")));
      return {
        healthy: true,
        evidence: {
          commentaryTlsState: commentary,
          ingestTlsState: ingest,
          observabilityTlsState: observability,
          observabilityMonitorStopped: monitorServiceStopped,
          healthchecks
        }
      };
    } catch (error) {
      const recoveryFailures = [];
      const observabilityResource = state.droplets[observabilitySpec.name];
      if ((monitorServiceStopped || observability?.caddyStopped) && observabilityResource?.publicIpv4) {
        const restarted = await this.#ssh(observabilityResource.publicIpv4, observabilityStartCommand, { allowFailure: true });
        if (restarted.code !== 0) recoveryFailures.push("observability services");
      }
      if (commentary?.caddyStopped) {
        const resource = state.droplets[commentarySpec.name];
        const restarted = await this.#ssh(resource.publicIpv4, commentaryStartCommand, { allowFailure: true });
        if (restarted.code !== 0) recoveryFailures.push("commentary Caddy");
      }
      if (ingest?.caddyStopped) {
        const resource = state.droplets[ingestSpec.name];
        const restarted = await this.#ssh(resource.publicIpv4, ingestStartCommand, { allowFailure: true });
        if (restarted.code !== 0) recoveryFailures.push("ingest Caddy");
      }
      if (recoveryFailures.length) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`teardown preparation failed (${reason}) and ${recoveryFailures.join(" and ")} could not be restarted`);
      }
      throw error;
    }
  }

  async #pauseEventHealthchecks(environment) {
    const apiKey = requiredEnvironment(environment, "HEALTHCHECKS_API_KEY");
    const checks = {
      baseline: requiredUuid(environment.HEALTHCHECKS_BASELINE_CHECK_ID, "HEALTHCHECKS_BASELINE_CHECK_ID"),
      active: requiredUuid(environment.HEALTHCHECKS_ACTIVE_CHECK_ID, "HEALTHCHECKS_ACTIVE_CHECK_ID"),
      sentinel: healthchecksUuidFromPingUrl(environment.HEALTHCHECKS_SENTINEL_PING_URL)
    };
    if (new Set(Object.values(checks)).size !== 3) throw new Error("event Healthchecks checks must have distinct identities");
    for (const [name, id] of Object.entries(checks)) {
      const pause = await this.fetchImpl(`${HEALTHCHECKS_API}/checks/${encodeURIComponent(id)}/pause`, {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: "",
        signal: AbortSignal.timeout(30_000)
      });
      if (!pause.ok && pause.status !== 409) throw new Error(`Healthchecks ${name} pause failed with HTTP ${pause.status}`);
      const response = await this.fetchImpl(`${HEALTHCHECKS_API}/checks/${encodeURIComponent(id)}`, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`Healthchecks ${name} verification failed with HTTP ${response.status}`);
      const value = await response.json();
      if (value.status !== "paused") throw new Error(`Healthchecks ${name} did not enter paused state`);
    }
    return { status: "paused", checks: Object.keys(checks) };
  }

  async #preserveCaddyState({ state, spec, store, hosts, stopCommand, startCommand }) {
    const resource = state.droplets[spec.name];
    const existing = await store.inspect(hosts, { allowMissing: true });
    if (!resource?.publicIpv4 || resource.status === "destroyed") {
      if (state.deployments[spec.name]?.status === "healthy" && existing.status !== "ready") throw new Error(`healthy ${spec.role} service has no retained TLS state before teardown`);
      return existing;
    }
    await assertProtectedFile(this.sshPrivateKey, "SSH private key");
    await this.#ensureSsh(resource.publicIpv4);
    const stop = await this.#ssh(resource.publicIpv4, stopCommand, { allowFailure: true });
    try {
      const captured = await store.capture({ publicIpv4: resource.publicIpv4, hosts });
      return { ...captured, caddyStopped: stop.code === 0 };
    } catch (error) {
      if (existing.status === "ready") {
        return { ...existing, status: "existing-retained", remoteCapture: "unavailable", caddyStopped: stop.code === 0 };
      }
      if (stop.code === 0) await this.#ssh(resource.publicIpv4, startCommand, { allowFailure: true });
      if (state.deployments[spec.name]?.status === "healthy") throw new Error(`healthy ${spec.role} TLS state could not be retained: ${error instanceof Error ? error.message : String(error)}`);
      return { status: "not-yet-issued", caddyStopped: false };
    }
  }

  async finalizeStack({ manifest, state }) {
    const plans = await this.#agentPlans(manifest, state);
    await mapWithConcurrency(plans, AGENT_DEPLOY_CONCURRENCY, async (plan) => {
      await this.#ensureSsh(plan.publicIpv4);
      await this.#script("infra/monitoring/deploy-agent.sh", {
        SCORECHECK_SSH_KNOWN_HOSTS: this.knownHostsPath,
        MONITOR_AGENT_SSH_HOST: `root@${plan.publicIpv4}`,
        MONITOR_AGENT_SSH_KEY: this.sshPrivateKey,
        ...plan.environment
      });
      return plan.id;
    });
    return { healthy: true, evidence: { deployedAgents: plans.map((entry) => entry.id) } };
  }

  async verifyStack({ manifest, state }) {
    const checks = [];
    for (const spec of manifest.droplets) {
      const resource = state.droplets[spec.name];
      await this.#ensureSsh(resource.publicIpv4);
      const command = verificationCommand(spec.role);
      await this.#ssh(resource.publicIpv4, command);
      const clockStartedAtMs = Date.now();
      const clockProbe = await this.#ssh(resource.publicIpv4, clockVerificationCommand());
      const clockEndedAtMs = Date.now();
      const clock = evaluateClockProbe({
        stdout: clockProbe.stdout,
        startedAtMs: clockStartedAtMs,
        endedAtMs: clockEndedAtMs
      });
      const privateNetwork = privateNetworkVerificationPlan({ manifest, state, spec });
      if (privateNetwork) await this.#ssh(resource.publicIpv4, privateNetwork.command);
      const reconstruction = await collectReconstructionProvenance({
        spec,
        resource,
        expectedConfigHashes: await this.#expectedConfigHashes(spec, true),
        runRemote: (remoteCommand) => this.#ssh(resource.publicIpv4, remoteCommand)
      });
      checks.push({
        name: spec.name,
        role: spec.role,
        status: "healthy",
        clock,
        privateNetwork: privateNetwork?.evidence ?? { status: "not-required", targets: [] },
        reconstruction
      });
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

  async #ssh(ip, remoteCommand, options = {}) {
    return this.runner("ssh", [
      "-i", this.sshPrivateKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
      "-o", "ConnectTimeout=10",
      `root@${ip}`,
      remoteCommand
    ], { capture: true, ...options });
  }

  async #script(relativePath, environment) {
    return runDeploymentScript({
      runner: this.runner,
      script: join(this.repoRoot, relativePath),
      environment,
      timeoutMs: DEPLOYMENT_SCRIPT_TIMEOUT_MS
    });
  }
}

export function clockVerificationCommand() {
  return "sync=$(timedatectl show --property=NTPSynchronized --value) && remote_ms=$(date +%s%3N) && printf '%s %s\\n' \"$sync\" \"$remote_ms\"";
}

export function evaluateClockProbe({ stdout, startedAtMs, endedAtMs }) {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs) || endedAtMs < startedAtMs) {
    throw new Error("clock probe timestamps are invalid");
  }
  const roundTripMs = endedAtMs - startedAtMs;
  if (roundTripMs > MAX_CLOCK_PROBE_RTT_MS) throw new Error(`clock probe round trip ${roundTripMs}ms exceeds ${MAX_CLOCK_PROBE_RTT_MS}ms`);
  const match = String(stdout ?? "").trim().match(/^(yes|no)\s+(\d{13})$/u);
  if (!match) throw new Error("clock probe response is invalid");
  if (match[1] !== "yes") throw new Error("host clock is not NTP synchronized");
  const remoteTimeMs = Number(match[2]);
  const midpointMs = startedAtMs + roundTripMs / 2;
  const offsetMs = Math.round(remoteTimeMs - midpointMs);
  if (Math.abs(offsetMs) > MAX_CLOCK_OFFSET_MS) {
    throw new Error(`host clock offset ${offsetMs}ms exceeds ${MAX_CLOCK_OFFSET_MS}ms`);
  }
  return { status: "synchronized", offsetMs, roundTripMs, remoteTimeMs };
}

export function privateNetworkVerificationPlan({ manifest, state, spec }) {
  const resource = state.droplets[spec.name];
  const source = privateIpv4(resource?.privateIpv4, `${spec.name} private IPv4`);
  const ingestSpec = manifest.droplets.find((entry) => entry.role === "ingest");
  const ingest = ingestSpec ? state.droplets[ingestSpec.name] : null;
  const ingestPrivateIpv4 = privateIpv4(ingest?.privateIpv4, "ingest private IPv4");
  const ingestHost = endpointForRole(manifest, "ingest");

  if (spec.role === "ingest") {
    return {
      command: `grep -Fq ${shellQuote(ingestPrivateIpv4)} /opt/mediamtx/mediamtx.yml`,
      evidence: { status: "verified", targets: [{ purpose: "webrtc-private-candidate", address: ingestPrivateIpv4 }] }
    };
  }
  if (["compositor", "compositor-spare"].includes(spec.role)) {
    const exactPrivateBinding = `MEDIAMTX_PRIVATE_HOST=\"${ingestPrivateIpv4}\"`;
    const exactPublicBinding = `MEDIAMTX_PUBLIC_HOST=\"${ingestHost}\"`;
    const hostsPattern = `^${regexpEscape(ingestPrivateIpv4)}[[:space:]]+${regexpEscape(ingestHost)}([[:space:]]|$)`;
    return {
      command: [
        `grep -Fxq ${shellQuote(exactPrivateBinding)} /opt/compositor/.env`,
        `grep -Fxq ${shellQuote(exactPublicBinding)} /opt/compositor/.env`,
        `ip -4 route get ${shellQuote(ingestPrivateIpv4)} | grep -Fq ${shellQuote(`src ${source}`)}`,
        `timeout 3 bash -c ${shellQuote(`</dev/tcp/${ingestPrivateIpv4}/8554`)}`,
        `docker exec bvm-egress grep -Eq ${shellQuote(hostsPattern)} /etc/hosts`,
        `docker exec bvm-egress curl -fsS --max-time 5 ${shellQuote(`https://${ingestHost}/healthz`)} >/dev/null`
      ].join(" && "),
      evidence: {
        status: "verified",
        targets: [
          { purpose: "normalizer-rtsp", address: `${ingestPrivateIpv4}:8554` },
          { purpose: "program-whep-tls", address: `${ingestHost}->${ingestPrivateIpv4}:443` }
        ]
      }
    };
  }
  if (spec.role === "observability") {
    const targets = manifest.droplets.map((entry) => ({
      name: entry.name,
      address: privateIpv4(state.droplets[entry.name]?.privateIpv4, `${entry.name} private IPv4`)
    }));
    const commands = targets.flatMap((target) => [
      `ip -4 route get ${shellQuote(target.address)} | grep -Fq ${shellQuote(`src ${source}`)}`,
      `curl -fsS --max-time 3 ${shellQuote(`http://${target.address}:9108/healthz`)} >/dev/null`
    ]);
    return {
      command: commands.join(" && "),
      evidence: { status: "verified", targets: targets.map((target) => ({ purpose: `agent-${target.name}`, address: `${target.address}:9108` })) }
    };
  }
  return null;
}

function privateIpv4(value, label) {
  if (typeof value !== "string" || !/^(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/u.test(value)) {
    throw new Error(`${label} is missing or not private`);
  }
  const octets = value.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) throw new Error(`${label} is invalid`);
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function regexpEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export async function runDeploymentScript({ runner, script, environment, wait = delay, timeoutMs = DEPLOYMENT_SCRIPT_TIMEOUT_MS }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60 * 1_000) throw new Error("deployment script timeout must be from 1000 through 3600000 milliseconds");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await runner(script, [], { env: deploymentScriptEnvironment(environment), capture: true, timeoutMs }); }
    catch (error) {
      if (attempt === 3 || !isRetryableDeploymentTransportError(error)) throw error;
      await wait(attempt * 2_000);
    }
  }
  throw new Error(`${script} exhausted its deployment retries`);
}

export async function mapWithConcurrency(values, concurrency, operation) {
  if (!Array.isArray(values)) throw new Error("concurrent values must be an array");
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (typeof operation !== "function") throw new Error("concurrent operation must be a function");
  const results = new Array(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(values.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index], index);
    }
  }));
  return results;
}

export function deploymentScriptEnvironment(environment, inherited = process.env, nodeExecutable = process.execPath) {
  const inheritedPath = typeof inherited.PATH === "string" && inherited.PATH.trim() ? inherited.PATH.trim() : "/usr/bin:/bin:/usr/sbin:/sbin";
  const nodeDirectory = dirname(resolve(nodeExecutable));
  const path = [nodeDirectory, ...inheritedPath.split(":").filter((entry) => entry && entry !== nodeDirectory)].join(":");
  return { ...inherited, ...environment, PATH: path };
}

export function isRetryableDeploymentTransportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    /Connection timed out during banner exchange/u,
    /Connection to [0-9a-f:.]+ port 22 timed out/u,
    /Connection reset by peer/u,
    /Connection closed by remote host/u,
    /kex_exchange_identification:.*Connection (?:closed|reset)/u,
    /ssh_exchange_identification:.*Connection (?:closed|reset)/u
  ].some((pattern) => pattern.test(message));
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
    [join(repoRoot, "infra/mediamtx/scorecheck-ffmpeg-runner.sh"), "/opt/mediamtx/scorecheck-ffmpeg-runner.sh"],
    [join(repoRoot, "infra/mediamtx/scorecheck-preview-runner.sh"), "/opt/mediamtx/scorecheck-preview-runner.sh"]
  ];
  if (["compositor", "compositor-spare"].includes(spec.role)) return [
    [join(repoRoot, "infra/compositor/docker-compose.yml"), "/opt/compositor/docker-compose.yml"],
    [join(repoRoot, "infra/compositor/livekit.yaml"), "/opt/compositor/livekit.yaml"],
    [join(repoRoot, "infra/compositor/egress.yaml"), "/opt/compositor/egress.yaml"],
    [join(secretsDirectory, "compositors", `${spec.name}.env`), "/opt/compositor/.env"],
    [join(repoRoot, "infra/compositor/normalize-camera.sh"), "/opt/compositor/normalize-camera.sh"],
    [join(repoRoot, "infra/compositor/qualify-output.sh"), "/opt/compositor/qualify-output.sh"],
    [join(repoRoot, "infra/compositor/start-court.sh"), "/opt/compositor/start-court.sh"],
    [join(repoRoot, "infra/compositor/start-normalizer.sh"), "/opt/compositor/start-normalizer.sh"],
    [join(repoRoot, "infra/compositor/stop-normalizer.sh"), "/opt/compositor/stop-normalizer.sh"],
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

export async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const timeoutMs = options.timeoutMs ?? null;
    if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60 * 1_000)) {
      reject(new Error("command timeout must be from 1000 through 3600000 milliseconds"));
      return;
    }
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const timer = timeoutMs === null ? null : setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      settle(() => reject(new Error(`${basename(command)} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer?.unref();
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) settle(() => resolvePromise({ code, stdout, stderr }));
      else settle(() => reject(new Error(commandFailureMessage(command, code, { stdout, stderr }))));
    });
  });
}

export function commandFailureMessage(command, code, { stdout = "", stderr = "" } = {}) {
  const sections = [];
  const stderrTail = diagnosticTail(stderr);
  const stdoutTail = diagnosticTail(stdout);
  if (stderrTail) sections.push(`stderr tail:\n${stderrTail}`);
  if (stdoutTail) sections.push(`stdout tail:\n${stdoutTail}`);
  return `${basename(command)} failed with exit ${code ?? "unknown"}${sections.length ? `:\n${sections.join("\n")}` : ""}`;
}

function diagnosticTail(value, limit = 4_000) {
  const normalized = String(value ?? "").trim();
  if (normalized.length <= limit) return normalized;
  return `[earlier output omitted]\n${normalized.slice(-limit)}`;
}

function requiredEnvironment(environment, name) {
  const value = environment?.[name]?.trim();
  if (!value || /[\r\n\0]/u.test(value)) throw new Error(`${name} is required`);
  return value;
}

function requiredUuid(value, label) {
  const normalized = String(value ?? "").trim();
  if (!UUID.test(normalized)) throw new Error(`${label} must be a UUID`);
  return normalized;
}

function healthchecksUuidFromPingUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("HEALTHCHECKS_SENTINEL_PING_URL is invalid"); }
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol !== "https:" || url.hostname !== "hc-ping.com" || segments.length !== 1 || url.search || url.hash) {
    throw new Error("HEALTHCHECKS_SENTINEL_PING_URL must be a direct Healthchecks UUID URL");
  }
  return requiredUuid(segments[0], "HEALTHCHECKS_SENTINEL_PING_URL identity");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}
