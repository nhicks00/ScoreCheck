#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { verifyRehearsalEvidence } from "./rehearsal/rehearsal-evidence.mjs";

const STATE_SCHEMA_VERSION = 6;
const ANCHOR_SCHEMA_VERSION = 2;
const PHASES = new Set(["planned", "provisioning", "ready", "live", "closed", "destroying", "destroyed", "aborting", "aborted"]);
const SHA256 = /^[a-f0-9]{64}$/;

export class EventLifecycleController {
  constructor({ store, cloud, dns, deployer, notifier = new NullNotifier(), provisioningGuard = null, now = () => new Date() }) {
    this.store = store;
    this.cloud = cloud;
    this.dns = dns;
    this.deployer = deployer;
    this.notifier = notifier;
    this.provisioningGuard = provisioningGuard;
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
    if (!this.provisioningGuard || typeof this.provisioningGuard.verify !== "function") {
      throw new Error("production provisioning requires a verified lifecycle canary attestation");
    }
    const provisioningAttestation = await this.provisioningGuard.verify();
    validateProvisioningAttestationSummary(provisioningAttestation);
    validateAnchorConfig(anchors, manifest);
    return this.store.withLock(async () => {
      let state = await this.store.load();
      if (!state) state = createInitialState(manifest, this.now());
      assertStateMatchesManifest(state, manifest);
      assertPhase(state, ["planned", "provisioning"], "provision");
      const anchorConfig = lifecycleAnchorBinding(anchors);
      if (state.anchorConfig && !isDeepStrictEqual(state.anchorConfig, anchorConfig)) {
        throw new Error("endpoint anchor identities changed after provisioning began");
      }
      state.anchorConfig = anchorConfig;
      state.provisioningAttestation = structuredClone(provisioningAttestation);
      state.phase = "provisioning";
      state.lastError = null;
      await this.store.save(state);

      try {
        await this.#requireNetworkContract(state, manifest);
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
        const expectedNames = new Set(manifest.droplets.map((entry) => entry.providerName));
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
          title: manifest.kind === "rehearsal" ? "ScoreCheck TEST rehearsal ready" : "ScoreCheck event servers ready",
          message: manifest.kind === "rehearsal"
            ? `TEST rehearsal ${state.event}: all isolated servers and network endpoints passed preflight.`
            : `${state.event}: all event servers and network endpoints passed preflight.`,
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
          title: manifest.kind === "rehearsal" ? "ScoreCheck TEST rehearsal stopped" : "ScoreCheck setup needs attention",
          message: manifest.kind === "rehearsal"
            ? `TEST rehearsal ${state.event}: isolated server setup stopped. Open the lifecycle report.`
            : `${state.event}: event server setup stopped. Open the lifecycle report before cameras are connected.`,
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
      await this.#requireNetworkContract(state, manifest);
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

  async captureEvidence(manifest, evidenceDirectory, rehearsalEvidenceDirectory = null) {
    requireProtectedAbsolutePath(evidenceDirectory, "evidence directory");
    return this.store.withLock(async () => {
      const state = await this.#requiredState(manifest);
      assertPhase(state, ["closed"], "capture final evidence");
      const existing = await pathStatOrNull(evidenceDirectory);
      if (existing) {
        await verifyEvidenceBundle(state, evidenceDirectory);
        const marker = JSON.parse(await readFile(join(evidenceDirectory, "EVIDENCE_COMPLETE.json"), "utf8"));
        state.evidence = { directory: resolve(evidenceDirectory), ...marker };
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
        return state;
      }
      if (manifest.kind === "production" && rehearsalEvidenceDirectory !== null) throw new Error("production evidence cannot include a rehearsal bundle");
      const rehearsal = manifest.kind === "rehearsal"
        ? await verifyRehearsalEvidence({
          directory: requiredRehearsalEvidence(rehearsalEvidenceDirectory),
          event: state.event,
          generationId: state.generationId,
          manifestSha256: state.manifestSha256
        })
        : null;
      const networkContract = await this.#requireNetworkContract(state, manifest);
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
        networkContract,
        stackHealth: health,
        rehearsal: rehearsal ? {
          classification: rehearsal.marker.classification,
          providerCleanupComplete: rehearsal.marker.providerCleanupComplete,
          markerSha256: sha256(stableJson(rehearsal.marker)),
          evidenceSha256: sha256(stableJson(rehearsal.evidence))
        } : null
      };
      await ensureProtectedParent(dirname(evidenceDirectory));
      const temporary = `${evidenceDirectory}.tmp-${process.pid}-${randomUUID()}`;
      await mkdir(temporary, { mode: 0o700 });
      const marker = {
        schemaVersion: 1,
        event: state.event,
        generationId: state.generationId,
        evidenceSha256: sha256(stableJson(evidence)),
        completeAt: this.now().toISOString()
      };
      try {
        await writeProtectedJson(join(temporary, "event-state.json"), state);
        await writeProtectedJson(join(temporary, "provider-inventory.json"), inventory);
        await writeProtectedJson(join(temporary, "stack-health.json"), health);
        if (rehearsal) {
          await writeProtectedJson(join(temporary, "rehearsal-marker.json"), rehearsal.marker);
          await writeProtectedJson(join(temporary, "rehearsal-evidence.json"), rehearsal.evidence);
        }
        await writeProtectedJson(join(temporary, "evidence.json"), evidence);
        await writeProtectedJson(join(temporary, "EVIDENCE_COMPLETE.json"), marker);
        await rename(temporary, evidenceDirectory);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
      await verifyEvidenceBundle(state, evidenceDirectory);
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
      assertPhase(state, ["closed", "destroying"], "destroy");
      if (confirmation !== `DESTROY:${state.event}`) throw new Error(`confirmation must be exactly DESTROY:${state.event}`);
      const today = this.now().toISOString().slice(0, 10);
      if (manifest.kind !== "rehearsal" && today < manifest.destroyAfter) {
        throw new Error(`destroy review date is ${manifest.destroyAfter}; current UTC date is ${today}`);
      }
      await verifyEvidenceBundle(state, evidenceDirectory);
      if (state.phase === "closed") {
        await this.#assertExactEventInventory(state, manifest);
        state.phase = "destroying";
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
      } else {
        await this.#assertDestroyingInventory(state, manifest);
      }

      await this.#deleteEventDroplets(state, manifest);
      const endpointsToRestore = manifest.kind === "rehearsal"
        ? manifest.endpoints
        : manifest.endpoints.filter((entry) => entry.addressMode === "dynamic-ipv4");
      await this.#restoreEndpoints(state, manifest, endpointsToRestore, { requireEveryEndpoint: true });
      await this.#cleanupAddressSlots(state, manifest);
      const removalNotification = await this.#notifyOnce(state, `destroyed:${state.event}:${state.generationId}`, {
        title: manifest.kind === "rehearsal" ? "ScoreCheck TEST rehearsal removed" : "ScoreCheck event servers removed",
        message: manifest.kind === "rehearsal"
          ? `TEST rehearsal ${state.event}: all isolated servers were removed and rehearsal compute billing ended.`
          : `${state.event}: temporary event servers were removed and compute billing ended.`,
        priority: 0
      });
      if (removalNotification.status !== "sent") throw new Error("Pushover did not accept the teardown completion notification");
      state.phase = "destroyed";
      state.destroyedAt = this.now().toISOString();
      state.updatedAt = state.destroyedAt;
      await this.store.save(state);
      return state;
    });
  }

  async abort(manifest, evidenceDirectory, confirmation, rehearsalEvidenceDirectory = null) {
    requireProtectedAbsolutePath(evidenceDirectory, "abort evidence directory");
    return this.store.withLock(async () => {
      const state = await this.#requiredState(manifest);
      assertPhase(state, ["planned", "provisioning", "ready", "aborting"], "abort setup");
      if (confirmation !== `ABORT:${state.event}`) throw new Error(`confirmation must be exactly ABORT:${state.event}`);
      if (state.coverage !== null) throw new Error("cannot abort setup after coverage has started");
      if (manifest.kind === "rehearsal") {
        await verifyRehearsalEvidence({
          directory: requiredRehearsalEvidence(rehearsalEvidenceDirectory),
          event: state.event,
          generationId: state.generationId,
          manifestSha256: state.manifestSha256
        });
      } else if (rehearsalEvidenceDirectory !== null) throw new Error("production abort cannot include a rehearsal bundle");

      const inventory = await this.#reconcileAbortInventory(state, manifest);
      if (state.phase !== "aborting") {
        const marker = await initializeAbortEvidence(state, evidenceDirectory, inventory, this.now());
        state.phase = "aborting";
        state.abort = {
          status: "in-progress",
          directory: resolve(evidenceDirectory),
          startedAt: marker.startedAt,
          preStateSha256: marker.preStateSha256,
          preInventorySha256: marker.preInventorySha256,
          completedAt: null
        };
        state.updatedAt = this.now().toISOString();
        await this.store.save(state);
      } else {
        await verifyAbortEvidenceStarted(state, evidenceDirectory);
      }

      await this.#deleteEventDroplets(state, manifest);
      await this.#restoreEndpoints(state, manifest, manifest.endpoints, { requireEveryEndpoint: false });
      await this.#cleanupAddressSlots(state, manifest);
      const finalInventory = await this.cloud.listDropletsByEvent(manifest.event);
      if (finalInventory.length !== 0) throw new Error("event-tagged Droplets remain after setup abort");

      const abortNotification = await this.#notifyOnce(state, `aborted:${state.event}:${state.generationId}`, {
        title: manifest.kind === "rehearsal" ? "ScoreCheck TEST rehearsal cancelled" : "ScoreCheck event setup cancelled",
        message: manifest.kind === "rehearsal"
          ? `TEST rehearsal ${state.event}: partial setup was removed and temporary compute billing ended.`
          : `${state.event}: partial event setup was removed before coverage started.`,
        priority: 0
      });
      if (abortNotification.status !== "sent") throw new Error("Pushover did not accept the setup abort completion notification");

      state.abort.completedAt ??= this.now().toISOString();
      await this.store.save(state);
      await completeAbortEvidence(state, evidenceDirectory, finalInventory);
      state.abort.status = "complete";
      state.phase = "aborted";
      state.destroyedAt = state.abort.completedAt;
      state.updatedAt = state.abort.completedAt;
      await this.store.save(state);
      return state;
    });
  }

  async status(manifest) {
    return this.store.withLock(async () => {
      const state = await this.#requiredState(manifest);
      const terminalOrCleanup = new Set(["destroyed", "aborted", "aborting"]);
      const networkContract = terminalOrCleanup.has(state.phase) ? null : await this.#inspectNetworkContract(state, manifest);
      let inventory;
      if (new Set(["planned", "provisioning"]).has(state.phase)) {
        inventory = await this.#inspectProvisioningInventory(state, manifest);
      } else if (new Set(["destroying", "aborting"]).has(state.phase)) {
        inventory = await this.#assertDestroyingInventory(state, manifest);
      } else if (new Set(["destroyed", "aborted"]).has(state.phase)) {
        inventory = await this.#assertEmptyEventInventory(manifest);
      } else {
        inventory = await this.#assertExactEventInventory(state, manifest);
      }
      return { state, inventory, networkContract };
    });
  }

  async #inspectNetworkContract(state, manifest) {
    if (typeof this.cloud.verifyNetworkContract !== "function") {
      throw new Error("cloud provider cannot verify the bound network contract");
    }
    const result = await this.cloud.verifyNetworkContract(manifest.network);
    if (!result || typeof result.healthy !== "boolean" || !Array.isArray(result.problems)) {
      throw new Error("cloud provider returned invalid network contract evidence");
    }
    state.networkContract = {
      status: result.healthy ? "healthy" : "unhealthy",
      checkedAt: this.now().toISOString(),
      problems: result.problems.map(String)
    };
    state.updatedAt = this.now().toISOString();
    await this.store.save(state);
    return result;
  }

  async #requireNetworkContract(state, manifest) {
    const result = await this.#inspectNetworkContract(state, manifest);
    if (!result.healthy) {
      throw new Error(`DigitalOcean network contract is unhealthy: ${result.problems.join("; ") || "unspecified drift"}`);
    }
    return result;
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
      const candidates = await this.cloud.findDropletsByName(spec.providerName);
      if (candidates.length > 1) throw new Error(`${spec.name} has ${candidates.length} provider resources; refusing ambiguous adoption`);
      if (candidates.length === 1) {
        droplet = candidates[0];
        assertDropletIdentity(droplet, spec, manifest);
      } else {
        droplet = await this.cloud.createDroplet({
          name: spec.providerName,
          region: spec.region,
          vpcUuid: manifest.provider.vpcUuid,
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
      existing.dnsReadiness = await this.dns.waitARecordReady({
        zone: manifest.dns.zone,
        hostname: endpoint.hostname,
        value: targetIpv4
      });
      existing.verifiedAt = this.now().toISOString();
      await this.store.save(state);
      return state;
    }
    let pending = existing;
    if (!pending) {
      const records = await this.dns.inspectHostname({ zone: manifest.dns.zone, hostname: endpoint.hostname });
      if (records.length > 1) throw new Error(`DNS ${endpoint.hostname} has ${records.length} conflicting records`);
      const current = records[0] ?? null;
      if (manifest.kind === "rehearsal" && current !== null) {
        throw new Error(`rehearsal DNS ${endpoint.hostname} already exists; refusing ambiguous ownership`);
      }
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
    const dnsReadiness = await this.dns.waitARecordReady({
      zone: manifest.dns.zone,
      hostname: endpoint.hostname,
      value: targetIpv4
    });
    state.endpoints[endpoint.hostname] = {
      status: "configured",
      role: endpoint.role,
      addressMode: endpoint.addressMode,
      targetIpv4,
      configuredAt: this.now().toISOString(),
      verifiedAt: this.now().toISOString(),
      dnsReadiness,
      change
    };
    await this.store.save(state);
    return state;
  }

  async #deleteEventDroplets(state, manifest) {
    for (const spec of [...manifest.droplets].reverse()) {
      const resource = state.droplets[spec.name];
      if (!resource) continue;
      const current = await providerValueOrNull(() => this.cloud.getDroplet(resource.id));
      if (resource.status === "destroyed") {
        if (current !== null) throw new Error(`${spec.name} reappeared after its recorded deletion`);
        continue;
      }
      if (current === null) {
        resource.status = "destroyed";
        resource.destroyedAt = this.now().toISOString();
        resource.reconciledAfterDelete = true;
        await this.store.save(state);
        continue;
      }
      assertDropletIdentity(current, spec, manifest, resource.id);
      await this.cloud.deleteDroplet(resource.id);
      await this.cloud.waitDropletAbsent(resource.id);
      resource.status = "destroyed";
      resource.destroyedAt = this.now().toISOString();
      await this.store.save(state);
    }
    if ((await this.cloud.listDropletsByEvent(manifest.event)).length !== 0) {
      throw new Error("event-tagged Droplets remain after exact teardown");
    }
  }

  async #restoreEndpoints(state, manifest, endpoints, { requireEveryEndpoint }) {
    for (const endpoint of endpoints) {
      const record = state.endpoints[endpoint.hostname];
      if (!record) {
        if (requireEveryEndpoint) throw new Error(`DNS ${endpoint.hostname} has no protected restoration evidence`);
        continue;
      }
      if (!record.change) throw new Error(`DNS ${endpoint.hostname} has no protected restoration evidence`);
      if (record.status === "restored") {
        await this.#assertEndpointRestored(manifest, endpoint, record);
        continue;
      }
      if (record.change.action === "created" && record.change.recordId == null) {
        const records = await this.dns.inspectHostname({ zone: manifest.dns.zone, hostname: endpoint.hostname });
        if (records.length === 0) {
          record.status = "restored";
          record.restoredAt = this.now().toISOString();
          await this.store.save(state);
          continue;
        }
        if (
          records.length !== 1
          || records[0].type !== "A"
          || records[0].value !== record.targetIpv4
          || Number(records[0].ttl) !== Number(endpoint.ttl)
        ) {
          throw new Error(`DNS ${endpoint.hostname} changed while its create result was ambiguous`);
        }
        record.change.recordId = records[0].id;
        await this.store.save(state);
      }
      await this.dns.restoreRecord({ zone: manifest.dns.zone, hostname: endpoint.hostname, change: record.change });
      await this.#assertEndpointRestored(manifest, endpoint, record);
      record.status = "restored";
      record.restoredAt = this.now().toISOString();
      await this.store.save(state);
    }
  }

  async #cleanupAddressSlots(state, manifest) {
    for (const [slot, ip] of Object.entries(state.anchorConfig?.reservedIpv4 ?? {})) {
      const existing = state.addressSlots[slot];
      if (existing && existing.ip !== ip) throw new Error(`reserved IPv4 slot ${slot} changed after provisioning began`);
      if (!existing) {
        const endpoint = manifest.endpoints.find((entry) => entry.addressSlot === slot);
        state.addressSlots[slot] = { ip, role: endpoint?.role ?? null, dropletId: null, status: "unassigned" };
        await this.store.save(state);
      }
    }
    for (const [slot, address] of Object.entries(state.addressSlots)) {
      const current = await providerValueOrNull(() => this.cloud.getReservedIpv4(address.ip));
      if (manifest.kind === "production") {
        if (current === null) throw new Error(`persistent reserved IPv4 slot ${slot} disappeared during teardown`);
        if (current.dropletId !== null) throw new Error(`reserved IPv4 slot ${slot} remained assigned after teardown`);
        address.status = "retained";
        address.retainedAt ??= this.now().toISOString();
        await this.store.save(state);
        continue;
      }
      if (address.status === "deleted") {
        if (current !== null) throw new Error(`ephemeral reserved IPv4 slot ${slot} reappeared after deletion`);
        continue;
      }
      if (current !== null) {
        if (current.dropletId !== null) throw new Error(`reserved IPv4 slot ${slot} remained assigned after teardown`);
        await this.cloud.deleteReservedIpv4(address.ip);
        await this.cloud.waitReservedIpv4Absent(address.ip);
      }
      address.status = "deleted";
      address.deletedAt = this.now().toISOString();
      await this.store.save(state);
    }
  }

  async #assertExactEventInventory(state, manifest) {
    const inventory = await this.cloud.listDropletsByEvent(manifest.event);
    const expectedNames = manifest.droplets.map((entry) => entry.providerName).sort();
    const actualNames = inventory.map((entry) => entry.name).sort();
    if (!isDeepStrictEqual(actualNames, expectedNames)) {
      throw new Error(`event inventory mismatch: expected ${expectedNames.join(",")}; found ${actualNames.join(",")}`);
    }
    const ids = new Set();
    for (const spec of manifest.droplets) {
      const resource = state.droplets[spec.name];
      if (!resource) throw new Error(`state is missing ${spec.name}`);
      const droplet = inventory.find((entry) => entry.name === spec.providerName);
      assertDropletIdentity(droplet, spec, manifest, resource.id);
      if (ids.has(droplet.id)) throw new Error("event inventory contains duplicate provider IDs");
      ids.add(droplet.id);
    }
    return inventory.map((entry) => sanitizedDroplet(entry));
  }

  async #inspectProvisioningInventory(state, manifest) {
    const inventory = await this.cloud.listDropletsByEvent(manifest.event);
    const specByProviderName = new Map(manifest.droplets.map((entry) => [entry.providerName, entry]));
    const names = inventory.map((entry) => entry.name);
    if (new Set(names).size !== names.length) throw new Error("provisioning inventory contains duplicate provider names");
    const ids = new Set();
    for (const droplet of inventory) {
      const spec = specByProviderName.get(droplet.name);
      if (!spec) throw new Error(`provisioning inventory contains unexpected resource ${droplet.name}`);
      const resource = state.droplets[spec.name] ?? null;
      assertDropletIdentity(droplet, spec, manifest, resource?.id);
      if (resource?.status === "destroyed") throw new Error(`${spec.name} exists after its recorded deletion`);
      if (ids.has(droplet.id)) throw new Error("provisioning inventory contains duplicate provider IDs");
      ids.add(droplet.id);
    }
    for (const spec of manifest.droplets) {
      const resource = state.droplets[spec.name];
      if (!resource || resource.status === "destroyed") continue;
      if (!inventory.some((entry) => entry.name === spec.providerName)) {
        throw new Error(`${spec.name} recorded provider resource is missing during provisioning`);
      }
    }
    return inventory.map((entry) => sanitizedDroplet(entry));
  }

  async #assertEmptyEventInventory(manifest) {
    const inventory = await this.cloud.listDropletsByEvent(manifest.event);
    if (inventory.length !== 0) {
      throw new Error(`terminal event inventory is not empty: ${inventory.map((entry) => entry.name).sort().join(",")}`);
    }
    return [];
  }

  async #assertDestroyingInventory(state, manifest) {
    const inventory = await this.cloud.listDropletsByEvent(manifest.event);
    const specByProviderName = new Map(manifest.droplets.map((entry) => [entry.providerName, entry]));
    const names = inventory.map((entry) => entry.name);
    if (new Set(names).size !== names.length) throw new Error("destroying inventory contains duplicate provider names");
    const ids = new Set();
    for (const droplet of inventory) {
      const spec = specByProviderName.get(droplet.name);
      if (!spec) throw new Error(`destroying inventory contains unexpected resource ${droplet.name}`);
      const resource = state.droplets[spec.name];
      if (!resource) throw new Error(`destroying state is missing ${spec.name}`);
      if (resource.status === "destroyed") throw new Error(`${spec.name} still exists after its recorded deletion`);
      assertDropletIdentity(droplet, spec, manifest, resource.id);
      if (ids.has(droplet.id)) throw new Error("destroying inventory contains duplicate provider IDs");
      ids.add(droplet.id);
    }
    return inventory.map((entry) => sanitizedDroplet(entry));
  }

  async #reconcileAbortInventory(state, manifest) {
    const inventory = await this.cloud.listDropletsByEvent(manifest.event);
    const specByProviderName = new Map(manifest.droplets.map((entry) => [entry.providerName, entry]));
    const names = inventory.map((entry) => entry.name);
    if (new Set(names).size !== names.length) throw new Error("abort inventory contains duplicate provider names");
    const ids = new Set();
    for (const droplet of inventory) {
      const spec = specByProviderName.get(droplet.name);
      if (!spec) throw new Error(`abort inventory contains unexpected resource ${droplet.name}`);
      assertDropletIdentity(droplet, spec, manifest);
      if (ids.has(droplet.id)) throw new Error("abort inventory contains duplicate provider IDs");
      ids.add(droplet.id);
      const existing = state.droplets[spec.name];
      if (existing && String(existing.id) !== String(droplet.id)) throw new Error(`${spec.name} provider ID changed before setup abort`);
      if (!existing) {
        state.droplets[spec.name] = { ...providerResource(droplet, spec), status: "active", adoptedForAbort: true };
        await this.store.save(state);
      }
    }
    return inventory.map((entry) => sanitizedDroplet(entry));
  }

  async #assertEndpointRestored(manifest, endpoint, record) {
    const records = await this.dns.inspectHostname({ zone: manifest.dns.zone, hostname: endpoint.hostname });
    if (record.change.action === "created") {
      if (records.length !== 0) throw new Error(`DNS ${endpoint.hostname} still exists after rehearsal cleanup`);
      return;
    }
    if (records.length !== 1) throw new Error(`DNS ${endpoint.hostname} restoration did not produce exactly one record`);
    const current = records[0];
    const expected = record.change.action === "updated" ? record.change.previous : {
      id: record.change.recordId,
      type: "A",
      value: record.targetIpv4,
      ttl: endpoint.ttl
    };
    if (
      current.type !== expected.type
      || current.value !== expected.value
      || Number(current.ttl) !== Number(expected.ttl)
      || (expected.id != null && current.id !== expected.id)
    ) {
      throw new Error(`DNS ${endpoint.hostname} did not return to its protected pre-event state`);
    }
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
    kind: manifest.kind,
    generationId: randomUUID(),
    manifestSha256: sha256(stableJson(manifest)),
    phase: "planned",
    createdAt: timestamp,
    updatedAt: timestamp,
    coverage: null,
    destroyedAt: null,
    lastError: null,
    provisioningAttestation: null,
    anchorConfig: null,
    networkContract: null,
    droplets: {},
    addressSlots: {},
    endpoints: {},
    deployments: {},
    finalization: null,
    stackHealth: null,
    notifications: {},
    evidence: null,
    abort: null
  };
}

export function validateAnchorConfig(value, manifest) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("anchor configuration must be an object");
  if (value.schemaVersion !== ANCHOR_SCHEMA_VERSION) throw new Error("anchor configuration schemaVersion must be 2");
  if (value.provider !== "digitalocean") throw new Error("anchor configuration provider must be digitalocean");
  if (value.region !== manifest.provider.region) throw new Error("anchor configuration region does not match the event manifest");
  const expectedRetention = manifest.kind === "rehearsal" ? "ephemeral" : "persistent";
  if (value.retention !== expectedRetention) throw new Error(`anchor retention must be ${expectedRetention} for a ${manifest.kind} event`);
  if (!value.reservedIpv4 || typeof value.reservedIpv4 !== "object" || Array.isArray(value.reservedIpv4)) {
    throw new Error("anchor configuration reservedIpv4 map is required");
  }
  const slots = [...new Set(manifest.endpoints.filter((entry) => entry.addressMode === "reserved-ipv4").map((entry) => entry.addressSlot))].sort();
  if (!isDeepStrictEqual(Object.keys(value.reservedIpv4).sort(), slots)) throw new Error("anchor configuration reserved IPv4 slots do not exactly match the manifest");
  const values = Object.values(value.reservedIpv4);
  if (!values.every(isIpv4) || new Set(values).size !== values.length) throw new Error("anchor configuration reserved IPv4 values are invalid or duplicated");
  return value;
}

function lifecycleAnchorBinding(value) {
  return {
    schemaVersion: ANCHOR_SCHEMA_VERSION,
    provider: value.provider,
    region: value.region,
    retention: value.retention,
    reservedIpv4: Object.fromEntries(Object.entries(value.reservedIpv4).sort(([left], [right]) => left.localeCompare(right)))
  };
}

function validateLifecycleAnchorBinding(value, kind) {
  if (!value || value.schemaVersion !== ANCHOR_SCHEMA_VERSION || value.provider !== "digitalocean") {
    throw new Error("lifecycle endpoint anchor binding is invalid");
  }
  if (typeof value.region !== "string" || !new Set(["persistent", "ephemeral"]).has(value.retention)) {
    throw new Error("lifecycle endpoint anchor binding identity is invalid");
  }
  const expectedRetention = kind === "rehearsal" ? "ephemeral" : "persistent";
  if (value.retention !== expectedRetention) throw new Error("lifecycle endpoint anchor retention does not match event kind");
  if (!value.reservedIpv4 || typeof value.reservedIpv4 !== "object" || Array.isArray(value.reservedIpv4)) {
    throw new Error("lifecycle endpoint anchor address map is invalid");
  }
  const addresses = Object.values(value.reservedIpv4);
  const expectedAddressCount = kind === "production" ? 2 : 0;
  if (addresses.length !== expectedAddressCount || !addresses.every(isIpv4) || new Set(addresses).size !== addresses.length) {
    throw new Error("lifecycle endpoint anchor addresses are invalid or duplicated");
  }
  return value;
}

export function lifecycleTags(manifest, spec) {
  return [...new Set([
    spec.tag,
    `scorecheck-role:${spec.role}`,
    `scorecheck-event:${manifest.event}`,
    `scorecheck-kind:${manifest.kind}`,
    "scorecheck-temporary",
    `scorecheck-destroy-after:${manifest.destroyAfter}`
  ])];
}

export function stateSummary(state) {
  return {
    event: state.event,
    kind: state.kind,
    generationId: state.generationId,
    phase: state.phase,
    droplets: Object.values(state.droplets).filter((entry) => entry.status !== "destroyed").length,
    healthyDeployments: Object.values(state.deployments).filter((entry) => entry.status === "healthy").length,
    endpoints: Object.values(state.endpoints).filter((entry) => entry.status === "configured").length,
    coverage: state.coverage,
    evidence: state.evidence,
    lastError: state.lastError,
    abort: state.abort,
    provisioningAttestation: state.provisioningAttestation,
    networkContract: state.networkContract
  };
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lifecycle state must be an object");
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) throw new Error(`lifecycle state schemaVersion must be ${STATE_SCHEMA_VERSION}`);
  if (typeof value.event !== "string" || !new Set(["production", "rehearsal"]).has(value.kind) || typeof value.generationId !== "string") {
    throw new Error("lifecycle state identity is invalid");
  }
  if (!SHA256.test(value.manifestSha256 ?? "")) throw new Error("lifecycle state manifest digest is invalid");
  if (!PHASES.has(value.phase)) throw new Error("lifecycle state phase is invalid");
  for (const key of ["droplets", "addressSlots", "endpoints", "deployments", "notifications"]) {
    if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key])) throw new Error(`lifecycle state ${key} map is invalid`);
  }
  if (value.anchorConfig !== null) validateLifecycleAnchorBinding(value.anchorConfig, value.kind);
  if (value.abort !== null && (!value.abort || typeof value.abort !== "object" || Array.isArray(value.abort))) {
    throw new Error("lifecycle state abort evidence is invalid");
  }
  if (value.networkContract !== null) {
    if (
      !value.networkContract
      || !new Set(["healthy", "unhealthy"]).has(value.networkContract.status)
      || typeof value.networkContract.checkedAt !== "string"
      || !Array.isArray(value.networkContract.problems)
      || !value.networkContract.problems.every((problem) => typeof problem === "string")
    ) {
      throw new Error("lifecycle state network contract evidence is invalid");
    }
  }
  if (value.provisioningAttestation !== null) validateProvisioningAttestationSummary(value.provisioningAttestation);
  if (!new Set(["planned", "aborting", "aborted"]).has(value.phase) && value.provisioningAttestation === null) {
    throw new Error("lifecycle provisioning attestation summary is invalid");
  }
}

function validateProvisioningAttestationSummary(value) {
  if (!value || value.schemaVersion !== 1 || value.provider !== "digitalocean+vercel") {
    throw new Error("lifecycle provisioning attestation summary is invalid");
  }
  for (const key of ["accountUuid", "canaryRunId", "canaryRegion", "canaryDnsZone", "canaryCompletedAt", "issuedAt", "expiresAt"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`lifecycle provisioning attestation ${key} is invalid`);
  }
  if (!SHA256.test(value.canaryEvidenceSha256 ?? "")) throw new Error("lifecycle provisioning attestation evidence digest is invalid");
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || !value.capabilities.every((entry) => typeof entry === "string" && entry)) {
    throw new Error("lifecycle provisioning attestation capabilities are invalid");
  }
  return value;
}

function assertStateMatchesManifest(state, manifest) {
  validateState(state);
  if (state.event !== manifest.event) throw new Error("lifecycle state belongs to a different event");
  if (state.kind !== manifest.kind) throw new Error("lifecycle state belongs to a different event kind");
  if (state.manifestSha256 !== sha256(stableJson(manifest))) throw new Error("event manifest changed after lifecycle state creation");
}

function assertPhase(state, allowed, action) {
  if (!allowed.includes(state.phase)) throw new Error(`cannot ${action} while lifecycle phase is ${state.phase}`);
}

async function providerValueOrNull(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

function assertDropletIdentity(droplet, spec, manifest, expectedId = undefined) {
  if (!droplet) throw new Error(`${spec.name} is missing from provider inventory`);
  if (expectedId !== undefined && String(droplet.id) !== String(expectedId)) throw new Error(`${spec.name} provider ID changed`);
  if (droplet.name !== spec.providerName) throw new Error(`${spec.name} provider name changed`);
  if (droplet.region !== spec.region || droplet.vpcUuid !== manifest.provider.vpcUuid || droplet.size !== spec.size || droplet.image !== spec.image) {
    throw new Error(`${spec.name} provider shape does not match the event manifest`);
  }
  const requiredTags = lifecycleTags(manifest, spec);
  if (!requiredTags.every((tag) => droplet.tags.includes(tag))) throw new Error(`${spec.name} lifecycle tags do not match the event manifest`);
}

function providerResource(droplet, spec) {
  return {
    id: String(droplet.id),
    name: spec.name,
    providerName: spec.providerName,
    role: spec.role,
    status: droplet.status,
    region: droplet.region,
    vpcUuid: droplet.vpcUuid,
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
    vpcUuid: droplet.vpcUuid,
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
  if (state.kind === "rehearsal") {
    const rehearsalMarker = JSON.parse(await readFile(join(directory, "rehearsal-marker.json"), "utf8"));
    const rehearsalEvidence = JSON.parse(await readFile(join(directory, "rehearsal-evidence.json"), "utf8"));
    if (evidence.rehearsal?.providerCleanupComplete !== true || rehearsalMarker.providerCleanupComplete !== true) throw new Error("rehearsal provider cleanup evidence is incomplete");
    if (rehearsalMarker.event !== state.event || rehearsalMarker.generationId !== state.generationId || rehearsalMarker.manifestSha256 !== state.manifestSha256) throw new Error("embedded rehearsal evidence belongs to a different lifecycle generation");
    if (evidence.rehearsal.markerSha256 !== sha256(stableJson(rehearsalMarker)) || evidence.rehearsal.evidenceSha256 !== sha256(stableJson(rehearsalEvidence)) || rehearsalMarker.evidenceSha256 !== sha256(stableJson(rehearsalEvidence))) throw new Error("embedded rehearsal evidence integrity check failed");
  } else if (evidence.rehearsal !== null) throw new Error("production evidence unexpectedly contains rehearsal state");
  const directoryStat = await stat(directory);
  if ((directoryStat.mode & 0o077) !== 0) throw new Error("evidence directory permissions are not protected");
}

function requiredRehearsalEvidence(value) {
  if (typeof value !== "string") throw new Error("rehearsal lifecycle evidence requires --rehearsal-evidence after provider cleanup");
  requireProtectedAbsolutePath(value, "rehearsal evidence directory");
  return value;
}

async function initializeAbortEvidence(state, directory, inventory, now) {
  const existing = await pathStatOrNull(directory);
  if (existing) return readAndVerifyAbortStart(state, directory);
  await ensureProtectedParent(dirname(directory));
  const temporary = `${directory}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    const preState = structuredClone(state);
    const preInventory = structuredClone(inventory);
    const marker = {
      schemaVersion: 1,
      event: state.event,
      generationId: state.generationId,
      manifestSha256: state.manifestSha256,
      startedAt: now.toISOString(),
      preStateSha256: sha256(stableJson(preState)),
      preInventorySha256: sha256(stableJson(preInventory))
    };
    await writeProtectedJson(join(temporary, "abort-pre-state.json"), preState);
    await writeProtectedJson(join(temporary, "abort-pre-inventory.json"), preInventory);
    await writeProtectedJson(join(temporary, "ABORT_STARTED.json"), marker);
    await rename(temporary, directory);
    await chmod(directory, 0o700);
    return marker;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function verifyAbortEvidenceStarted(state, directory) {
  const marker = await readAndVerifyAbortStart(state, directory);
  if (!state.abort || resolve(directory) !== state.abort.directory) throw new Error("abort evidence directory does not match lifecycle state");
  if (
    marker.startedAt !== state.abort.startedAt
    || marker.preStateSha256 !== state.abort.preStateSha256
    || marker.preInventorySha256 !== state.abort.preInventorySha256
  ) {
    throw new Error("abort evidence marker does not match lifecycle state");
  }
  return marker;
}

async function readAndVerifyAbortStart(state, directory) {
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) throw new Error("abort evidence directory permissions are not protected");
  const marker = JSON.parse(await readFile(join(directory, "ABORT_STARTED.json"), "utf8"));
  const preState = JSON.parse(await readFile(join(directory, "abort-pre-state.json"), "utf8"));
  const preInventory = JSON.parse(await readFile(join(directory, "abort-pre-inventory.json"), "utf8"));
  if (
    marker.schemaVersion !== 1
    || marker.event !== state.event
    || marker.generationId !== state.generationId
    || marker.manifestSha256 !== state.manifestSha256
  ) {
    throw new Error("abort evidence belongs to a different event generation");
  }
  if (marker.preStateSha256 !== sha256(stableJson(preState)) || marker.preInventorySha256 !== sha256(stableJson(preInventory))) {
    throw new Error("abort evidence integrity check failed");
  }
  return marker;
}

async function completeAbortEvidence(state, directory, finalInventory) {
  await verifyAbortEvidenceStarted(state, directory);
  if (!state.abort?.completedAt) throw new Error("abort completion timestamp is missing");
  const cleanupState = structuredClone(state);
  const inventory = structuredClone(finalInventory);
  const marker = {
    schemaVersion: 1,
    event: state.event,
    generationId: state.generationId,
    completedAt: state.abort.completedAt,
    cleanupStateSha256: sha256(stableJson(cleanupState)),
    finalInventorySha256: sha256(stableJson(inventory))
  };
  await writeProtectedJsonMatching(join(directory, "abort-cleanup-state.json"), cleanupState);
  await writeProtectedJsonMatching(join(directory, "abort-final-inventory.json"), inventory);
  await writeProtectedJsonMatching(join(directory, "ABORT_COMPLETE.json"), marker);
  return marker;
}

async function ensureProtectedParent(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const information = await stat(directory);
  if (!information.isDirectory() || (information.mode & 0o077) !== 0) {
    throw new Error("abort evidence parent directory permissions are not protected");
  }
}

async function pathStatOrNull(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeProtectedJsonMatching(path, value) {
  try {
    await writeProtectedJson(path, value);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8"));
    if (!isDeepStrictEqual(existing, value)) throw new Error(`protected evidence ${path} already exists with different content`);
    const information = await stat(path);
    if ((information.mode & 0o077) !== 0) throw new Error(`protected evidence ${path} permissions are not protected`);
  }
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
