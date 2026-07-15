#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const STATE_SCHEMA_VERSION = 2;
const CONFIRMATION = "RUN:LIFECYCLE-CANARY";

export class LifecycleCanary {
  constructor({ cloud, dns, host, store, fetchImpl = globalThis.fetch, now = () => new Date(), pollIntervalMs = 2_000, healthTimeoutMs = 180_000 }) {
    this.cloud = cloud;
    this.dns = dns;
    this.host = host;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.healthTimeoutMs = healthTimeoutMs;
  }

  async run(config, confirmation) {
    validateCanaryConfig(config);
    if (confirmation !== CONFIRMATION) throw new Error(`canary requires exact confirmation ${CONFIRMATION}`);
    return this.store.withLock(async () => {
      let state = await this.store.load();
      if (!state) state = await this.#initialize(config);
      assertStateMatchesConfig(state, config);
      if (state.phase === "cleaned") return state;
      if (state.phase === "cleaned-after-failure") throw new Error(`prior canary attempt failed: ${state.failure ?? "unknown failure"}`);

      let failure = state.failure ? new Error(state.failure) : null;
      const resumeCleanup = new Set(["verified", "failed", "cleaning", "cleanup-failed"]).has(state.phase);
      if (!resumeCleanup) {
        try {
          state = await this.#execute(state, config);
        } catch (error) {
          failure = error;
          state.failure = sanitizedError(error);
          state.phase = "failed";
          await this.#record(state, "execution-failed", { message: state.failure });
        }
      }

      let cleanupFailure = null;
      try {
        state = await this.#cleanup(state, config);
      } catch (error) {
        cleanupFailure = error;
        state.cleanupFailure = sanitizedError(error);
        state.phase = "cleanup-failed";
        await this.#record(state, "cleanup-failed", { message: state.cleanupFailure });
      }

      if (failure || cleanupFailure) {
        const messages = [failure && `execution: ${sanitizedError(failure)}`, cleanupFailure && `cleanup: ${sanitizedError(cleanupFailure)}`].filter(Boolean);
        throw new Error(`lifecycle canary failed (${messages.join("; ")})`);
      }
      return state;
    });
  }

  async cleanup(config, confirmation) {
    validateCanaryConfig(config);
    if (confirmation !== CONFIRMATION) throw new Error(`canary cleanup requires exact confirmation ${CONFIRMATION}`);
    return this.store.withLock(async () => {
      const state = await this.store.load();
      if (!state) throw new Error("canary state does not exist");
      assertStateMatchesConfig(state, config);
      return this.#cleanup(state, config);
    });
  }

  async #initialize(config) {
    const account = await this.cloud.getAccount();
    if (account.status !== "active") throw new Error(`DigitalOcean account is ${account.status}, not active`);
    if (typeof account.uuid !== "string" || !account.uuid.trim()) {
      throw new Error("DigitalOcean account response is missing its stable UUID");
    }
    const droplets = await this.cloud.listAllDroplets();
    if (droplets.length + 1 > account.dropletLimit) {
      throw new Error(`DigitalOcean account limit ${account.dropletLimit} cannot fit one disposable canary above ${droplets.length} current Droplets`);
    }
    const [sameName, sameTag, tagExists, sameSnapshot, dnsRecords, reservedIpv4s] = await Promise.all([
      this.cloud.findDropletsByName(config.name),
      this.cloud.listDropletsByTag(config.tag),
      this.cloud.tagExists(config.tag),
      this.cloud.findSnapshotsByName(config.snapshotName),
      this.dns.inspectHostname({ zone: config.zone, hostname: config.hostname }),
      this.cloud.listReservedIpv4s()
    ]);
    if (sameName.length || sameTag.length || tagExists || sameSnapshot.length || dnsRecords.length) {
      throw new Error("canary identity collides with an existing Droplet, tag, snapshot, or DNS record");
    }
    const state = {
      schemaVersion: STATE_SCHEMA_VERSION,
      runId: config.runId,
      phase: "preflight",
      identity: pickIdentity(config),
      baseline: {
        capturedAt: this.now().toISOString(),
        accountUuid: account.uuid,
        accountDropletLimit: account.dropletLimit,
        dropletIds: droplets.map((entry) => entry.id).sort(),
        reservedIpv4s: reservedIpv4s.map((entry) => entry.ip).sort()
      },
      original: null,
      replacement: null,
      reservedIpv4: null,
      dnsChange: null,
      snapshot: null,
      checks: [],
      cleanup: {},
      pending: {},
      startedAt: this.now().toISOString(),
      completedAt: null
    };
    await this.#record(state, "preflight-passed", { currentDroplets: droplets.length, dropletLimit: account.dropletLimit });
    return state;
  }

  async #execute(state, config) {
    if (state.phase === "verified") return state;
    if (!state.cleanup.tagCreated) {
      const pending = state.pending?.tagCreate;
      if (!pending) {
        if (await this.cloud.tagExists(config.tag)) throw new Error("canary tag appeared without a prepared mutation");
        await this.#prepareMutation(state, "tagCreate", "tag-create-prepared", { tag: config.tag });
      } else if (pending.tag !== config.tag) {
        throw new Error("prepared tag mutation does not match the exact canary tag");
      }
      await this.cloud.ensureTag(config.tag);
      state.cleanup.tagCreated = true;
      await this.#record(state, "tag-created", { tag: config.tag });
    }

    if (!state.original?.deletedAt) {
      state.phase = "creating-original";
      await this.store.save(state);
      if (state.original?.id && state.snapshot) {
        try {
          await this.cloud.getDroplet(state.original.id);
        } catch (error) {
          if (error?.status !== 404) throw error;
          state.original.deletedAt = this.now().toISOString();
          if (state.reservedIpv4?.ip) await this.cloud.waitReservedIpv4Unassigned(state.reservedIpv4.ip);
          await this.#record(state, "original-destroy-reconciled", { dropletId: state.original.id });
        }
      }
      if (!state.original?.deletedAt) await this.#ensureDroplet(state, config, config.baseImage, "original");
    }

    if (!state.original.deletedAt) {
      await this.#ensureReservedIpv4(state, config);
      await this.#assignAddress(state.reservedIpv4.ip, state.original.id);
      await this.#ensureDnsChange(state, config);
      if (!state.checks.some((entry) => entry.name === "original-created")) {
        await this.#verifyEndpoint(state, config, state.original.id, "original-created");
      }

      if (!state.checks.some((entry) => entry.name === "resize-down")) {
        await this.#resizeAndVerify(state, config, state.original, config.resizeDownSize, "resize-down");
      }
      if (!state.checks.some((entry) => entry.name === "resize-up")) {
        await this.#resizeAndVerify(state, config, state.original, config.size, "resize-up");
      }

      if (!state.snapshot) {
        state.phase = "snapshotting";
        await this.store.save(state);
        const pending = state.pending?.snapshotCreate;
        let snapshots = await this.cloud.findSnapshotsByName(config.snapshotName);
        if (!pending) {
          if (snapshots.length > 0) throw new Error("canary snapshot appeared without a prepared mutation");
          await this.#prepareMutation(state, "snapshotCreate", "snapshot-create-prepared", {
            name: config.snapshotName,
            dropletId: String(state.original.id)
          });
        } else if (pending.name !== config.snapshotName || String(pending.dropletId) !== String(state.original.id)) {
          throw new Error("prepared snapshot mutation does not match the exact canary Droplet and name");
        }
        await this.host.prepareForSnapshot(state.original.publicIpv4);
        await this.cloud.waitDropletStatus(state.original.id, "off");
        snapshots = await this.cloud.findSnapshotsByName(config.snapshotName);
        if (snapshots.length === 0) {
          const snapshot = await this.cloud.snapshotDroplet(state.original.id, config.snapshotName);
          snapshots = [snapshot];
        }
        if (snapshots.length !== 1) throw new Error(`expected one canary snapshot, found ${snapshots.length}`);
        state.snapshot = snapshots[0];
        await this.#record(state, "snapshot-created", { snapshotId: state.snapshot.id, name: state.snapshot.name });
      }

      await this.#deleteExactDroplet(state.original, config);
      state.original.deletedAt = this.now().toISOString();
      await this.cloud.waitReservedIpv4Unassigned(state.reservedIpv4.ip);
      await this.#record(state, "original-destroyed", { dropletId: state.original.id });
    }

    if (!state.snapshot || !state.reservedIpv4 || !state.dnsChange) {
      throw new Error("canary replacement prerequisites are incomplete");
    }

    state.phase = "creating-replacement";
    await this.store.save(state);
    await this.#ensureDroplet(state, config, state.snapshot.id, "replacement");
    if (state.replacement.id === state.original.id) throw new Error("snapshot replacement reused the original provider id");
    await this.#assignAddress(state.reservedIpv4.ip, state.replacement.id);
    if (!state.checks.some((entry) => entry.name === "replacement-created")) {
      await this.#verifyEndpoint(state, config, state.replacement.id, "replacement-created");
    }

    state.phase = "verified";
    await this.#record(state, "canary-verified", {
      stableHostname: config.hostname,
      stableReservedIpv4: state.reservedIpv4.ip,
      originalDropletId: state.original.id,
      replacementDropletId: state.replacement.id
    });
    return state;
  }

  async #ensureReservedIpv4(state, config) {
    if (state.reservedIpv4) return state.reservedIpv4;
    const pending = state.pending?.reservedIpv4Create;
    if (!pending) {
      const baseline = new Set(state.baseline.reservedIpv4s);
      const unexpected = (await this.cloud.listReservedIpv4s()).filter((entry) => !baseline.has(entry.ip));
      if (unexpected.length > 0) {
        throw new Error("post-baseline Reserved IPv4 exists without a prepared canary mutation");
      }
      await this.#prepareMutation(state, "reservedIpv4Create", "reserved-ipv4-create-prepared", {
        dropletId: String(state.original.id),
        region: config.region
      });
    } else if (String(pending.dropletId) !== String(state.original.id) || pending.region !== config.region) {
      throw new Error("prepared Reserved IPv4 mutation does not match the exact original canary Droplet");
    }
    const reconcile = async () => {
      const baseline = new Set(state.baseline.reservedIpv4s);
      const candidates = (await this.cloud.listReservedIpv4s()).filter((entry) => !baseline.has(entry.ip));
      if (candidates.length === 0) return null;
      if (candidates.length !== 1) throw new Error(`cannot reconcile canary Reserved IPv4 safely; found ${candidates.length} post-baseline addresses`);
      const address = candidates[0];
      if (address.region !== config.region || String(address.dropletId) !== String(state.original.id)) {
        throw new Error("post-baseline Reserved IPv4 is not attached to the exact canary Droplet");
      }
      return address;
    };
    let address = await reconcile();
    let reconciled = Boolean(address);
    if (!address) {
      try {
        address = await this.cloud.createReservedIpv4ForDroplet(state.original.id);
      } catch (error) {
        address = await reconcile();
        if (!address) throw error;
        reconciled = true;
      }
    }
    if (address.region !== config.region || String(address.dropletId) !== String(state.original.id)) {
      throw new Error("new canary Reserved IPv4 has an unexpected region or assignment");
    }
    address = await this.cloud.waitReservedIpv4Assignment(address.ip, state.original.id);
    state.reservedIpv4 = address;
    await this.#record(state, reconciled ? "reserved-ipv4-reconciled" : "reserved-ipv4-created", {
      ip: address.ip,
      region: address.region,
      dropletId: String(address.dropletId)
    });
    return address;
  }

  async #ensureDnsChange(state, config) {
    if (state.dnsChange) return state.dnsChange;
    const pending = state.pending?.dnsCreate;
    if (!pending) {
      const existing = await this.dns.inspectHostname({ zone: config.zone, hostname: config.hostname });
      if (existing.length > 0) throw new Error("canary DNS appeared without a prepared mutation");
      await this.#prepareMutation(state, "dnsCreate", "dns-create-prepared", {
        hostname: config.hostname,
        value: state.reservedIpv4.ip,
        ttl: config.ttl
      });
    } else if (pending.hostname !== config.hostname || pending.value !== state.reservedIpv4.ip || pending.ttl !== config.ttl) {
      throw new Error("prepared DNS mutation does not match the exact canary endpoint");
    }
    const adoptCreatedRecord = async () => {
      const records = await this.dns.inspectHostname({ zone: config.zone, hostname: config.hostname });
      if (records.length === 0) return null;
      if (records.length !== 1 || records[0].type !== "A" || records[0].value !== state.reservedIpv4.ip) {
        throw new Error("cannot reconcile canary DNS because the unique hostname has an unexpected record");
      }
      return { action: "created", recordId: records[0].id, previous: null };
    };
    let change = await adoptCreatedRecord();
    let reconciled = Boolean(change);
    if (!change) {
      try {
        change = await this.dns.upsertARecord({ zone: config.zone, hostname: config.hostname, value: state.reservedIpv4.ip, ttl: config.ttl });
      } catch (error) {
        change = await adoptCreatedRecord();
        if (!change) throw error;
        reconciled = true;
      }
    }
    if (change.action !== "created") throw new Error("canary DNS hostname was not absent at creation time");
    state.dnsChange = change;
    await this.#record(state, reconciled ? "dns-create-reconciled" : "dns-created", {
      hostname: config.hostname,
      action: change.action,
      recordId: change.recordId
    });
    return change;
  }

  async #ensureDroplet(state, config, image, stage) {
    const existing = state[stage];
    if (existing?.id) {
      let current = await this.cloud.getDroplet(existing.id);
      assertCanaryDroplet(current, config);
      const wasOff = current.status === "off";
      if (wasOff) await this.cloud.powerOnDroplet(existing.id);
      if (current.status !== "active" || !current.publicIpv4) current = await this.cloud.waitDropletActive(existing.id);
      await this.host.waitReady(current.publicIpv4, stage === "replacement" || wasOff);
      state[stage] = { ...existing, ...current };
      await this.store.save(state);
      return state[stage];
    }
    const candidates = await this.cloud.findDropletsByName(config.name);
    const tagged = candidates.filter((entry) => entry.tags.includes(config.tag));
    if (candidates.length > 0 && tagged.length !== 1) throw new Error(`cannot reconcile ${stage} canary Droplet safely`);
    const pendingKey = `${stage}DropletCreate`;
    if (tagged.length > 0 && !state.pending?.[pendingKey]) {
      throw new Error(`cannot reconcile ${stage} canary Droplet without a prepared mutation`);
    }
    let droplet = tagged[0] ?? null;
    if (!droplet) {
      await this.#prepareMutation(state, pendingKey, `${stage}-create-prepared`, {
        name: config.name,
        tag: config.tag,
        region: config.region,
        size: config.size,
        image: String(image)
      });
      try {
        droplet = await this.cloud.createDroplet({
          name: config.name,
          region: config.region,
          size: config.size,
          image,
          tags: [config.tag],
          userDataProfile: "canary",
          userDataSha256: config.cloudInitSha256
        });
      } catch (error) {
        const after = (await this.cloud.findDropletsByName(config.name)).filter((entry) => entry.tags.includes(config.tag));
        if (after.length !== 1) throw error;
        droplet = after[0];
      }
    }
    assertCanaryDroplet(droplet, config);
    droplet = await this.cloud.waitDropletActive(droplet.id);
    assertCanaryDroplet(droplet, config);
    await this.host.waitReady(droplet.publicIpv4, stage === "replacement");
    const value = { ...droplet, stage, createdAt: droplet.createdAt ?? this.now().toISOString(), deletedAt: null };
    state[stage] = value;
    await this.#record(state, `${stage}-active`, { dropletId: value.id, publicIpv4: value.publicIpv4, size: value.size });
    return value;
  }

  async #assignAddress(ip, dropletId) {
    const current = await this.cloud.getReservedIpv4(ip);
    if (String(current.dropletId) === String(dropletId)) return;
    if (current.dropletId !== null) throw new Error(`canary Reserved IPv4 is assigned to unexpected Droplet ${current.dropletId}`);
    await this.cloud.assignReservedIpv4(ip, dropletId);
    await this.cloud.waitReservedIpv4Assignment(ip, dropletId);
  }

  async #resizeAndVerify(state, config, resource, size, checkName) {
    let current = await this.cloud.getDroplet(resource.id);
    assertCanaryDroplet(current, config);
    if (current.status !== "off") {
      await this.cloud.powerOffDroplet(current.id);
      current = await this.cloud.waitDropletStatus(current.id, "off");
    }
    if (current.size !== size) {
      await this.cloud.resizeDroplet(current.id, size);
      current = await this.cloud.getDroplet(current.id);
      if (current.size !== size) throw new Error(`${checkName} expected size ${size}, got ${current.size}`);
    }
    await this.cloud.powerOnDroplet(current.id);
    current = await this.cloud.waitDropletActive(current.id);
    await this.host.waitReady(current.publicIpv4, false);
    await this.#verifyEndpoint(state, config, current.id, checkName);
    resource.status = current.status;
    resource.size = current.size;
    resource.publicIpv4 = current.publicIpv4;
    resource.privateIpv4 = current.privateIpv4;
  }

  async #verifyEndpoint(state, config, expectedId, name) {
    if (!await this.dns.verifyARecord({ zone: config.zone, hostname: config.hostname, value: state.reservedIpv4.ip })) {
      throw new Error(`canary DNS did not resolve ${config.hostname} to the Reserved IPv4`);
    }
    const deadline = Date.now() + this.healthTimeoutMs;
    let payload = null;
    while (Date.now() <= deadline) {
      try {
        const response = await this.fetchImpl(`http://${config.hostname}/health.json`, {
          headers: { "Cache-Control": "no-cache" },
          signal: AbortSignal.timeout(5_000)
        });
        if (response.ok) {
          payload = await response.json();
          if (payload?.status === "ok" && String(payload.instanceId) === String(expectedId) && payload.region === config.region) break;
        }
      } catch {}
      payload = null;
      await delay(this.pollIntervalMs);
    }
    if (!payload) throw new Error(`canary HTTP health did not identify Droplet ${expectedId}`);
    const check = { name, checkedAt: this.now().toISOString(), dropletId: String(expectedId), hostname: config.hostname, reservedIpv4: state.reservedIpv4.ip, status: "PASS" };
    state.checks.push(check);
    await this.#record(state, "endpoint-check-passed", check);
  }

  async #deleteExactDroplet(resource, config) {
    let current;
    try {
      current = await this.cloud.getDroplet(resource.id);
    } catch (error) {
      if (error?.status === 404) return;
      throw error;
    }
    assertCanaryDroplet(current, config);
    if (this.#isBaselineId(resource.id, await this.store.load())) throw new Error("refusing to delete a baseline Droplet id");
    await this.cloud.deleteDroplet(resource.id);
    await this.cloud.waitDropletAbsent(resource.id);
  }

  async #cleanup(state, config) {
    state.phase = "cleaning";
    await this.store.save(state);
    const errors = [];
    const attempt = async (name, operation) => {
      try {
        await operation();
        state.cleanup[name] = { status: "done", at: this.now().toISOString() };
        await this.#record(state, `cleanup-${name}`, { status: "done" });
      } catch (error) {
        errors.push(`${name}: ${sanitizedError(error)}`);
        state.cleanup[name] = { status: "failed", at: this.now().toISOString(), message: sanitizedError(error) };
        await this.store.save(state);
      }
    };

    await attempt("dns", async () => {
      if (!state.dnsChange && state.pending?.dnsCreate) {
        const records = await this.dns.inspectHostname({ zone: config.zone, hostname: config.hostname });
        if (records.length > 1) throw new Error("multiple canary DNS records exist during cleanup reconciliation");
        if (records.length === 1) {
          const pending = state.pending.dnsCreate;
          if (records[0].type !== "A" || records[0].value !== pending.value || pending.hostname !== config.hostname) {
            throw new Error("prepared canary DNS record has unexpected cleanup identity");
          }
          state.dnsChange = { action: "created", recordId: records[0].id, previous: null };
          await this.#record(state, "cleanup-dns-reconciled", { hostname: config.hostname, recordId: records[0].id });
        }
      }
      if (state.dnsChange) await this.dns.restoreRecord({ zone: config.zone, hostname: config.hostname, change: state.dnsChange });
      if (!await this.dns.waitHostnameAbsent({ zone: config.zone, hostname: config.hostname })) throw new Error("canary DNS record still exists");
    });
    await attempt("reservedIpv4Ownership", async () => {
      if (state.reservedIpv4?.ip || !state.pending?.reservedIpv4Create) return;
      const baseline = new Set(state.baseline.reservedIpv4s);
      const candidates = (await this.cloud.listReservedIpv4s()).filter((entry) => !baseline.has(entry.ip));
      if (candidates.length === 0) return;
      if (candidates.length !== 1) throw new Error(`cannot reconcile cleanup Reserved IPv4 safely; found ${candidates.length} post-baseline addresses`);
      const candidate = candidates[0];
      const pending = state.pending.reservedIpv4Create;
      if (candidate.region !== pending.region) throw new Error("cleanup Reserved IPv4 region differs from prepared mutation");
      if (candidate.dropletId !== null && String(candidate.dropletId) !== String(pending.dropletId)) {
        throw new Error("cleanup Reserved IPv4 is attached to an unexpected Droplet");
      }
      if (candidate.dropletId === null) {
        try {
          await this.cloud.getDroplet(pending.dropletId);
          throw new Error("unassigned cleanup Reserved IPv4 cannot be attributed while its prepared Droplet still exists");
        } catch (error) {
          if (error?.status !== 404) throw error;
        }
        if (String(state.original?.id) !== String(pending.dropletId)) {
          throw new Error("unassigned cleanup Reserved IPv4 lacks the recorded original Droplet identity");
        }
      }
      state.reservedIpv4 = candidate;
      await this.#record(state, "cleanup-reserved-ipv4-reconciled", { ip: candidate.ip, region: candidate.region });
    });
    for (const key of ["replacement", "original"]) {
      await attempt(key, async () => {
        if (state[key]?.id) await this.#deleteExactDroplet(state[key], config);
      });
    }
    await attempt("unrecordedDroplet", async () => {
      const [byName, byTag] = await Promise.all([
        this.cloud.findDropletsByName(config.name),
        this.cloud.listDropletsByTag(config.tag)
      ]);
      if (byName.length === 0 && byTag.length === 0) return;
      if (byName.length !== 1 || byTag.length !== 1 || String(byName[0].id) !== String(byTag[0].id)) {
        throw new Error("cannot reconcile unrecorded canary Droplet safely");
      }
      const candidate = byName[0];
      const pending = [state.pending?.originalDropletCreate, state.pending?.replacementDropletCreate]
        .filter(Boolean)
        .find((entry) => entry.name === candidate.name && entry.tag === config.tag && entry.region === candidate.region);
      if (!pending) throw new Error("unrecorded canary Droplet lacks a prepared mutation");
      if (candidate.size !== pending.size || String(candidate.image) !== String(pending.image)) {
        throw new Error("unrecorded canary Droplet differs from its prepared size or image");
      }
      assertCanaryDroplet(candidate, config);
      await this.#deleteExactDroplet(candidate, config);
    });
    await attempt("reservedIpv4", async () => {
      if (!state.reservedIpv4?.ip) return;
      try {
        await this.cloud.getReservedIpv4(state.reservedIpv4.ip);
        await this.cloud.waitReservedIpv4Unassigned(state.reservedIpv4.ip);
        await this.cloud.deleteReservedIpv4(state.reservedIpv4.ip);
        await this.cloud.getReservedIpv4(state.reservedIpv4.ip);
        throw new Error("Reserved IPv4 still exists after deletion");
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
    });
    await attempt("snapshot", async () => {
      const matches = await this.cloud.findSnapshotsByName(config.snapshotName);
      if (matches.length > 1) throw new Error("multiple canary snapshots exist");
      if (matches.length === 1) {
        const pending = state.pending?.snapshotCreate;
        if (!state.snapshot?.id && (!pending || pending.name !== config.snapshotName)) {
          throw new Error("canary snapshot lacks a recorded or prepared mutation");
        }
        if (state.snapshot?.id && matches[0].id !== state.snapshot.id) throw new Error("canary snapshot identity changed");
        await this.cloud.deleteImage(matches[0].id);
      }
      if ((await this.cloud.findSnapshotsByName(config.snapshotName)).length !== 0) throw new Error("canary snapshot still exists");
    });
    await attempt("tag", async () => {
      if (await this.cloud.tagExists(config.tag)) {
        const pending = state.pending?.tagCreate;
        if (!state.cleanup.tagCreated && (!pending || pending.tag !== config.tag)) {
          throw new Error("canary tag lacks a recorded or prepared mutation");
        }
        await this.cloud.deleteTag(config.tag);
      }
      if (await this.cloud.tagExists(config.tag)) throw new Error("canary tag still exists");
    });
    await attempt("inventory", async () => {
      const [byName, byTag, all, reservedIpv4s] = await Promise.all([
        this.cloud.findDropletsByName(config.name),
        this.cloud.listDropletsByTag(config.tag),
        this.cloud.listAllDroplets(),
        this.cloud.listReservedIpv4s()
      ]);
      if (byName.length || byTag.length) throw new Error("canary Droplet inventory is not empty");
      const currentIds = new Set(all.map((entry) => entry.id));
      const missingBaseline = state.baseline.dropletIds.filter((id) => !currentIds.has(id));
      if (missingBaseline.length) throw new Error(`baseline Droplet ids disappeared: ${missingBaseline.join(",")}`);
      const currentReservedIpv4s = reservedIpv4s.map((entry) => entry.ip).sort();
      if (JSON.stringify(currentReservedIpv4s) !== JSON.stringify(state.baseline.reservedIpv4s)) {
        throw new Error("Reserved IPv4 inventory differs from the protected preflight baseline");
      }
    });
    if (errors.length) throw new Error(errors.join("; "));
    state.phase = state.failure ? "cleaned-after-failure" : "cleaned";
    state.completedAt = this.now().toISOString();
    state.classification = state.failure ? "FAIL" : "PASS";
    await this.#record(state, "cleanup-proved", {
      baselineDropletsPreserved: state.baseline.dropletIds.length,
      canaryDropletsRemaining: 0,
      canaryDnsRecordsRemaining: 0,
      canarySnapshotsRemaining: 0,
      canaryReservedIpv4Remaining: 0
    });
    return state;
  }

  async #record(state, event, details) {
    state.updatedAt = this.now().toISOString();
    state.timeline = Array.isArray(state.timeline) ? state.timeline : [];
    state.timeline.push({ at: state.updatedAt, event, details });
    await this.store.save(state);
  }

  async #prepareMutation(state, key, event, details) {
    state.pending = state.pending ?? {};
    if (state.pending[key]) return state.pending[key];
    state.pending[key] = { preparedAt: this.now().toISOString(), ...details };
    await this.#record(state, event, details);
    return state.pending[key];
  }

  #isBaselineId(id, state) {
    return state.baseline.dropletIds.includes(String(id));
  }
}

export class CanaryStateStore {
  constructor(path) {
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(value) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async withLock(operation) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`canary lock already exists at ${this.lockPath}`);
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

export class CanarySshHost {
  constructor({ privateKey, knownHostsPath, runner = runCommand, pollIntervalMs = 3_000, timeoutMs = 180_000 }) {
    this.privateKey = resolve(privateKey);
    this.knownHostsPath = resolve(knownHostsPath);
    this.runner = runner;
    this.pollIntervalMs = pollIntervalMs;
    this.timeoutMs = timeoutMs;
  }

  async waitReady(ip, replaceHostKey) {
    await assertProtectedFile(this.privateKey, "canary SSH private key");
    await mkdir(dirname(this.knownHostsPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.knownHostsPath), 0o700);
    if (replaceHostKey) await this.runner("ssh-keygen", ["-R", ip, "-f", this.knownHostsPath], { allowFailure: true });
    let captured = false;
    const deadline = Date.now() + this.timeoutMs;
    let lastError;
    while (Date.now() <= deadline) {
      try {
        if (!captured) {
          const scan = await this.runner("ssh-keyscan", ["-T", "5", "-H", ip], { capture: true });
          if (!scan.stdout.trim()) throw new Error("SSH host key scan returned no keys");
          await writeFile(this.knownHostsPath, scan.stdout, { flag: "a", mode: 0o600 });
          await chmod(this.knownHostsPath, 0o600);
          captured = true;
        }
        await this.#ssh(ip, "cloud-init status --wait >/dev/null && systemctl is-active --quiet scorecheck-lifecycle-canary.service");
        return true;
      } catch (error) {
        lastError = error;
        await delay(this.pollIntervalMs);
      }
    }
    throw new Error(`canary SSH/cloud-init did not become ready: ${sanitizedError(lastError)}`);
  }

  async prepareForSnapshot(ip) {
    const command = "nohup /bin/sh -c 'sleep 2; cloud-init clean --logs --machine-id; rm -f /etc/ssh/ssh_host_*; sync; systemctl poweroff' >/root/scorecheck-canary-snapshot-prep.log 2>&1 </dev/null &";
    await this.#ssh(ip, command);
  }

  async #ssh(ip, command) {
    return this.runner("ssh", [
      "-i", this.privateKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
      "-o", "ConnectTimeout=10",
      `root@${ip}`,
      command
    ], { capture: true });
  }
}

export function buildCanaryConfig({ runId, cloudInitSource, zone = "beachvolleyballmedia.com", region = "sfo2", size = "c-4", resizeDownSize = "c-2", baseImage = "ubuntu-24-04-x64", ttl = 60 }) {
  if (typeof runId !== "string" || !/^[a-z0-9]{8,24}$/.test(runId)) throw new Error("canary run id must be 8-24 lowercase letters or digits");
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    runId,
    name: `scorecheck-lifecycle-canary-${runId}`,
    tag: `scorecheck-lifecycle-canary:${runId}`,
    snapshotName: `scorecheck-lifecycle-canary-${runId}`,
    hostname: `lifecycle-${runId}.${zone}`,
    zone,
    region,
    size,
    resizeDownSize,
    baseImage,
    ttl,
    cloudInitSha256: sha256(cloudInitSource)
  };
}

export async function readCanaryEvidence(path) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("canary evidence must be a protected regular file");
  return JSON.parse(await readFile(path, "utf8"));
}

function validateCanaryConfig(config) {
  if (!config || config.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`canary config schemaVersion must be ${STATE_SCHEMA_VERSION}`);
  }
  for (const key of ["runId", "name", "tag", "snapshotName", "hostname", "zone", "region", "size", "resizeDownSize", "baseImage", "cloudInitSha256"]) {
    if (typeof config[key] !== "string" || !config[key]) throw new Error(`canary config ${key} is invalid`);
  }
  if (!Number.isInteger(config.ttl) || config.ttl < 60 || config.ttl > 86_400) throw new Error("canary TTL is invalid");
}

function assertStateMatchesConfig(state, config) {
  if (state.schemaVersion !== STATE_SCHEMA_VERSION || state.runId !== config.runId) throw new Error("canary state does not match this run");
  if (JSON.stringify(state.identity) !== JSON.stringify(pickIdentity(config))) throw new Error("canary state identity differs from the requested config");
}

function pickIdentity(config) {
  return Object.fromEntries(["name", "tag", "snapshotName", "hostname", "zone", "region", "size", "resizeDownSize", "baseImage", "cloudInitSha256"].map((key) => [key, config[key]]));
}

function assertCanaryDroplet(droplet, config) {
  const problems = [];
  if (droplet.name !== config.name) problems.push(`name ${droplet.name}`);
  if (droplet.region !== config.region) problems.push(`region ${droplet.region}`);
  if (!droplet.tags.includes(config.tag)) problems.push(`missing tag ${config.tag}`);
  if (problems.length) throw new Error(`canary Droplet identity mismatch: ${problems.join("; ")}`);
}

async function assertProtectedFile(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be mode 0600 or stricter`);
}

function sanitizedError(error) {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code === 0 || options.allowFailure) resolvePromise(result);
      else rejectPromise(new Error(`${command} failed with exit ${code}: ${stderr.trim()}`));
    });
  });
}

export const CANARY_CONFIRMATION = CONFIRMATION;
