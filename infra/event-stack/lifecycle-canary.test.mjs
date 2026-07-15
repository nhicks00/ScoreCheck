import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildCanaryConfig, CANARY_CONFIRMATION, CanaryStateStore, LifecycleCanary } from "./lifecycle-canary.mjs";

function fixture(overrides = {}) {
  const cloud = overrides.cloud ?? new FakeCloud();
  const dns = overrides.dns ?? new FakeDns();
  const host = overrides.host ?? new FakeHost();
  const source = "#cloud-config\nruncmd: []\n";
  const config = buildCanaryConfig({ runId: "20260715a", cloudInitSource: source });
  return { cloud, dns, host, config, source };
}

function interruptedState(config, overrides = {}) {
  const identity = Object.fromEntries([
    "name",
    "tag",
    "snapshotName",
    "hostname",
    "zone",
    "region",
    "size",
    "resizeDownSize",
    "baseImage",
    "cloudInitSha256"
  ].map((key) => [key, config[key]]));
  return {
    schemaVersion: config.schemaVersion,
    runId: config.runId,
    phase: "creating-original",
    identity,
    baseline: {
      capturedAt: "2026-07-15T00:00:00.000Z",
      accountUuid: "account-uuid",
      accountDropletLimit: 10,
      dropletIds: ["10", "11"],
      reservedIpv4s: []
    },
    original: null,
    replacement: null,
    reservedIpv4: null,
    dnsChange: null,
    snapshot: null,
    checks: [],
    cleanup: {},
    pending: {},
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: null,
    ...overrides
  };
}

test("proves resize, snapshot replacement, stable endpoint, exact cleanup, and baseline preservation", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-"));
  const statePath = join(root, "evidence", "canary.json");
  const setup = fixture();
  const canary = new LifecycleCanary({
    cloud: setup.cloud,
    dns: setup.dns,
    host: setup.host,
    store: new CanaryStateStore(statePath),
    fetchImpl: healthFetch(setup.cloud),
    pollIntervalMs: 1,
    healthTimeoutMs: 100
  });

  const result = await canary.run(setup.config, CANARY_CONFIRMATION);
  assert.equal(result.phase, "cleaned");
  assert.equal(result.classification, "PASS");
  assert.notEqual(result.original.id, result.replacement.id);
  assert.equal(result.checks.length, 4);
  assert.deepEqual(result.checks.map((entry) => entry.name), ["original-created", "resize-down", "resize-up", "replacement-created"]);
  assert.deepEqual([...setup.cloud.droplets.keys()].sort(), ["10", "11"]);
  assert.equal(setup.cloud.addresses.size, 0);
  assert.equal(setup.cloud.snapshots.size, 0);
  assert.equal(setup.cloud.tags.size, 0);
  assert.equal(setup.dns.records.size, 0);
  assert.deepEqual(setup.cloud.deletedIds.sort(), [result.original.id, result.replacement.id].sort());
  assert.deepEqual(setup.cloud.assignCalls, [{ ip: "192.0.2.50", dropletId: result.replacement.id }]);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).classification, "PASS");
});

test("failure remains classified FAIL while exact cleanup still restores the baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-fail-"));
  const statePath = join(root, "canary.json");
  const cloud = new FakeCloud();
  cloud.failResize = true;
  const setup = fixture({ cloud });
  const canary = new LifecycleCanary({
    cloud,
    dns: setup.dns,
    host: setup.host,
    store: new CanaryStateStore(statePath),
    fetchImpl: healthFetch(cloud),
    pollIntervalMs: 1,
    healthTimeoutMs: 100
  });

  await assert.rejects(() => canary.run(setup.config, CANARY_CONFIRMATION), /execution: injected resize failure/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.phase, "cleaned-after-failure");
  assert.equal(state.classification, "FAIL");
  assert.match(state.failure, /injected resize failure/);
  assert.deepEqual([...cloud.droplets.keys()].sort(), ["10", "11"]);
  assert.equal(cloud.addresses.size, 0);
  assert.equal(setup.dns.records.size, 0);
});

test("resumes exact orphan cleanup after delete permissions are repaired", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-cleanup-resume-"));
  const statePath = join(root, "canary.json");
  const cloud = new FakeCloud();
  cloud.failResize = true;
  cloud.failReservedIpv4Delete = true;
  cloud.failTagDelete = true;
  const setup = fixture({ cloud });
  const canary = new LifecycleCanary({
    cloud,
    dns: setup.dns,
    host: setup.host,
    store: new CanaryStateStore(statePath),
    fetchImpl: healthFetch(cloud),
    pollIntervalMs: 1,
    healthTimeoutMs: 100
  });

  await assert.rejects(
    () => canary.run(setup.config, CANARY_CONFIRMATION),
    /cleanup: reservedIpv4: injected Reserved IPv4 delete denial; tag: injected tag delete denial/u
  );
  const failed = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(failed.phase, "cleanup-failed");
  assert.equal(failed.reservedIpv4.dropletId, "100");
  assert.equal(cloud.addresses.get(failed.reservedIpv4.ip).dropletId, null);
  assert.equal(cloud.tags.has(setup.config.tag), true);
  assert.deepEqual([...cloud.droplets.keys()].sort(), ["10", "11"]);

  cloud.failReservedIpv4Delete = false;
  cloud.failTagDelete = false;
  const recovered = await canary.cleanup(setup.config, CANARY_CONFIRMATION);
  assert.equal(recovered.phase, "cleaned-after-failure");
  assert.equal(recovered.classification, "FAIL");
  assert.match(recovered.failure, /injected resize failure/u);
  assert.equal(cloud.addresses.size, 0);
  assert.equal(cloud.tags.size, 0);
  assert.deepEqual([...cloud.droplets.keys()].sort(), ["10", "11"]);
});

test("cleanup deletes an unrecorded exact Droplet only with durable prepared ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-unrecorded-droplet-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  const created = droplet("100", setup.config.name, setup.config.tag);
  setup.cloud.droplets.set(created.id, created);
  setup.cloud.tags.add(setup.config.tag);
  await store.save(interruptedState(setup.config, {
    cleanup: { tagCreated: true },
    pending: {
      originalDropletCreate: {
        preparedAt: "2026-07-15T00:00:01.000Z",
        name: setup.config.name,
        tag: setup.config.tag,
        region: setup.config.region,
        size: setup.config.size,
        image: setup.config.baseImage
      }
    }
  }));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });

  const result = await canary.cleanup(setup.config, CANARY_CONFIRMATION);
  assert.equal(result.phase, "cleaned");
  assert.deepEqual(setup.cloud.deletedIds, ["100"]);
  assert.deepEqual([...setup.cloud.droplets.keys()].sort(), ["10", "11"]);
});

test("cleanup refuses an unrecorded Droplet without durable prepared ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-unowned-droplet-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  const created = droplet("100", setup.config.name, setup.config.tag);
  setup.cloud.droplets.set(created.id, created);
  await store.save(interruptedState(setup.config));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });

  await assert.rejects(() => canary.cleanup(setup.config, CANARY_CONFIRMATION), /lacks a prepared mutation/u);
  assert.equal(setup.cloud.droplets.has("100"), true);
  assert.deepEqual(setup.cloud.deletedIds, []);
});

test("cleanup reconciles exact DNS and Reserved IPv4 mutations lost before state recording", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-unrecorded-endpoint-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  const original = droplet("100", setup.config.name, setup.config.tag);
  const address = { ip: "192.0.2.50", region: setup.config.region, dropletId: original.id, locked: false };
  setup.cloud.droplets.set(original.id, original);
  setup.cloud.addresses.set(address.ip, address);
  setup.cloud.tags.add(setup.config.tag);
  setup.dns.records.set(setup.config.hostname, {
    id: "1",
    name: setup.config.hostname,
    type: "A",
    value: address.ip,
    ttl: setup.config.ttl
  });
  await store.save(interruptedState(setup.config, {
    original: { ...original, stage: "original", deletedAt: null },
    cleanup: { tagCreated: true },
    pending: {
      originalDropletCreate: {
        preparedAt: "2026-07-15T00:00:01.000Z",
        name: setup.config.name,
        tag: setup.config.tag,
        region: setup.config.region,
        size: setup.config.size,
        image: setup.config.baseImage
      },
      reservedIpv4Create: {
        preparedAt: "2026-07-15T00:00:02.000Z",
        dropletId: original.id,
        region: setup.config.region
      },
      dnsCreate: {
        preparedAt: "2026-07-15T00:00:03.000Z",
        hostname: setup.config.hostname,
        value: address.ip,
        ttl: setup.config.ttl
      }
    }
  }));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });

  const result = await canary.cleanup(setup.config, CANARY_CONFIRMATION);
  assert.equal(result.phase, "cleaned");
  assert.ok(result.timeline.some((entry) => entry.event === "cleanup-dns-reconciled"));
  assert.ok(result.timeline.some((entry) => entry.event === "cleanup-reserved-ipv4-reconciled"));
  assert.equal(setup.dns.records.size, 0);
  assert.equal(setup.cloud.addresses.size, 0);
  assert.deepEqual([...setup.cloud.droplets.keys()].sort(), ["10", "11"]);
});

test("cleanup leaves a post-baseline Reserved IPv4 untouched without prepared ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-unowned-address-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  setup.cloud.addresses.set("192.0.2.50", { ip: "192.0.2.50", region: setup.config.region, dropletId: null, locked: false });
  await store.save(interruptedState(setup.config));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });

  await assert.rejects(() => canary.cleanup(setup.config, CANARY_CONFIRMATION), /Reserved IPv4 inventory differs/u);
  assert.equal(setup.cloud.addresses.has("192.0.2.50"), true);
});

test("cleanup reconciles a tag created after durable preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-unrecorded-tag-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  setup.cloud.tags.add(setup.config.tag);
  await store.save(interruptedState(setup.config, {
    pending: {
      tagCreate: {
        preparedAt: "2026-07-15T00:00:01.000Z",
        tag: setup.config.tag
      }
    }
  }));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });

  const result = await canary.cleanup(setup.config, CANARY_CONFIRMATION);
  assert.equal(result.phase, "cleaned");
  assert.equal(setup.cloud.tags.has(setup.config.tag), false);
});

test("cleanup leaves an unowned tag untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-unowned-tag-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  setup.cloud.tags.add(setup.config.tag);
  await store.save(interruptedState(setup.config));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });

  await assert.rejects(() => canary.cleanup(setup.config, CANARY_CONFIRMATION), /tag lacks a recorded or prepared mutation/u);
  assert.equal(setup.cloud.tags.has(setup.config.tag), true);
});

test("cleanup reconciles a snapshot created after durable preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-unrecorded-snapshot-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  setup.cloud.snapshots.set("500", { id: "500", name: setup.config.snapshotName, regions: [setup.config.region] });
  await store.save(interruptedState(setup.config, {
    pending: {
      snapshotCreate: {
        preparedAt: "2026-07-15T00:00:01.000Z",
        name: setup.config.snapshotName,
        dropletId: "100"
      }
    }
  }));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });

  const result = await canary.cleanup(setup.config, CANARY_CONFIRMATION);
  assert.equal(result.phase, "cleaned");
  assert.equal(setup.cloud.snapshots.size, 0);
});

test("cleanup leaves an unowned snapshot untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-unowned-snapshot-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  setup.cloud.snapshots.set("500", { id: "500", name: setup.config.snapshotName, regions: [setup.config.region] });
  await store.save(interruptedState(setup.config));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });

  await assert.rejects(() => canary.cleanup(setup.config, CANARY_CONFIRMATION), /snapshot lacks a recorded or prepared mutation/u);
  assert.equal(setup.cloud.snapshots.has("500"), true);
});

test("reconciles lost create responses for the canary Reserved IPv4 and DNS record", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-reconcile-"));
  const cloud = new FakeCloud();
  const dns = new FakeDns();
  cloud.failReservedIpv4ResponseOnce = true;
  dns.failCreateResponseOnce = true;
  const setup = fixture({ cloud, dns });
  const canary = new LifecycleCanary({
    cloud,
    dns,
    host: setup.host,
    store: new CanaryStateStore(join(root, "state.json")),
    fetchImpl: healthFetch(cloud),
    pollIntervalMs: 1,
    healthTimeoutMs: 100
  });

  const result = await canary.run(setup.config, CANARY_CONFIRMATION);
  assert.equal(result.classification, "PASS");
  assert.ok(result.timeline.some((entry) => entry.event === "reserved-ipv4-reconciled"));
  assert.ok(result.timeline.some((entry) => entry.event === "dns-create-reconciled"));
  assert.equal(cloud.addresses.size, 0);
  assert.equal(dns.records.size, 0);
});

test("requires exact destructive confirmation and rejects pre-existing identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-confirm-"));
  const setup = fixture();
  const store = new CanaryStateStore(join(root, "state.json"));
  const canary = new LifecycleCanary({ cloud: setup.cloud, dns: setup.dns, host: setup.host, store, fetchImpl: healthFetch(setup.cloud) });
  await assert.rejects(() => canary.run(setup.config, "yes"), /exact confirmation/);
  setup.cloud.droplets.set("99", droplet("99", setup.config.name, setup.config.tag));
  await assert.rejects(() => canary.run(setup.config, CANARY_CONFIRMATION), /identity collides/);
  assert.equal(setup.cloud.deletedIds.length, 0);
});

test("rejects a pre-existing empty tag before making any provider mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-canary-empty-tag-"));
  const setup = fixture();
  setup.cloud.tags.add(setup.config.tag);
  const canary = new LifecycleCanary({
    cloud: setup.cloud,
    dns: setup.dns,
    host: setup.host,
    store: new CanaryStateStore(join(root, "state.json")),
    fetchImpl: healthFetch(setup.cloud)
  });

  await assert.rejects(() => canary.run(setup.config, CANARY_CONFIRMATION), /identity collides/u);
  assert.deepEqual([...setup.cloud.droplets.keys()].sort(), ["10", "11"]);
  assert.equal(setup.cloud.deletedIds.length, 0);
});

function healthFetch(cloud) {
  return async () => {
    const address = [...cloud.addresses.values()][0];
    const payload = { status: "ok", instanceId: address?.dropletId, region: "sfo2" };
    return { ok: true, status: 200, async json() { return payload; } };
  };
}

class FakeHost {
  calls = [];
  async waitReady(ip, replacement) { this.calls.push(["ready", ip, replacement]); }
  async prepareForSnapshot(ip) { this.calls.push(["snapshot", ip]); }
}

class FakeDns {
  records = new Map();
  nextId = 1;
  failCreateResponseOnce = false;

  async inspectHostname({ hostname }) {
    return this.records.has(hostname) ? [this.records.get(hostname)] : [];
  }

  async upsertARecord({ hostname, value, ttl }) {
    if (this.records.has(hostname)) throw new Error("test expected an absent hostname");
    const record = { id: String(this.nextId++), name: hostname, type: "A", value, ttl };
    this.records.set(hostname, record);
    if (this.failCreateResponseOnce) {
      this.failCreateResponseOnce = false;
      throw new Error("injected DNS response loss");
    }
    return { action: "created", recordId: record.id, previous: null };
  }

  async verifyARecord({ hostname, value }) {
    return this.records.get(hostname)?.value === value;
  }

  async restoreRecord({ hostname, change }) {
    if (change.action === "created") this.records.delete(hostname);
  }

  async waitHostnameAbsent({ hostname }) { return !this.records.has(hostname); }
}

class FakeCloud {
  droplets = new Map([
    ["10", droplet("10", "existing-a", "existing")],
    ["11", droplet("11", "existing-b", "existing")]
  ]);
  addresses = new Map();
  snapshots = new Map();
  tags = new Set();
  deletedIds = [];
  nextId = 100;
  failResize = false;
  failReservedIpv4ResponseOnce = false;
  failReservedIpv4Delete = false;
  failTagDelete = false;
  assignCalls = [];

  async getAccount() { return { uuid: "account-uuid", status: "active", dropletLimit: 10 }; }
  async listAllDroplets() { return [...this.droplets.values()].map(clone); }
  async findDropletsByName(name) { return (await this.listAllDroplets()).filter((entry) => entry.name === name); }
  async listDropletsByTag(tag) { return (await this.listAllDroplets()).filter((entry) => entry.tags.includes(tag)); }
  async listReservedIpv4s() { return [...this.addresses.values()].map(clone); }
  async findSnapshotsByName(name) { return [...this.snapshots.values()].filter((entry) => entry.name === name).map(clone); }
  async ensureTag(name) { this.tags.add(name); }
  async deleteTag(name) {
    if (this.failTagDelete) throw new Error("injected tag delete denial");
    this.tags.delete(name);
  }
  async tagExists(name) { return this.tags.has(name); }

  async createDroplet(request) {
    const id = String(this.nextId++);
    const value = droplet(id, request.name, request.tags[0], request.size, request.image);
    this.droplets.set(id, value);
    return clone(value);
  }

  async getDroplet(id) {
    const value = this.droplets.get(String(id));
    if (!value) throw notFound();
    return clone(value);
  }

  async waitDropletActive(id) {
    const value = this.droplets.get(String(id));
    value.status = "active";
    return clone(value);
  }

  async waitDropletStatus(id, status) {
    const value = this.droplets.get(String(id));
    value.status = status;
    return clone(value);
  }

  async deleteDroplet(id) {
    id = String(id);
    if (!this.droplets.has(id)) throw notFound();
    this.droplets.delete(id);
    this.deletedIds.push(id);
    for (const address of this.addresses.values()) if (address.dropletId === id) address.dropletId = null;
  }

  async waitDropletAbsent(id) { return !this.droplets.has(String(id)); }
  async createReservedIpv4ForDroplet(dropletId) {
    const value = { ip: "192.0.2.50", region: "sfo2", dropletId: String(dropletId), locked: false };
    this.addresses.set(value.ip, value);
    if (this.failReservedIpv4ResponseOnce) {
      this.failReservedIpv4ResponseOnce = false;
      throw new Error("injected Reserved IPv4 response loss");
    }
    return clone(value);
  }
  async getReservedIpv4(ip) {
    const value = this.addresses.get(ip);
    if (!value) throw notFound();
    return clone(value);
  }
  async assignReservedIpv4(ip, dropletId) {
    this.assignCalls.push({ ip, dropletId: String(dropletId) });
    this.addresses.get(ip).dropletId = String(dropletId);
  }
  async waitReservedIpv4Assignment(ip, dropletId) {
    const value = this.addresses.get(ip);
    if (value.dropletId !== String(dropletId)) throw new Error("assignment mismatch");
    return clone(value);
  }
  async waitReservedIpv4Unassigned(ip) {
    const value = this.addresses.get(ip);
    if (!value) throw notFound();
    if (value.dropletId !== null) throw new Error("address still assigned");
    return clone(value);
  }
  async deleteReservedIpv4(ip) {
    if (this.failReservedIpv4Delete) throw new Error("injected Reserved IPv4 delete denial");
    this.addresses.delete(ip);
  }
  async powerOffDroplet(id) { this.droplets.get(String(id)).status = "off"; }
  async powerOnDroplet(id) { this.droplets.get(String(id)).status = "active"; }
  async resizeDroplet(id, size) {
    if (this.failResize) throw new Error("injected resize failure");
    this.droplets.get(String(id)).size = size;
  }
  async snapshotDroplet(_id, name) {
    const value = { id: "500", name, regions: ["sfo2"] };
    this.snapshots.set(value.id, value);
    return clone(value);
  }
  async deleteImage(id) { this.snapshots.delete(String(id)); }
}

function droplet(id, name, tag, size = "c-4", image = "ubuntu-24-04-x64") {
  return {
    id,
    name,
    status: "active",
    region: "sfo2",
    size,
    image: String(image),
    publicIpv4: `198.51.100.${Number(id) % 200 + 1}`,
    privateIpv4: `10.20.0.${Number(id) % 200 + 1}`,
    tags: [tag],
    createdAt: "2026-07-15T00:00:00.000Z"
  };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function notFound() { const error = new Error("not found"); error.status = 404; return error; }
