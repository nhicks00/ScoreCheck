import { isAbsolute, resolve } from "node:path";

import { runCommand } from "./stack-deployer.mjs";

const MARKER_PATH = "/opt/mediamtx/.scorecheck-ingest-recovery-rehearsal-fault";

export class IngestRecoveryFaultRuntime {
  constructor({ sshKey, knownHosts, runner = runCommand } = {}) {
    this.sshKey = protectedAbsolute(sshKey, "SSH private key");
    this.knownHosts = protectedAbsolute(knownHosts, "known_hosts path");
    if (typeof runner !== "function") throw new Error("ingest recovery fault runner is invalid");
    this.runner = runner;
  }

  async inspect({ host, event, recoveryId }) {
    const identity = faultIdentity(event, recoveryId);
    const result = await this.#ssh(host, inspectCommand(identity));
    const status = result.stdout.trim();
    if (!new Set(["HEALTHY", "FAULTED", "MARKED_RUNNING", "UNOWNED_DOWN"]).has(status)) throw new Error("primary ingest fault status is invalid");
    return { status, host, event, recoveryId };
  }

  async inject({ host, event, recoveryId, confirmation }) {
    requireConfirmation(confirmation, `FAULT-PRIMARY-INGEST:${event}`);
    const before = await this.inspect({ host, event, recoveryId });
    if (before.status === "FAULTED") return { status: "FAULTED", adopted: true, injectedAt: null };
    if (!new Set(["HEALTHY", "MARKED_RUNNING"]).has(before.status)) throw new Error(`primary ingest cannot be faulted from ${before.status}`);
    const identity = faultIdentity(event, recoveryId);
    await this.#ssh(host, injectCommand(identity));
    const after = await this.inspect({ host, event, recoveryId });
    if (after.status !== "FAULTED") throw new Error("primary ingest fault did not converge");
    return { status: after.status, adopted: false, injectedAt: new Date().toISOString() };
  }

  async restore({ host, event, recoveryId, confirmation }) {
    requireConfirmation(confirmation, `RESTORE-PRIMARY-INGEST:${event}`);
    const before = await this.inspect({ host, event, recoveryId });
    if (before.status === "HEALTHY") return { status: "HEALTHY", adopted: true, restoredAt: null };
    if (!new Set(["FAULTED", "MARKED_RUNNING"]).has(before.status)) throw new Error(`primary ingest cannot be restored from ${before.status}`);
    const identity = faultIdentity(event, recoveryId);
    await this.#ssh(host, restoreCommand(identity));
    const after = await this.inspect({ host, event, recoveryId });
    if (after.status !== "HEALTHY") throw new Error("primary ingest restoration did not converge");
    return { status: after.status, adopted: false, restoredAt: new Date().toISOString() };
  }

  async #ssh(host, command) {
    assertIpv4(host);
    return this.runner("ssh", [
      "-i", this.sshKey,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ]);
  }
}

export function inspectCommand(identity) {
  const quoted = shellQuote(identity);
  return `cd /opt/mediamtx && expected=${quoted} && marker=\"${MARKER_PATH}\" && mediamtx=\"$(docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null || true)\" && caddy=\"$(docker inspect bvm-mediamtx-caddy --format '{{.State.Running}}' 2>/dev/null || true)\" && if test -e \"$marker\"; then test -f \"$marker\" && test ! -L \"$marker\" && test \"$(cat \"$marker\")\" = \"$expected\" || { echo DRIFT; exit 1; }; if test \"$mediamtx\" != true && test \"$caddy\" != true; then echo FAULTED; else echo MARKED_RUNNING; fi; elif test \"$mediamtx\" = true && test \"$caddy\" = true && curl -fsS http://127.0.0.1:9997/v3/config/global/get >/dev/null; then echo HEALTHY; else echo UNOWNED_DOWN; fi`;
}

export function injectCommand(identity) {
  const quoted = shellQuote(identity);
  return `cd /opt/mediamtx && expected=${quoted} && marker="${MARKER_PATH}" && if test -e "$marker"; then test -f "$marker" && test ! -L "$marker" && test "$(cat "$marker")" = "$expected"; else test "$(docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null || true)" = true && test "$(docker inspect bvm-mediamtx-caddy --format '{{.State.Running}}' 2>/dev/null || true)" = true && umask 077 && printf '%s\\n' "$expected" > "$marker"; fi && docker compose stop caddy mediamtx && test "$(docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null || true)" != true && test "$(docker inspect bvm-mediamtx-caddy --format '{{.State.Running}}' 2>/dev/null || true)" != true`;
}

export function restoreCommand(identity) {
  const quoted = shellQuote(identity);
  return `cd /opt/mediamtx && test -f ${MARKER_PATH} && test ! -L ${MARKER_PATH} && test \"$(cat ${MARKER_PATH})\" = ${quoted} && docker compose up -d mediamtx caddy && for attempt in $(seq 1 120); do if test \"$(docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null || true)\" = true && test \"$(docker inspect bvm-mediamtx-caddy --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)\" = healthy && curl -fsS http://127.0.0.1:9997/v3/config/global/get >/dev/null; then rm -f ${MARKER_PATH}; exit 0; fi; sleep 1; done; exit 1`;
}

function faultIdentity(event, recoveryId) {
  if (typeof event !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{2,79}$/.test(event)) throw new Error("ingest recovery fault event is invalid");
  if (typeof recoveryId !== "string" || !/^[A-Za-z0-9-]{8,80}$/.test(recoveryId)) throw new Error("ingest recovery fault id is invalid");
  return `${event}:${recoveryId}`;
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`);
}

function assertIpv4(value) {
  const parts = typeof value === "string" ? value.split(".").map(Number) : [];
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error("ingest recovery fault host is invalid");
}

function protectedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
