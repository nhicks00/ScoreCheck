#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const STATE_SCHEMA_VERSION = 1;
const ANCHOR_SCHEMA_VERSION = 1;
const PHASES = new Set(["planned", "provisioning", "ready", "live", "closed", "destroying", "destroyed"]);
const SHA256 = /^[a-f0-9]{64}$/;

export class EventLifecycleController {
  constructor({ store, cloud, dns, deployer, notifier = new NullNotifier(), now = () => new Date() }) {
    this.store = store;
    this.cloud = cloud;
    this.dns = dns;
    this.deployer = deployer;
    this.notifier = notifier;
    this.now = now;
  }

  async plan(manifest) {
    return this.store.withLock(async () => {
      const current = await this.store.load();
      if (current) {
        assertStateMatchesManifest(current, manifest);
        return current;
      }
      const state = createInitialState(manifest, this.now());
      await this.store.save(state);
      return state;
    });
  }

  async up(manifest, anchors) {
    validateAnchorConfig(anchors, manifest);
    return this.store.withLock(async () => {
      let state = await this.store.load();
      if (!state) state = createInitialState(manifest, this.now());
      assertStateMatchesManifest(state, manifest);
      assertPhase(state, ["planned", "provisioning"], "provision");
      state.phase = "provisioning";
      state.lastError = null;
      await this.store.save(state);

      try {
        const account = await this.cloud.getAccount();
        if (account.status !== "active") throw new Error(`DigitalOcean account is ${account.status}, not active`);
        if (!Number.isInteger(account.dropletLimit) || account.dropletLimit < manifest.provider.minimumAccountDropletLimit) {
          throw new Error(`DigitalOcean Droplet limit ${account.dropletLimit} is below required ${manifest.provider.minimumAccountDropletLimit}`);
        }
        const [allDroplets, currentEventDroplets] = await Promise.all([
          this.cloud.listAllDroplets(),
          this.cloud.listDropletsByEvent(manifest.event)
        ]);
        const currentNames = currentEventDroplets.map((entry) => entry.name);
        if (new Set(currentNames).size !== currentNames.length) throw new Error("current event inventory contains duplicate names");
        const expectedNames = new Set(manifest.droplets.map((entry) => entry.name));
        const unexpectedNames = currentNames.filter((name) => !expectedNames.has(name));
        if (unexpectedNames.length) throw new Error(`current event inventory contains unexpected resources: ${unexpectedNames.join(",")}`);
        const missingResources = manifest.droplets.length - currentEventDroplets.length;
        const projectedAccountDroplets = allDroplets.length + missingResources;
        if (projectedAccountDroplets > account.dropletLimit) {
          throw new Error(`DigitalOcean account limit ${account.dropletLimit} cannot fit the complete event stack: ${allDroplets.length} current plus ${missingResources} missing event resources requires ${projectedAccountDroplets}`);
        }

        for (const spec of manifest.droplets) {
          state = await this.#ensureDroplet(state, manifest, spec);
        }
        await this.#assertExactEventInventory(state, manifest);

        for (const endpoint of manifest.endpoints) {
          state = await this.#ensureEndpoint(state, manifest, anchors, endpoint);
        }

        const ordered = deploymentOrder(manifest.droplets);
        for (const spec of ordered) {
          const deployment = state.deployments[spec.name];
          if (deployment?.status === "healthy") continue;
          const resource = state.droplets[spec.name];
          const result = await this.deployer.deploy({ manifest, spec, resource, state: structuredClone(state) });
          if (result?.healthy !== true) throw new Error(`${spec.name} deployment did not pass its health gate`);
          state.deployments[spec.name] = {
            status: "healthy",
            revision: normalizedOptionalString(result.revision),
            checkedAt: this.now().toISOString(),
            evidence: result.evidence ?? null
          };
          await this.store.save(state);
        }

        if (typeof this.deployer.finalizeStack === "function") {
          const finalization = await this.deployer.finalizeStack({ manifest, state: structuredClone(state) });
          if (finalization?.healthy !== true) throw new Error("event stack deployment finalization failed");
          state.finalization = {
            status: "healthy",
            checkedAt: this.now().toISOString(),
            evidence: finalization.evidence ?? null
          };
          await this.store.save(state);
        }

        const aggregate = await this.deployer.verifyStack({ manifest, state: structuredClone(state) });
        if (aggregate?.healthy !== true) throw new Error("event stack aggregate health gate failed");
        state.stackHealth = {
          status: "healthy",
          checkedAt: this.now().toISOString(),
          evidence: aggregate.evidence ?? null
        };
        state.lastError = null;
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
        const readinessNotification = await this.#notifyOnce(state, `ready:${state.event}:${state.generationId}`, {
          title: "ScoreCheck event servers ready",
          message: `${state.event}: all event servers and network endpoints passed preflight.`,
          priority: 0
        });
        if (readinessNotification.status !== "sent") throw new Error("Pushover did not accept the event readiness notification");
        state.phase = "ready";
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
        return state;
      } catch (error) {
        state.lastError = safeError(error, this.now());
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
        await this.#notifyOnce(state, `provision-failed:${state.event}:${state.lastError.message}`, {
          title: "ScoreCheck setup needs attention",
          message: `${state.event}: event server setup stopped. Open the lifecycle report before cameras are connected.`,
          priority: 1
        });
        throw error;
      }
    });
  }

  async beginCoverage(manifest, confirmation) {
    return this.store.withLock(async () => {
      const state = await this.#requiredState(manifest);
      assertPhase(state, ["ready"], "start coverage");
      if (confirmation !== `START:${state.event}`) throw new Error(`confirmation must be exactly START:${state.event}`);
      const health = await this.deployer.verifyStack({ manifest, state: structuredClone(state) });
      if (health?.healthy !== true) throw new Error("event stack is not healthy enough to start coverage");
      state.phase = "live";
      state.coverage = { startedAt: this.now().toISOString(), closedAt: null };
      state.updatedAt = this.now().toISOString();
      await this.store.save(state);
      return state;
    });
  }

  async closeCoverage(manifest, confirmation) {
    return this.store.withLock(async () => {
      const state = await this.#requiredState(manifest);
      assertPhase(state, ["live"], "close coverage");
      if (confirmation !== `CLOSE:${state.event}`) throw new Error(`confirmation must be exactly CLOSE:${state.event}`);
      state.phase = "closed";
      state.coverage.closedAt = this.now().toISOString();
      state.updatedAt = this.now().toISOString();
      await this.store.save(state);
      return state;
    });
  }

  async captureEvidence(manifest, evidenceDirectory) {
    requireProtectedAbsolutePath(evidenceDirectory, "evidence directory");
    return this.store.withLock(async () => {
      const state = await this.#requiredState(manifest);
      assertPhase(state, ["closed"], "capture final evidence");
      const inventory = await this.#assertExactEventInventory(state, manifest);
      const health = await this.deployer.verifyStack({ manifest, state: structuredClone(state), finalEvidence: true });
      const evidence = {
        schemaVersion: 1,
        event: state.event,
        generationId: state.generationId,
        capturedAt: this.now().toISOString(),
        manifestSha256: state.manifestSha256,
        stateSha256: sha256(stableJson(state)),
        inventory,
        stackHealth: health
      };
      await mkdir(evidenceDirectory, { recursive: false, mode: 0o700 });
      await writeProtectedJson(join(evidenceDirectory, "event-state.json"), state);
      await writeProtectedJson(join(evidenceDirectory, "provider-inventory.json"), inventory);
      await writeProtectedJson(join(evidenceDirectory, "stack-health.json"), health);
      await writeProtectedJson(join(evidenceDirectory, "evidence.json"), evidence);
      const marker = {
        schemaVersion: 1,
        event: state.event,
        generationId: state.generationId,
        evidenceSha256: sha256(stableJson(evidence)),
        completeAt: this.now().toISOString()
      };
      await writeProtectedJson(join(evidenceDirectory, "EVIDENCE_COMPLETE.json"), marker);
      state.evidence = { directory: resolve(evidenceDirectory), ...marker };
      state.updatedAt = this.now().toISOString();
      await this.store.save(state);
      return state;
    });
  }

  async destroy(manifest, evidenceDirectory, confirmation) {
    requireProtectedAbsolutePath(evidenceDirectory, "evidence directory");
    return this.store.withLock(async () => {
      const state = await this.#requiredState(manifest);
      assertPhase(state, ["closed"], "destroy");
      if (confirmation !== `DESTROY:${state.event}`) throw new Error(`confirmation must be exactly DESTROY:${state.event}`);
      const today = this.now().toISOString().slice(0, 10);
      if (today < manifest.destroyAfter) throw new Error(`destroy review date is ${manifest.destroyAfter}; current UTC date is ${today}`);
      await verifyEvidenceBundle(state, evidenceDirectory);
      await this.#assertExactEventInventory(state, manifest);

      state.phase = "destroying";
      state.updatedAt = this.now().toISOString();
      await this.store.save(state);

      for (const spec of [...manifest.droplets].reverse()) {
        const resource = state.droplets[spec.name];
        const current = await this.cloud.getDroplet(resource.id);
        assertDropletIdentity(current, spec, manifest, resource.id);
        await this.cloud.deleteDroplet(resource.id);
        await this.cloud.waitDropletAbsent(resource.id);
        resource.status = "destroyed";
        resource.destroyedAt = this.now().toISOString();
        await this.store.save(state);
      }

      for (const endpoint of manifest.endpoints.filter((entry) => entry.addressMode === "dynamic-ipv4")) {
        const record = state.endpoints[endpoint.hostname];
        await this.dns.restoreRecord({ zone: manifest.dns.zone, hostname: endpoint.hostname, change: record.change });
        record.status = "restored";
        record.restoredAt = this.now().toISOString();
        await this.store.save(state);
      }
      for (const [slot, address] of Object.entries(state.addressSlots)) {
        const current = await this.cloud.getReservedIpv4(address.ip);
        if (current.dropletId !== null) throw new Error(`reserved IPv4 slot ${slot} remained assigned after teardown`);
      }
      state.phase = "destroyed";
      state.destroyedAt = this.now().toISOString();
      state.updatedAt = state.destroyedAt;
      await this.store.save(state);
      await this.#notifyOnce(state, `destroyed:${state.event}:${state.generationId}`, {
        title: "ScoreCheck event servers removed",
        message: `${state.event}: temporary event servers were removed and compute billing ended.`,
        priority: 0
      });
      return state;
    });
  }

  async status(manifest) {
    return this.store.withLock(async () => {
      const state = await this.#requiredState(manifest);
      const inventory = state.phase === "destroyed" ? [] : await this.#assertExactEventInventory(state, manifest);
      return { state, inventory };
    });
  }

  async #requiredState(manifest) {
    const state = await this.store.load();
    if (!state) throw new Error("event lifecycle state has not been initialized");
    assertStateMatchesManifest(state, manifest);
    return state;
  }

  async #ensureDroplet(state, manifest, spec) {
    let resource = state.droplets[spec.name] ?? null;
    let droplet;
    if (resource) {
      droplet = await this.cloud.getDroplet(resource.id);
      assertDropletIdentity(droplet, spec, manifest, resource.id);
    } else {
      const candidates = await this.cloud.findDropletsByName(spec.name);
      if (candidates.length > 1) throw new Error(`${spec.name} has ${candidates.length} provider resources; refusing ambiguous adoption`);
      if (candidates.length === 1) {
        droplet = candidates[0];
        assertDropletIdentity(droplet, spec, manifest);
      } else {
        droplet = await this.cloud.createDroplet({
          name: spec.name,
          region: spec.region,
          size: spec.size,
          image: spec.image,
          tags: lifecycleTags(manifest, spec),
          userDataProfile: spec.cloudInitProfile,
          userDataSha256: spec.cloudInitSha256
        });
      }
      resource = providerResource(droplet, spec);
      state.droplets[spec.name] = resource;
      await this.store.save(state);
    }
    droplet = await this.cloud.waitDropletActive(resource.id);
    assertDropletIdentity(droplet, spec, manifest, resource.id);
    Object.assign(resource, providerResource(droplet, spec), { status: "active", activeAt: this.now().toISOString() });
    await this.store.save(state);
    return state;
  }

  async #ensureEndpoint(state, manifest, anchors, endpoint) {
    const roleSpec = manifest.droplets.find((entry) => entry.role === endpoint.role);
    if (!roleSpec) throw new Error(`endpoint ${endpoint.hostname} has no target service`);
    const resource = state.droplets[roleSpec.name];
    let targetIpv4;
    if (endpoint.addressMode === "reserved-ipv4") {
      targetIpv4 = anchors.reservedIpv4[endpoint.addressSlot];
      const address = await this.cloud.getReservedIpv4(targetIpv4);
      if (address.region !== manifest.provider.region) throw new Error(`reserved IPv4 ${targetIpv4} is not in ${manifest.provider.region}`);
      if (address.dropletId !== resource.id) {
        if (address.dropletId !== null) throw new Error(`reserved IPv4 ${targetIpv4} is assigned to unexpected Droplet ${address.dropletId}`);
        await this.cloud.assignReservedIpv4(targetIpv4, resource.id);
        await this.cloud.waitReservedIpv4Assignment(targetIpv4, resource.id);
      }
      state.addressSlots[endpoint.addressSlot] = { ip: targetIpv4, role: endpoint.role, dropletId: resource.id };
    } else {
      targetIpv4 = resource.publicIpv4;
    }
    if (!targetIpv4) throw new Error(`endpoint ${endpoint.hostname} target has no public IPv4`);
    const existing = state.endpoints[endpoint.hostname];
    if (existing?.status === "configured" && existing.targetIpv4 === targetIpv4) {
      const verified = await this.dns.verifyARecord({ zone: manifest.dns.zone, hostname: endpoint.hostname, value: targetIpv4 });
      if (verified) return state;
    }
    let pending = existing;
    if (!pending) {
      const records = await this.dns.inspectHostname({ zone: manifest.dns.zone, hostname: endpoint.hostname });
      if (records.length > 1) throw new Error(`DNS ${endpoint.hostname} has ${records.length} conflicting records`);
      const current = records[0] ?? null;
      if (current && current.type !== "A") throw new Error(`DNS ${endpoint.hostname} is ${current.type}, not A`);
      const change = current === null
        ? { action: "created", recordId: null, previous: null }
        : current.value === targetIpv4 && Number(current.ttl) === Number(endpoint.ttl)
          ? { action: "unchanged", recordId: current.id, previous: current }
          : { action: "updated", recordId: current.id, previous: current };
      pending = {
        status: "pending",
        role: endpoint.role,
        addressMode: endpoint.addressMode,
        targetIpv4,
        preparedAt: this.now().toISOString(),
        change
      };
      state.endpoints[endpoint.hostname] = pending;
      await this.store.save(state);
    } else if (pending.status !== "pending" || pending.targetIpv4 !== targetIpv4 || pending.role !== endpoint.role || pending.addressMode !== endpoint.addressMode) {
      throw new Error(`DNS ${endpoint.hostname} lifecycle intent does not match the event manifest`);
    }
    const change = await this.dns.upsertARecord({
      zone: manifest.dns.zone,
      hostname: endpoint.hostname,
      value: targetIpv4,
      ttl: endpoint.ttl,
      previousChange: pending.change
    });
    const verified = await this.dns.verifyARecord({ zone: manifest.dns.zone, hostname: endpoint.hostname, value: targetIpv4 });
    if (!verified) throw new Error(`DNS verification failed for ${endpoint.hostname}`);
    state.endpoints[endpoint.hostname] = {
      status: "configured",
      role: endpoint.role,
      addressMode: endpoint.addressMode,
      targetIpv4,
      configuredAt: this.now().toISOString(),
      change
    };
    await this.store.save(state);
    return state;
  }

  async #assertExactEventInventory(state, manifest) {
    const inventory = await this.cloud.listDropletsByEvent(manifest.event);
    const expectedNames = manifest.droplets.map((entry) => entry.name).sort();
    const actualNames = inventory.map((entry) => entry.name).sort();
    if (!isDeepStrictEqual(actualNames, expectedNames)) {
      throw new Error(`event inventory mismatch: expected ${expectedNames.join(",")}; found ${actualNames.join(",")}`);
    }
    const ids = new Set();
    for (const spec of manifest.droplets) {
      const resource = state.droplets[spec.name];
      if (!resource) throw new Error(`state is missing ${spec.name}`);
      const droplet = inventory.find((entry) => entry.name === spec.name);
      assertDropletIdentity(droplet, spec, manifest, resource.id);
      if (ids.has(droplet.id)) throw new Error("event inventory contains duplicate provider IDs");
      ids.add(droplet.id);
    }
    return inventory.map((entry) => sanitizedDroplet(entry));
  }

  async #notifyOnce(state, key, notification) {
    if (state.notifications[key]?.status === "sent") return state.notifications[key];
    try {
      await this.notifier.send(notification);
      state.notifications[key] = { status: "sent", sentAt: this.now().toISOString() };
    } catch (error) {
      state.notifications[key] = { status: "failed", failedAt: this.now().toISOString(), error: safeError(error, this.now()).message };
    }
    await this.store.save(state);
    return state.notifications[key];
  }
}

export class FileStateStore {
  constructor(statePath) {
    requireProtectedAbsolutePath(statePath, "state path");
    this.statePath = resolve(statePath);
    this.lockPath = `${this.statePath}.lock`;
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8"));
      validateState(value);
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    validateState(state);
    state.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.statePath), 0o700);
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.statePath);
    await chmod(this.statePath, 0o600);
  }

  async withLock(operation) {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`lifecycle lock already exists: ${this.lockPath}`);
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await rm(this.lockPath, { force: true });
    }
  }
}

export class MemoryStateStore {
  constructor(initial = null) {
    this.state = initial === null ? null : structuredClone(initial);
  }

  async load() {
    return this.state === null ? null : structuredClone(this.state);
  }

  async save(state) {
    validateState(state);
    this.state = structuredClone(state);
  }

  async withLock(operation) {
    return operation();
  }
}

export class NullNotifier {
  async send() {}
}

export function createInitialState(manifest, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    event: manifest.event,
    generationId: randomUUID(),
    manifestSha256: sha256(stableJson(manifest)),
    phase: "planned",
    createdAt: timestamp,
    updatedAt: timestamp,
    coverage: null,
    destroyedAt: null,
    lastError: null,
    droplets: {},
    addressSlots: {},
    endpoints: {},
    deployments: {},
    finalization: null,
    stackHealth: null,
    notifications: {},
    evidence: null
  };
}

export function validateAnchorConfig(value, manifest) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("anchor configuration must be an object");
  if (value.schemaVersion !== ANCHOR_SCHEMA_VERSION) throw new Error("anchor configuration schemaVersion must be 1");
  if (value.provider !== "digitalocean") throw new Error("anchor configuration provider must be digitalocean");
  if (value.region !== manifest.provider.region) throw new Error("anchor configuration region does not match the event manifest");
  if (!value.reservedIpv4 || typeof value.reservedIpv4 !== "object" || Array.isArray(value.reservedIpv4)) {
    throw new Error("anchor configuration reservedIpv4 map is required");
  }
  const slots = [...new Set(manifest.endpoints.filter((entry) => entry.addressMode === "reserved-ipv4").map((entry) => entry.addressSlot))].sort();
  if (!isDeepStrictEqual(Object.keys(value.reservedIpv4).sort(), slots)) throw new Error("anchor configuration reserved IPv4 slots do not exactly match the manifest");
  const values = Object.values(value.reservedIpv4);
  if (!values.every(isIpv4) || new Set(values).size !== values.length) throw new Error("anchor configuration reserved IPv4 values are invalid or duplicated");
  return value;
}

export function lifecycleTags(manifest, spec) {
  return [...new Set([
    spec.tag,
    `scorecheck-role:${spec.role}`,
    `scorecheck-event:${manifest.event}`,
    "scorecheck-temporary",
    `scorecheck-destroy-after:${manifest.destroyAfter}`
  ])];
}

export function stateSummary(state) {
  return {
    event: state.event,
    generationId: state.generationId,
    phase: state.phase,
    droplets: Object.values(state.droplets).filter((entry) => entry.status !== "destroyed").length,
    healthyDeployments: Object.values(state.deployments).filter((entry) => entry.status === "healthy").length,
    endpoints: Object.values(state.endpoints).filter((entry) => entry.status === "configured").length,
    coverage: state.coverage,
    evidence: state.evidence,
    lastError: state.lastError
  };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lifecycle state must be an object");
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) throw new Error("lifecycle state schemaVersion must be 1");
  if (typeof value.event !== "string" || typeof value.generationId !== "string") throw new Error("lifecycle state identity is invalid");
  if (!SHA256.test(value.manifestSha256 ?? "")) throw new Error("lifecycle state manifest digest is invalid");
  if (!PHASES.has(value.phase)) throw new Error("lifecycle state phase is invalid");
  for (const key of ["droplets", "addressSlots", "endpoints", "deployments", "notifications"]) {
    if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) throw new Error(`lifecycle state ${key} map is invalid`);
  }
}

function assertStateMatchesManifest(state, manifest) {
  validateState(state);
  if (state.event !== manifest.event) throw new Error("lifecycle state belongs to a different event");
  if (state.manifestSha256 !== sha256(stableJson(manifest))) throw new Error("event manifest changed after lifecycle state creation");
}

function assertPhase(state, allowed, action) {
  if (!allowed.includes(state.phase)) throw new Error(`cannot ${action} while lifecycle phase is ${state.phase}`);
}

function assertDropletIdentity(droplet, spec, manifest, expectedId = undefined) {
  if (!droplet) throw new Error(`${spec.name} is missing from provider inventory`);
  if (expectedId !== undefined && String(droplet.id) !== String(expectedId)) throw new Error(`${spec.name} provider ID changed`);
  if (droplet.name !== spec.name) throw new Error(`${spec.name} provider name changed`);
  if (droplet.region !== spec.region || droplet.size !== spec.size || droplet.image !== spec.image) {
    throw new Error(`${spec.name} provider shape does not match the event manifest`);
  }
  const requiredTags = lifecycleTags(manifest, spec);
  if (!requiredTags.every((tag) => droplet.tags.includes(tag))) throw new Error(`${spec.name} lifecycle tags do not match the event manifest`);
}

function providerResource(droplet, spec) {
  return {
    id: String(droplet.id),
    name: spec.name,
    role: spec.role,
    status: droplet.status,
    region: droplet.region,
    size: droplet.size,
    image: droplet.image,
    publicIpv4: droplet.publicIpv4 ?? null,
    privateIpv4: droplet.privateIpv4 ?? null,
    createdAt: droplet.createdAt ?? null
  };
}

function sanitizedDroplet(droplet) {
  return {
    id: String(droplet.id),
    name: droplet.name,
    status: droplet.status,
    region: droplet.region,
    size: droplet.size,
    image: droplet.image,
    publicIpv4: droplet.publicIpv4 ?? null,
    privateIpv4: droplet.privateIpv4 ?? null,
    tags: [...droplet.tags].sort()
  };
}

function deploymentOrder(droplets) {
  const priority = new Map([["commentary", 0], ["ingest", 1], ["compositor", 2], ["compositor-spare", 3], ["observability", 4]]);
  return [...droplets].sort((left, right) => (priority.get(left.role) ?? 99) - (priority.get(right.role) ?? 99) || left.name.localeCompare(right.name));
}

function requireProtectedAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  if (value === "/" || value.includes("..") || value.includes("//")) throw new Error(`${label} must be normalized and protected`);
}

async function verifyEvidenceBundle(state, directory) {
  const marker = JSON.parse(await readFile(join(directory, "EVIDENCE_COMPLETE.json"), "utf8"));
  const evidence = JSON.parse(await readFile(join(directory, "evidence.json"), "utf8"));
  if (marker.event !== state.event || marker.generationId !== state.generationId) throw new Error("evidence belongs to a different event generation");
  if (marker.evidenceSha256 !== sha256(stableJson(evidence))) throw new Error("evidence integrity check failed");
  if (evidence.manifestSha256 !== state.manifestSha256) throw new Error("evidence manifest digest does not match state");
  const directoryStat = await stat(directory);
  if ((directoryStat.mode & 0o077) !== 0) throw new Error("evidence directory permissions are not protected");
}

async function writeProtectedJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

function safeError(error, now) {
  const message = error instanceof Error ? error.message : String(error);
  return { message: message.slice(0, 500), at: now.toISOString() };
}

function normalizedOptionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stableJson(value) {
  return JSON.stringify(sortRecursively(value));
}

function sortRecursively(value) {
  if (Array.isArray(value)) return value.map(sortRecursively);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortRecursively(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isIpv4(value) {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  return value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}
