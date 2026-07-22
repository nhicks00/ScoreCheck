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

  async ensureStarted({ host, court, profile = "1080p30", expectedId = null }) {
    validateCourt(court);
    validateProfile(profile);
    if (expectedId !== null) validateEgressId(expectedId);
    let active = await this.listActive(host);
    if (active.length > 1) throw new Error(`compositor ${host} admitted multiple active Egress jobs`);
    if (active.length === 1) {
      if (expectedId && active[0].id !== expectedId) throw new Error(`compositor ${host} active Egress id changed`);
      return { ...active[0], adopted: true };
    }
    if (expectedId) throw new Error(`expected Egress ${expectedId} is absent from compositor ${host}`);
    const result = await this.#remote(host, `cd /opt/compositor && ./start-court.sh ${court} ${profile}`);
    const ids = [...new Set(result.stdout.match(/EG_[a-zA-Z0-9]+/g) ?? [])];
    if (ids.length !== 1) throw new Error(`compositor ${host} start did not return exactly one Egress id`);
    const id = ids[0];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      active = await this.listActive(host);
      if (active.length > 1) throw new Error(`compositor ${host} admitted multiple active Egress jobs`);
      if (active.length === 1 && active[0].id === id) return { ...active[0], adopted: false };
      await this.sleep(1_000);
    }
    throw new Error(`Egress ${id} did not become active on compositor ${host}`);
  }

  async proveSecondStartRejected({ host, court, profile = "1080p30", expectedId }) {
    validateCourt(court);
    validateProfile(profile);
    validateEgressId(expectedId);
    const attempt = await this.#remote(host, `cd /opt/compositor && ./start-court.sh ${court} ${profile}`, { allowFailure: true });
    if (attempt.code === 0) throw new Error(`compositor ${host} accepted a second Egress start`);
    const active = await this.listActive(host);
    if (active.length !== 1 || active[0].id !== expectedId) throw new Error(`compositor ${host} admission rejection changed the active Egress set`);
    return { rejected: true, activeId: expectedId };
  }

  async stopExact({ host, court, egressId }) {
    validateCourt(court);
    validateEgressId(egressId);
    const before = await this.listActive(host);
    if (!before.some((entry) => entry.id === egressId)) {
      if (before.length === 0) return { absent: true };
      throw new Error(`compositor ${host} has an unexpected active Egress while ${egressId} is absent`);
    }
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

function validateCourt(court) {
  if (!Number.isInteger(court) || court < 1 || court > 8) throw new Error("Egress court must be from 1 through 8");
}

function validateProfile(value) {
  if (!new Set(["1080p30", "1080p60"]).has(value)) throw new Error("Egress output profile is invalid");
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
