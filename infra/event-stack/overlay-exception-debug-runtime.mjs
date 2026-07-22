import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { validateRendererBinding } from "./renderer-binding.mjs";
import { runCommand } from "./stack-deployer.mjs";

const DEBUG_PORT = 9222;
const MARKER_PATH = "/opt/compositor/.scorecheck-overlay-exception-gate.json";
const BACKUP_PATH = "/opt/compositor/.scorecheck-overlay-exception-egress.yaml";
const CONFIG_PATH = "/opt/compositor/egress.yaml";
const CONTROL_NAME = "__scorecheckOverlayExceptionGateV1";

export class OverlayExceptionDebugRuntime {
  constructor({ sshKey, knownHosts, runner = runCommand, spawnImpl = spawn, fetchImpl = globalThis.fetch, webSocketFactory = (url) => new WebSocket(url), sleep = delay } = {}) {
    this.sshKey = protectedAbsolute(sshKey, "SSH private key");
    this.knownHosts = protectedAbsolute(knownHosts, "known_hosts path");
    if (typeof runner !== "function" || typeof spawnImpl !== "function" || typeof fetchImpl !== "function" || typeof webSocketFactory !== "function" || typeof sleep !== "function") {
      throw new Error("overlay-exception debug runtime dependency is invalid");
    }
    Object.assign(this, { runner, spawnImpl, fetchImpl, webSocketFactory, sleep });
  }

  plan({ host, event, generationId, camera, renderer, egressConfig }) {
    const binding = validateRendererBinding(renderer);
    const baseline = validateEgressConfig(egressConfig);
    const debug = buildOverlayDebugEgressConfig(baseline);
    return validateDebugTarget({
      schemaVersion: 1,
      host,
      event,
      generationId,
      camera,
      gateId: `overlay-exception-${randomUUID()}`,
      rendererGitSha: binding.gitSha,
      rendererDeploymentId: binding.deploymentId,
      rendererOrigin: binding.origin,
      baselineConfigSha256: sha256(baseline),
      debugConfigSha256: sha256(debug),
      debugConfigBase64: Buffer.from(debug).toString("base64"),
      debugPort: DEBUG_PORT
    });
  }

  async inspect(target) {
    const value = validateDebugTarget(target);
    const result = await this.#ssh(value.host, inspectCommand(value));
    const status = result.stdout.trim();
    if (!new Set(["CLEAN", "PREPARED", "ACTIVE", "COMPLETE", "DIRTY", "UNAVAILABLE"]).has(status)) throw new Error("overlay-exception debug status is invalid");
    return { status, checkedAt: new Date().toISOString() };
  }

  async prepare({ target, confirmation }) {
    const value = validateDebugTarget(target);
    requireConfirmation(confirmation, `PREPARE-OVERLAY-DEBUG:${value.event}:CAMERA-${value.camera}`);
    const before = await this.inspect(value);
    if (before.status === "PREPARED") return { status: "PREPARED", adopted: true, preparedAt: null };
    if (before.status !== "CLEAN") throw new Error(`overlay-exception debug preparation cannot start from ${before.status}`);
    await this.#ssh(value.host, prepareCommand(value));
    const after = await this.inspect(value);
    if (after.status !== "PREPARED") throw new Error(`overlay-exception debug preparation did not converge: ${after.status}`);
    return { status: "PREPARED", adopted: false, preparedAt: new Date().toISOString() };
  }

  async activate({ target, owner, confirmation }) {
    const value = validateDebugTarget(target);
    const binding = validateEgressOwner(owner, value);
    requireConfirmation(confirmation, `ARM-OVERLAY-EXCEPTION:${value.event}:CAMERA-${value.camera}`);
    const before = await this.inspect(value);
    if (before.status !== "PREPARED") throw new Error(`overlay-exception debug activation requires PREPARED, got ${before.status}`);
    const result = await this.#ssh(value.host, activateCommand(value, binding));
    const session = validateDebugSession(JSON.parse(result.stdout));
    const after = await this.inspect(value);
    if (after.status !== "ACTIVE") throw new Error(`overlay-exception debug activation did not converge: ${after.status}`);
    return session;
  }

  async complete({ target }) {
    const value = validateDebugTarget(target);
    const before = await this.inspect(value);
    if (before.status === "COMPLETE") return { status: "COMPLETE", adopted: true, completedAt: null };
    if (before.status !== "ACTIVE") throw new Error(`overlay-exception debug completion requires ACTIVE, got ${before.status}`);
    await this.#ssh(value.host, completeCommand(value));
    const after = await this.inspect(value);
    if (after.status !== "COMPLETE") throw new Error(`overlay-exception debug completion did not converge: ${after.status}`);
    return { status: "COMPLETE", adopted: false, completedAt: new Date().toISOString() };
  }

  async cleanup({ target, confirmation }) {
    const value = validateDebugTarget(target);
    requireConfirmation(confirmation, `CLEANUP-OVERLAY-DEBUG:${value.event}:CAMERA-${value.camera}`);
    const before = await this.inspect(value);
    if (before.status === "CLEAN") return { status: "CLEAN", adopted: true, cleanedAt: null };
    if (!new Set(["PREPARED", "ACTIVE", "COMPLETE", "DIRTY", "UNAVAILABLE"]).has(before.status)) throw new Error(`overlay-exception debug cleanup cannot start from ${before.status}`);
    await this.#ssh(value.host, cleanupCommand(value));
    const after = await this.inspect(value);
    if (after.status !== "CLEAN") throw new Error(`overlay-exception debug cleanup did not converge: ${after.status}`);
    return { status: "CLEAN", adopted: false, cleanedAt: new Date().toISOString() };
  }

  async connect(target, session) {
    const value = validateDebugTarget(target);
    const active = validateDebugSession(session);
    const tunnel = await openSshTunnel({
      host: value.host,
      containerIp: active.containerIp,
      remotePort: value.debugPort,
      sshKey: this.sshKey,
      knownHosts: this.knownHosts,
      spawnImpl: this.spawnImpl,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep
    });
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${tunnel.localPort}/json/list`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
      if (!response.ok) throw new Error(`Chrome debug target list returned HTTP ${response.status}`);
      const pageTarget = selectOverlayCdpTarget(await response.json(), value);
      const socketUrl = localDebugWebSocketUrl(pageTarget.webSocketDebuggerUrl, tunnel.localPort);
      const client = await CdpClient.open(socketUrl, this.webSocketFactory);
      return new OverlayExceptionCdpSession({ client, tunnel, target: value });
    } catch (error) {
      await tunnel.close();
      throw error;
    }
  }

  #ssh(host, command) {
    assertIpv4(host);
    return this.runner("ssh", [
      "-i", this.sshKey,
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ], { timeoutMs: 180_000 });
  }
}

export class OverlayExceptionCdpSession {
  constructor({ client, tunnel, target }) { Object.assign(this, { client, tunnel, target }); }

  async install() {
    const result = await this.client.evaluate(overlayFaultInstallExpression(this.target.camera));
    if (!result?.installed || result.armed || result.throwCount !== 0 || result.interceptCount !== 0) throw new Error("overlay exception control did not install dormant");
    return result;
  }

  async arm(confirmation) {
    requireConfirmation(confirmation, `FAULT-OVERLAY:${this.target.event}:CAMERA-${this.target.camera}`);
    const result = await this.client.evaluate(overlayFaultArmExpression());
    if (!result?.installed || !result.armed) throw new Error("overlay exception control did not arm");
    return { armedAt: new Date().toISOString(), status: result };
  }

  async status() {
    const value = await this.client.evaluate(overlayFaultStatusExpression());
    if (!value?.installed || typeof value.programRootPresent !== "boolean" || typeof value.boardPresent !== "boolean") throw new Error("overlay exception page status is invalid");
    return value;
  }

  async close() {
    await this.client.close().catch(() => {});
    await this.tunnel.close().catch(() => {});
  }
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => this.#message(event));
    socket.addEventListener("close", () => this.#closed(new Error("Chrome debug socket closed")));
    socket.addEventListener("error", () => this.#closed(new Error("Chrome debug socket failed")));
  }

  static async open(url, webSocketFactory) {
    const socket = webSocketFactory(url);
    await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome debug socket timed out")), 5_000);
      const opened = () => { clearTimeout(timer); cleanup(); resolvePromise(); };
      const failed = () => { clearTimeout(timer); cleanup(); reject(new Error("Chrome debug socket could not open")); };
      const cleanup = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", failed);
    });
    return new CdpClient(socket);
  }

  evaluate(expression) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Chrome Runtime.evaluate timed out"));
      }, 10_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    }).then((message) => {
      if (message.error) throw new Error(`Chrome Runtime.evaluate failed: ${safeText(message.error.message)}`);
      if (message.result?.exceptionDetails) throw new Error(`Chrome Runtime.evaluate threw: ${safeText(message.result.exceptionDetails.text)}`);
      return message.result?.result?.value;
    });
  }

  async close() {
    if (this.socket.readyState >= 2) return;
    await new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, 1_000);
      this.socket.addEventListener("close", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
      this.socket.close();
    });
  }

  #message(event) {
    let value;
    try { value = JSON.parse(String(event.data)); } catch { return; }
    if (!Number.isInteger(value.id)) return;
    const pending = this.pending.get(value.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(value.id);
    pending.resolve(value);
  }

  #closed(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function buildOverlayDebugEgressConfig(value) {
  const baseline = validateEgressConfig(value);
  const lines = baseline.trimEnd().split("\n");
  const blocks = lines.flatMap((line, index) => /^chrome_flags\s*:\s*(?:#.*)?$/u.test(line) ? [index] : []);
  if (blocks.length > 1) throw new Error("Egress config defines chrome_flags more than once");
  const debugLines = [
    "  # Isolated overlay-exception rehearsal only. Never deploy as the ordinary config.",
    "  remote-debugging-address: \"0.0.0.0\"",
    `  remote-debugging-port: ${DEBUG_PORT}`
  ];
  if (blocks.length === 0) {
    return `${lines.join("\n")}\n\nchrome_flags:\n${debugLines.join("\n")}\n`;
  }
  const start = blocks[0];
  let end = start + 1;
  while (end < lines.length && /^\s+\S/u.test(lines[end])) end += 1;
  const block = lines.slice(start + 1, end);
  if (block.some((line) => /^\s+remote-debugging-(?:address|port)\s*:/u.test(line))) throw new Error("Egress config already enables remote debugging");
  lines.splice(end, 0, ...debugLines);
  return `${lines.join("\n")}\n`;
}

export function selectOverlayCdpTarget(values, target) {
  const expected = validateDebugTarget(target);
  if (!Array.isArray(values)) throw new Error("Chrome debug target list is invalid");
  const matches = values.filter((entry) => {
    if (entry?.type !== "page" || typeof entry.url !== "string" || typeof entry.webSocketDebuggerUrl !== "string") return false;
    try {
      const url = new URL(entry.url);
      return url.origin === expected.rendererOrigin
        && url.pathname === `/program/court/${expected.camera}`
        && url.searchParams.get("build") === expected.rendererGitSha
        && url.searchParams.get("deployment") === expected.rendererDeploymentId
        && !url.hash;
    } catch { return false; }
  });
  if (matches.length !== 1) throw new Error(`expected exactly one matching Egress Program page, found ${matches.length}`);
  return { webSocketDebuggerUrl: matches[0].webSocketDebuggerUrl };
}

export function overlayFaultInstallExpression(camera) {
  validateCamera(camera);
  return `(() => {
    const name = ${JSON.stringify(CONTROL_NAME)};
    if (globalThis[name]) return globalThis[name].status();
    const originalAt = Array.prototype.at;
    const originalFetch = globalThis.fetch.bind(globalThis);
    const state = { armed: false, throwCount: 0, interceptCount: 0 };
    const isScoreSets = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === "object" && Number.isFinite(Number(item.setNumber)) && Number.isFinite(Number(item.teamAScore)) && Number.isFinite(Number(item.teamBScore)));
    Array.prototype.at = function(index) {
      if (state.armed && index === -1 && isScoreSets(this)) {
        state.throwCount += 1;
        throw new Error("ScoreCheck isolated overlay exception rehearsal");
      }
      return Reflect.apply(originalAt, this, [index]);
    };
    globalThis.fetch = async function(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      let requestUrl = null;
      try { requestUrl = new URL(url, globalThis.location.href); } catch {}
      if (!state.armed || requestUrl?.origin !== globalThis.location.origin || requestUrl.pathname !== ${JSON.stringify(`/api/overlay/court/${camera}/state`)}) return originalFetch(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.delete("if-none-match");
      const response = await originalFetch(input, { ...init, headers, cache: "no-store" });
      if (response.status !== 200) return response;
      const body = await response.clone().json();
      const revision = Math.max(0, Number(body?.projection?.scoreRevision) || 0) + 1;
      const teamAScore = (Math.max(0, Number(body?.score?.teamAScore) || 0) + 1) % 100;
      const teamBScore = Math.max(0, Number(body?.score?.teamBScore) || 0) % 100;
      const sourceTimestamp = new Date().toISOString();
      body.phase = "LIVE";
      body.projection = { ...(body.projection ?? {}), scoreRevision: revision, sourceRevision: String(revision), sourceTimestamp };
      body.score = {
        ...(body.score ?? {}),
        teamAScore,
        teamBScore,
        currentSet: 1,
        setScores: [{ setNumber: 1, teamAScore, teamBScore, isComplete: false }]
      };
      body.health = { ...(body.health ?? {}), lastUpdateAt: sourceTimestamp, lastApiPollAt: sourceTimestamp, apiOnline: true, stale: false };
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete("etag");
      responseHeaders.set("cache-control", "no-store");
      state.interceptCount += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: responseHeaders });
    };
    const status = () => {
      const video = document.querySelector("video");
      return {
        installed: true,
        armed: state.armed,
        throwCount: state.throwCount,
        interceptCount: state.interceptCount,
        programRootPresent: Boolean(document.querySelector(".program-root")),
        boardPresent: Boolean(document.querySelector("[data-scorebug-shape]")),
        video: video ? { paused: video.paused, readyState: video.readyState, currentTime: video.currentTime, width: video.videoWidth, height: video.videoHeight } : null
      };
    };
    Object.defineProperty(globalThis, name, { configurable: false, enumerable: false, writable: false, value: { arm() { state.armed = true; return status(); }, status } });
    return status();
  })()`;
}

export function overlayFaultArmExpression() {
  return `(() => { const control = globalThis[${JSON.stringify(CONTROL_NAME)}]; if (!control) throw new Error("overlay exception control is not installed"); return control.arm(); })()`;
}

export function overlayFaultStatusExpression() {
  return `(() => { const control = globalThis[${JSON.stringify(CONTROL_NAME)}]; return control ? control.status() : { installed: false }; })()`;
}

export function inspectCommand(target) {
  const value = validateDebugTarget(target);
  return [
    "scorecheck_overlay_debug_inspect=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `backup=${shellQuote(BACKUP_PATH)}`,
    `config=${shellQuote(CONFIG_PATH)}`,
    `expected_identity=${shellQuote(markerIdentity(value))}`,
    `baseline_sha=${shellQuote(value.baselineConfigSha256)}`,
    `debug_sha=${shellQuote(value.debugConfigSha256)}`,
    "current_sha=$(sha256sum \"$config\" 2>/dev/null | awk '{print $1}' || true)",
    "if test ! -e \"$marker\" && test ! -L \"$marker\"; then",
    "  if test \"$current_sha\" = \"$baseline_sha\" && test ! -e \"$backup\" && test ! -L \"$backup\"; then echo CLEAN; else echo DIRTY; fi",
    "  exit 0",
    "fi",
    "test -f \"$marker\" && test ! -L \"$marker\" && test -f \"$backup\" && test ! -L \"$backup\" || { echo DIRTY; exit 0; }",
    "test \"$(jq -r '.identity' \"$marker\")\" = \"$expected_identity\" || { echo DIRTY; exit 0; }",
    "test \"$(sha256sum \"$backup\" | awk '{print $1}')\" = \"$baseline_sha\" || { echo DIRTY; exit 0; }",
    "phase=$(jq -r '.phase' \"$marker\")",
    "if test \"$phase\" = PREPARING; then echo DIRTY; exit 0; fi",
    "container_id=$(jq -r '.containerId' \"$marker\")",
    "current_id=$(docker inspect bvm-egress --format '{{.Id}}' 2>/dev/null || true)",
    "healthy=$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)",
    "test \"$current_id\" = \"$container_id\" && test \"$healthy\" = healthy || { echo UNAVAILABLE; exit 0; }",
    "case \"$phase:$current_sha\" in",
    "  PREPARED:$debug_sha) echo PREPARED ;;",
    "  ACTIVE:$baseline_sha) echo ACTIVE ;;",
    "  COMPLETE:$baseline_sha) echo COMPLETE ;;",
    "  *) echo DIRTY ;;",
    "esac"
  ].join("\n");
}

export function prepareCommand(target) {
  const value = validateDebugTarget(target);
  return [
    "scorecheck_overlay_debug_prepare=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `backup=${shellQuote(BACKUP_PATH)}`,
    `config=${shellQuote(CONFIG_PATH)}`,
    `expected_identity=${shellQuote(markerIdentity(value))}`,
    `baseline_sha=${shellQuote(value.baselineConfigSha256)}`,
    `debug_sha=${shellQuote(value.debugConfigSha256)}`,
    `debug_base64=${shellQuote(value.debugConfigBase64)}`,
    "test ! -e \"$marker\" && test ! -L \"$marker\" && test ! -e \"$backup\" && test ! -L \"$backup\"",
    "test -f \"$config\" && test ! -L \"$config\"",
    "test \"$(sha256sum \"$config\" | awk '{print $1}')\" = \"$baseline_sha\"",
    "active_json=$(./list-egress.sh --active --json)",
    "active_count=$(printf '%s' \"$active_json\" | jq -r 'if . == null then 0 elif type == \"array\" then length else -1 end')",
    "test \"$active_count\" -eq 0",
    "umask 077",
    "cp \"$config\" \"$backup\"",
    "jq -nc --arg identity \"$expected_identity\" --arg phase PREPARING --arg baselineSha \"$baseline_sha\" --arg debugSha \"$debug_sha\" --arg preparedAt \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" '{schemaVersion:1,identity:$identity,phase:$phase,containerId:\"\",baselineConfigSha256:$baselineSha,debugConfigSha256:$debugSha,preparedAt:$preparedAt}' > \"$marker\"",
    "chmod 600 \"$marker\"",
    "temporary=$(mktemp /opt/compositor/.egress-overlay-debug.XXXXXX)",
    "printf '%s' \"$debug_base64\" | base64 -d > \"$temporary\"",
    "test \"$(sha256sum \"$temporary\" | awk '{print $1}')\" = \"$debug_sha\"",
    "chmod --reference=\"$config\" \"$temporary\"",
    "mv \"$temporary\" \"$config\"",
    "docker compose up -d --force-recreate egress >/dev/null",
    "attempt=0; while test \"$attempt\" -lt 60; do healthy=$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true); test \"$healthy\" = healthy && break; attempt=$((attempt + 1)); sleep 2; done",
    "test \"$healthy\" = healthy",
    "container_id=$(docker inspect bvm-egress --format '{{.Id}}')",
    "updated=$(mktemp /opt/compositor/.overlay-marker.XXXXXX)",
    "jq --arg phase PREPARED --arg containerId \"$container_id\" '.phase=$phase | .containerId=$containerId' \"$marker\" > \"$updated\"",
    "chmod 600 \"$updated\"; mv \"$updated\" \"$marker\""
  ].join("\n");
}

export function activateCommand(target, owner) {
  const value = validateDebugTarget(target);
  const binding = validateEgressOwner(owner, value);
  return [
    "scorecheck_overlay_debug_activate=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `backup=${shellQuote(BACKUP_PATH)}`,
    `config=${shellQuote(CONFIG_PATH)}`,
    `expected_identity=${shellQuote(markerIdentity(value))}`,
    `baseline_sha=${shellQuote(value.baselineConfigSha256)}`,
    `debug_sha=${shellQuote(value.debugConfigSha256)}`,
    `owner=${shellQuote(`requests/court-${value.camera}.owner.json`)}`,
    "test -f \"$marker\" && test ! -L \"$marker\" && test -f \"$backup\" && test ! -L \"$backup\"",
    "test \"$(jq -r '.identity' \"$marker\")\" = \"$expected_identity\" && test \"$(jq -r '.phase' \"$marker\")\" = PREPARED",
    "test \"$(sha256sum \"$config\" | awk '{print $1}')\" = \"$debug_sha\" && test \"$(sha256sum \"$backup\" | awk '{print $1}')\" = \"$baseline_sha\"",
    "test -f \"$owner\" && test ! -L \"$owner\"",
    `test "$(jq -r '.event' "$owner")" = ${shellQuote(binding.event)}`,
    `test "$(jq -r '.court' "$owner")" = ${shellQuote(String(binding.camera))}`,
    `test "$(jq -r '.rendererGitSha' "$owner")" = ${shellQuote(binding.rendererGitSha)}`,
    `test "$(jq -r '.rendererDeploymentId' "$owner")" = ${shellQuote(binding.rendererDeploymentId)}`,
    `test "$(jq -r '.egressId' "$owner")" = ${shellQuote(binding.egressId)}`,
    `test "$(jq -r '.destinationId' "$owner")" = ${shellQuote(binding.destinationId)}`,
    `test "$(jq -r '.outputGeneration' "$owner")" = ${shellQuote(binding.outputGeneration)}`,
    "active_json=$(./list-egress.sh --active --json)",
    `test "$(printf '%s' "$active_json" | jq -r --arg id ${shellQuote(binding.egressId)} 'if type == "array" and length == 1 and .[0].egress_id == $id then "yes" else "no" end')" = yes`,
    "container_id=$(docker inspect bvm-egress --format '{{.Id}}')",
    "test \"$container_id\" = \"$(jq -r '.containerId' \"$marker\")\"",
    "container_ips=$(docker inspect bvm-egress --format '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{.IPAddress}} {{end}}{{end}}')",
    "set -- $container_ips; test \"$#\" -eq 1; container_ip=$1",
    `curl -fsS --max-time 3 "http://$container_ip:${value.debugPort}/json/version" >/dev/null`,
    "temporary=$(mktemp /opt/compositor/.egress-overlay-restore.XXXXXX)",
    "cp \"$backup\" \"$temporary\"",
    "chmod --reference=\"$config\" \"$temporary\"",
    "mv \"$temporary\" \"$config\"",
    "test \"$(sha256sum \"$config\" | awk '{print $1}')\" = \"$baseline_sha\"",
    "updated=$(mktemp /opt/compositor/.overlay-marker.XXXXXX)",
    `jq --arg phase ACTIVE --arg containerIp "$container_ip" --arg egressId ${shellQuote(binding.egressId)} --arg destinationId ${shellQuote(binding.destinationId)} --arg outputGeneration ${shellQuote(binding.outputGeneration)} --arg activatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.phase=$phase | .containerIp=$containerIp | .egressId=$egressId | .destinationId=$destinationId | .outputGeneration=$outputGeneration | .activatedAt=$activatedAt' "$marker" > "$updated"`,
    "chmod 600 \"$updated\"; mv \"$updated\" \"$marker\"",
    `jq -nc --arg containerId "$container_id" --arg containerIp "$container_ip" --arg egressId ${shellQuote(binding.egressId)} '{schemaVersion:1,containerId:$containerId,containerIp:$containerIp,egressId:$egressId,activatedAt:(now|todateiso8601)}'`
  ].join("\n");
}

export function completeCommand(target) {
  const value = validateDebugTarget(target);
  return [
    "scorecheck_overlay_debug_complete=1",
    "set -eu",
    `marker=${shellQuote(MARKER_PATH)}`,
    `expected_identity=${shellQuote(markerIdentity(value))}`,
    "test -f \"$marker\" && test ! -L \"$marker\"",
    "test \"$(jq -r '.identity' \"$marker\")\" = \"$expected_identity\" && test \"$(jq -r '.phase' \"$marker\")\" = ACTIVE",
    "updated=$(mktemp /opt/compositor/.overlay-marker.XXXXXX)",
    "jq --arg phase COMPLETE --arg completedAt \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" '.phase=$phase | .completedAt=$completedAt' \"$marker\" > \"$updated\"",
    "chmod 600 \"$updated\"; mv \"$updated\" \"$marker\""
  ].join("\n");
}

export function cleanupCommand(target) {
  const value = validateDebugTarget(target);
  return [
    "scorecheck_overlay_debug_cleanup=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `backup=${shellQuote(BACKUP_PATH)}`,
    `config=${shellQuote(CONFIG_PATH)}`,
    `expected_identity=${shellQuote(markerIdentity(value))}`,
    `baseline_sha=${shellQuote(value.baselineConfigSha256)}`,
    `debug_sha=${shellQuote(value.debugConfigSha256)}`,
    "test -f \"$marker\" && test ! -L \"$marker\" && test -f \"$backup\" && test ! -L \"$backup\" && test \"$(jq -r '.identity' \"$marker\")\" = \"$expected_identity\"",
    "active_json=$(./list-egress.sh --active --json)",
    "active_count=$(printf '%s' \"$active_json\" | jq -r 'if . == null then 0 elif type == \"array\" then length else -1 end')",
    "test \"$active_count\" -eq 0",
    "current_sha=$(sha256sum \"$config\" | awk '{print $1}')",
    "if test \"$current_sha\" = \"$debug_sha\"; then temporary=$(mktemp /opt/compositor/.egress-overlay-cleanup.XXXXXX); cp \"$backup\" \"$temporary\"; chmod --reference=\"$config\" \"$temporary\"; mv \"$temporary\" \"$config\"; fi",
    "test \"$(sha256sum \"$config\" | awk '{print $1}')\" = \"$baseline_sha\"",
    "docker compose up -d --force-recreate egress >/dev/null",
    "attempt=0; while test \"$attempt\" -lt 60; do healthy=$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true); test \"$healthy\" = healthy && break; attempt=$((attempt + 1)); sleep 2; done",
    "test \"$healthy\" = healthy",
    "container_ips=$(docker inspect bvm-egress --format '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{.IPAddress}} {{end}}{{end}}')",
    "set -- $container_ips; test \"$#\" -eq 1; container_ip=$1",
    `! curl -fsS --max-time 1 "http://$container_ip:${value.debugPort}/json/version" >/dev/null 2>&1`,
    "rm -f \"$marker\" \"$backup\""
  ].join("\n");
}

export function validateDebugTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) throw new Error("overlay-exception debug target schema is invalid");
  assertIpv4(value.host);
  if (typeof value.event !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{2,79}$/u.test(value.event)) throw new Error("overlay-exception event is invalid");
  if (typeof value.generationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(value.generationId)) throw new Error("overlay-exception generation is invalid");
  validateCamera(value.camera);
  if (typeof value.gateId !== "string" || !/^overlay-exception-[0-9a-f-]{36}$/u.test(value.gateId)) throw new Error("overlay-exception gate id is invalid");
  if (!/^[a-f0-9]{40}$/u.test(value.rendererGitSha ?? "") || !/^dpl_[A-Za-z0-9]+$/u.test(value.rendererDeploymentId ?? "")) throw new Error("overlay-exception renderer identity is invalid");
  const origin = new URL(value.rendererOrigin);
  if (origin.protocol !== "https:" || !origin.hostname.endsWith(".vercel.app") || origin.origin !== value.rendererOrigin) throw new Error("overlay-exception renderer origin must be immutable Vercel HTTPS");
  for (const field of ["baselineConfigSha256", "debugConfigSha256"]) if (!/^[a-f0-9]{64}$/u.test(value[field] ?? "")) throw new Error(`overlay-exception ${field} is invalid`);
  if (value.baselineConfigSha256 === value.debugConfigSha256) throw new Error("overlay-exception debug config must differ from baseline");
  if (typeof value.debugConfigBase64 !== "string" || value.debugConfigBase64.length < 100 || !/^[A-Za-z0-9+/=]+$/u.test(value.debugConfigBase64)) throw new Error("overlay-exception debug config is invalid");
  const decoded = Buffer.from(value.debugConfigBase64, "base64").toString("utf8");
  if (sha256(decoded) !== value.debugConfigSha256 || !decoded.includes(`remote-debugging-port: ${DEBUG_PORT}`)) throw new Error("overlay-exception debug config digest is invalid");
  if (value.debugPort !== DEBUG_PORT) throw new Error("overlay-exception debug port is invalid");
  return { ...value };
}

export function validateEgressOwner(value, target) {
  const expected = validateDebugTarget(target);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("overlay-exception Egress owner is invalid");
  const result = {
    event: value.event,
    camera: value.camera,
    rendererGitSha: value.rendererGitSha,
    rendererDeploymentId: value.rendererDeploymentId,
    egressId: value.egressId,
    destinationId: value.destinationId,
    outputGeneration: value.outputGeneration
  };
  if (result.event !== expected.event || result.camera !== expected.camera || result.rendererGitSha !== expected.rendererGitSha || result.rendererDeploymentId !== expected.rendererDeploymentId) throw new Error("overlay-exception Egress owner does not match the target");
  if (!/^EG_[A-Za-z0-9]+$/u.test(result.egressId ?? "")) throw new Error("overlay-exception Egress id is invalid");
  for (const field of ["destinationId", "outputGeneration"]) if (typeof result[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(result[field])) throw new Error(`overlay-exception ${field} is invalid`);
  return result;
}

function validateDebugSession(value) {
  if (!value || value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(value.containerId ?? "") || !/^EG_[A-Za-z0-9]+$/u.test(value.egressId ?? "") || !Number.isFinite(Date.parse(value.activatedAt))) throw new Error("overlay-exception debug session is invalid");
  assertIpv4(value.containerIp);
  return { schemaVersion: 1, containerId: value.containerId, containerIp: value.containerIp, egressId: value.egressId, activatedAt: value.activatedAt };
}

async function openSshTunnel({ host, containerIp, remotePort, sshKey, knownHosts, spawnImpl, fetchImpl, sleep }) {
  assertIpv4(host);
  assertIpv4(containerIp);
  const localPort = await availableLoopbackPort();
  const child = spawnImpl("ssh", [
    "-N", "-T",
    "-i", sshKey,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-L", `127.0.0.1:${localPort}:${containerIp}:${remotePort}`,
    `root@${host}`
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  let exited = null;
  child.once("exit", (code) => { exited = code; });
  child.once("error", () => { exited = -1; });
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    if (exited !== null) throw new Error(`SSH debug tunnel exited before readiness (${String(exited)}): ${safeText(stderr)}`);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${localPort}/json/version`, { signal: AbortSignal.timeout(500), cache: "no-store" });
      if (response.ok) return { localPort, close: () => closeChild(child) };
    } catch {}
    await sleep(100);
  }
  child.kill("SIGTERM");
  throw new Error("SSH debug tunnel did not become ready");
}

function availableLoopbackPort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

function closeChild(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise(); }, 1_000);
    child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
    child.kill("SIGTERM");
  });
}

function localDebugWebSocketUrl(value, port) {
  const url = new URL(value);
  if (url.protocol !== "ws:" || !url.pathname.startsWith("/devtools/page/")) throw new Error("Chrome page debug URL is invalid");
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.href;
}

function validateEgressConfig(value) {
  if (typeof value !== "string" || value.length < 100 || /\0/u.test(value) || !/^ws_url\s*:/mu.test(value) || !/^redis\s*:/mu.test(value)) throw new Error("Egress config is invalid");
  return value;
}

function markerIdentity(target) {
  return [target.event, target.generationId, target.camera, target.gateId, target.rendererGitSha, target.rendererDeploymentId, target.rendererOrigin, target.baselineConfigSha256, target.debugConfigSha256].join(":");
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requireConfirmation(actual, expected) { if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`); }
function validateCamera(value) { if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error("overlay-exception camera must be 1-8"); }
function safeText(value) { return String(value ?? "").replace(/[\r\n\0]+/gu, " ").slice(0, 240); }
function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }

function assertIpv4(value) {
  const parts = typeof value === "string" ? value.split(".").map(Number) : [];
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error("overlay-exception IPv4 address is invalid");
}

function protectedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}
