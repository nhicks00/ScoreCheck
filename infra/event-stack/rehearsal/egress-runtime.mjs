import { spawn } from "node:child_process";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isRetryableDeploymentTransportError } from "../stack-deployer.mjs";

const EGRESS_ID = /^EG_[a-zA-Z0-9]+$/;

export class EgressRuntime {
  constructor({ sshKey, knownHosts, runner = runCommand, sleep = delay }) {
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.runner = runner;
    this.sleep = sleep;
  }

  async listActive(host) {
    const result = await this.#remote(host, "cd /opt/compositor && ./list-egress.sh --active --json", { retrySafe: true });
    return parseActiveEgress(result.stdout);
  }

  async preflight(host) {
    const active = await this.listActive(host);
    if (active.length !== 0) throw new Error(`compositor ${host} is not idle before rehearsal admission`);
    const result = await this.#remote(host, "test \"$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')\" = healthy && curl -fsS http://127.0.0.1:9090/metrics >/dev/null", { retrySafe: true });
    if (result.code !== 0) throw new Error(`compositor ${host} failed Egress preflight`);
    return { healthy: true, active: 0 };
  }

  async readOwnership(host, court) {
    validateCourt(court);
    const path = `requests/court-${court}`;
    const command = `cd /opt/compositor && test "$(openssl dgst -sha256 -r ${path}.json | awk '{print $1}')" = "$(jq -r .requestSha256 ${path}.owner.json)" && cat ${path}.owner.json`;
    let result;
    try {
      result = await this.#remote(host, command, { retrySafe: true });
    } catch (error) {
      throw new Error(`compositor ${host} has no verifiable Egress ownership for Camera ${court}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return parseEgressOwnership(result.stdout);
  }

  async reconcileOwned({ host, court, profile = "1080p30", owner, expectedId = null }) {
    validateCourt(court);
    validateProfile(profile);
    const expectedOwner = validateExpectedOwner(owner);
    if (expectedId !== null) validateEgressId(expectedId);
    const active = await this.listActive(host);
    if (active.length !== 1) throw new Error(`compositor ${host} must have exactly one active Egress for owned reconciliation`);
    if (expectedId && active[0].id !== expectedId) throw new Error(`compositor ${host} active Egress id changed`);
    const recorded = await this.readOwnership(host, court);
    const expected = { ...expectedOwner, court, outputProfile: profile, egressId: active[0].id };
    for (const [key, value] of Object.entries(expected)) {
      if (recorded[key] !== value) throw new Error(`compositor ${host} Egress ownership ${key} changed`);
    }
    return { ...active[0], owner: recorded };
  }

  async ensureStarted({ host, court, profile = "1080p30", owner, expectedId = null }) {
    validateCourt(court);
    validateProfile(profile);
    const expectedOwner = validateExpectedOwner(owner);
    if (expectedId !== null) validateEgressId(expectedId);
    let active = await this.listActive(host);
    if (active.length > 1) throw new Error(`compositor ${host} admitted multiple active Egress jobs`);
    if (active.length === 1) {
      return { ...await this.reconcileOwned({ host, court, profile, owner: expectedOwner, expectedId }), adopted: true };
    }
    if (expectedId) throw new Error(`expected Egress ${expectedId} is absent from compositor ${host}`);
    const result = await this.#remote(host, `cd /opt/compositor && ./start-court.sh ${court} ${profile} ${expectedOwner.event} ${expectedOwner.destinationId} ${expectedOwner.outputGeneration} ${expectedOwner.destinationRole}`);
    const ids = [...new Set(result.stdout.match(/EG_[a-zA-Z0-9]+/g) ?? [])];
    if (ids.length !== 1) throw new Error(`compositor ${host} start did not return exactly one Egress id`);
    const id = ids[0];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      active = await this.listActive(host);
      if (active.length > 1) throw new Error(`compositor ${host} admitted multiple active Egress jobs`);
      if (active.length === 1 && active[0].id === id) {
        return { ...await this.reconcileOwned({ host, court, profile, owner: expectedOwner, expectedId: id }), adopted: false };
      }
      await this.sleep(1_000);
    }
    throw new Error(`Egress ${id} did not become active on compositor ${host}`);
  }

  async proveSecondStartRejected({ host, court, profile = "1080p30", owner, expectedId }) {
    validateCourt(court);
    validateProfile(profile);
    const expectedOwner = validateExpectedOwner(owner);
    validateEgressId(expectedId);
    const attempt = await this.#remote(host, `cd /opt/compositor && ./start-court.sh ${court} ${profile} ${expectedOwner.event} ${expectedOwner.destinationId} ${expectedOwner.outputGeneration} ${expectedOwner.destinationRole}`, { allowFailure: true });
    if (attempt.code === 0) throw new Error(`compositor ${host} accepted a second Egress start`);
    await this.reconcileOwned({ host, court, profile, owner: expectedOwner, expectedId });
    return { rejected: true, activeId: expectedId };
  }

  async stopExact({ host, court, egressId, profile = null, owner = null }) {
    validateCourt(court);
    validateEgressId(egressId);
    const before = await this.listActive(host);
    if (!before.some((entry) => entry.id === egressId)) {
      if (before.length === 0) return { absent: true };
      throw new Error(`compositor ${host} has an unexpected active Egress while ${egressId} is absent`);
    }
    if (owner !== null) await this.reconcileOwned({ host, court, profile, owner, expectedId: egressId });
    await this.#remote(host, `cd /opt/compositor && ./stop-court.sh ${court} ${egressId}`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const active = await this.listActive(host);
      if (!active.some((entry) => entry.id === egressId)) {
        if (active.length !== 0) throw new Error(`compositor ${host} retained an unexpected Egress after cleanup`);
        return { absent: true };
      }
      await this.sleep(1_000);
    }
    throw new Error(`Egress ${egressId} did not stop on compositor ${host}`);
  }

  async restartOwned({ host, court, profile = "1080p30", owner, egressId }) {
    validateExpectedOwner(owner);
    await this.reconcileOwned({ host, court, profile, owner, expectedId: egressId });
    await this.stopExact({ host, court, egressId, profile, owner });
    return this.ensureStarted({ host, court, profile, owner });
  }

  async #remote(host, command, options = {}) {
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host ?? "")) throw new Error("compositor SSH host must be an IPv4 address");
    const args = [
      "-i", this.sshKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ];
    const attempts = options.retrySafe === true ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.runner("ssh", args, { allowFailure: options.allowFailure === true });
      } catch (error) {
        if (attempt === attempts || !isRetryableDeploymentTransportError(error)) throw error;
        await this.sleep(attempt * 2_000);
      }
    }
    throw new Error("Egress SSH retry loop exited unexpectedly");
  }
}

export function parseActiveEgress(raw) {
  let value;
  try { value = JSON.parse(raw.trim() || "null"); } catch { throw new Error("Egress active-list response is invalid JSON"); }
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error("Egress active-list response must be an array or null");
  const ids = new Set();
  return value.map((entry) => {
    const id = entry?.egress_id;
    validateEgressId(id);
    if (ids.has(id)) throw new Error("Egress active-list response contains duplicate ids");
    ids.add(id);
    const status = entry.status ?? null;
    if (status !== null && !Number.isInteger(status) && typeof status !== "string") throw new Error("Egress active-list status is invalid");
    return { id, status, startedAt: entry.started_at ?? null, updatedAt: entry.updated_at ?? null, error: entry.error || null };
  });
}

export function parseEgressOwnership(raw) {
  let value;
  try { value = JSON.parse(raw.trim()); } catch { throw new Error("Egress ownership is invalid JSON"); }
  if (!value || value.schemaVersion !== 2 || !Number.isInteger(value.court) || value.court < 1 || value.court > 8) throw new Error("Egress ownership is invalid");
  validateIdentifier(value.event, "event");
  validateIdentifier(value.destinationId, "destination id");
  validateDestinationRole(value.destinationRole);
  validateIdentifier(value.outputGeneration, "output generation");
  validateProfile(value.outputProfile);
  if (!/^[a-f0-9]{40}$/.test(value.rendererGitSha ?? "")) throw new Error("Egress ownership renderer Git SHA is invalid");
  if (!/^dpl_[A-Za-z0-9]+$/.test(value.rendererDeploymentId ?? "")) throw new Error("Egress ownership renderer deployment id is invalid");
  validateEgressId(value.egressId);
  if (!/^[a-f0-9]{64}$/.test(value.requestSha256 ?? "")) throw new Error("Egress ownership request digest is invalid");
  if (!Number.isFinite(Date.parse(value.startedAt ?? ""))) throw new Error("Egress ownership start timestamp is invalid");
  return value;
}

function validateCourt(court) {
  if (!Number.isInteger(court) || court < 1 || court > 8) throw new Error("Egress court must be from 1 through 8");
}

function validateProfile(value) {
  if (!new Set(["1080p30", "1080p60"]).has(value)) throw new Error("Egress output profile is invalid");
}

function validateExpectedOwner(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Egress owner is required");
  validateIdentifier(value.event, "event");
  validateIdentifier(value.destinationId, "destination id");
  validateDestinationRole(value.destinationRole);
  validateIdentifier(value.outputGeneration, "output generation");
  if (!/^[a-f0-9]{40}$/.test(value.rendererGitSha ?? "")) throw new Error("Egress owner renderer Git SHA is invalid");
  if (!/^dpl_[A-Za-z0-9]+$/.test(value.rendererDeploymentId ?? "")) throw new Error("Egress owner renderer deployment id is invalid");
  return {
    event: value.event,
    destinationId: value.destinationId,
    destinationRole: value.destinationRole,
    outputGeneration: value.outputGeneration,
    rendererGitSha: value.rendererGitSha,
    rendererDeploymentId: value.rendererDeploymentId
  };
}

function validateDestinationRole(value) {
  if (!new Set(["primary", "backup"]).has(value)) throw new Error("Egress destination role is invalid");
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{3,128}$/.test(value)) throw new Error(`Egress ${label} is invalid`);
}

function validateEgressId(value) {
  if (typeof value !== "string" || !EGRESS_ID.test(value)) throw new Error("Egress id is invalid");
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

async function runCommand(command, args, { allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolvePromise({ code, stdout, stderr });
      else {
        const tail = stderr.trim().slice(-500);
        reject(new Error(`${basename(command)} failed with exit ${code}${tail ? `: ${tail}` : ""}`));
      }
    });
  });
}
