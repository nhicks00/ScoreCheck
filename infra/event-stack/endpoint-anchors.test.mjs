import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EndpointAnchorManager, ENDPOINT_ANCHOR_CONFIRMATIONS } from "./endpoint-anchors.mjs";
import { CanaryStateStore } from "./lifecycle-canary.mjs";

test("creates and verifies exactly two durable endpoint anchors", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-anchors-"));
  const cloud = new FakeCloud();
  const path = join(root, "anchors.json");
  const manager = new EndpointAnchorManager({ cloud, store: new CanaryStateStore(path) });
  const state = await manager.create(
    { region: "sfo2", retention: "persistent" },
    ENDPOINT_ANCHOR_CONFIRMATIONS.persistent
  );
  assert.equal(state.status, "ready");
  assert.deepEqual(Object.keys(state.reservedIpv4).sort(), ["commentary", "ingest"]);
  assert.equal(cloud.createCalls, 2);
  assert.equal((await manager.verify({ region: "sfo2", retention: "persistent" })).status, "PASS");
  assert.equal(JSON.parse(await readFile(path, "utf8")).provider, "digitalocean");
});

test("creates a rehearsal binding without allocating an unassigned Reserved IPv4", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-anchors-resume-"));
  const cloud = new FakeCloud();
  const path = join(root, "anchors.json");
  const manager = new EndpointAnchorManager({ cloud, store: new CanaryStateStore(path) });
  const ready = await manager.create(
    { region: "sfo2", retention: "ephemeral" },
    ENDPOINT_ANCHOR_CONFIRMATIONS.ephemeral
  );
  assert.deepEqual(ready.reservedIpv4, {});
  assert.equal(cloud.createCalls, 0);
  assert.equal(cloud.addresses.size, 0);
  assert.deepEqual((await manager.verify({ region: "sfo2", retention: "ephemeral" })).slots, {});
});

test("requires exact confirmation and refuses region or provider identity drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-anchors-safe-"));
  const cloud = new FakeCloud();
  const manager = new EndpointAnchorManager({ cloud, store: new CanaryStateStore(join(root, "anchors.json")) });
  await assert.rejects(() => manager.create({ region: "sfo2", retention: "persistent" }, "yes"), /exact confirmation/);
  assert.equal(cloud.createCalls, 0);
  await manager.create(
    { region: "sfo2", retention: "persistent" },
    ENDPOINT_ANCHOR_CONFIRMATIONS.persistent
  );
  await assert.rejects(() => manager.verify({ region: "nyc3", retention: "persistent" }), /different region/);
  await assert.rejects(() => manager.verify({ region: "sfo2", retention: "ephemeral" }), /wrong retention/);
});

test("reconciles a lost Reserved IPv4 response from a protected inventory checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-anchors-response-loss-"));
  const cloud = new FakeCloud();
  cloud.failResponseAt = 1;
  const manager = new EndpointAnchorManager({ cloud, store: new CanaryStateStore(join(root, "anchors.json")) });
  const state = await manager.create(
    { region: "sfo2", retention: "persistent" },
    ENDPOINT_ANCHOR_CONFIRMATIONS.persistent
  );
  assert.equal(cloud.createCalls, 2);
  assert.equal(cloud.addresses.size, 2);
  assert.ok(state.timeline.some((entry) => entry.event === "anchor-reconciled" && entry.slot === "ingest"));
});

class FakeCloud {
  addresses = new Map();
  createCalls = 0;
  failAt = null;
  failResponseAt = null;
  async getAccount() { return { status: "active", dropletLimit: 12 }; }
  async listReservedIpv4s() { return [...this.addresses.values()].map((entry) => ({ ...entry })); }
  async createReservedIpv4(region) {
    this.createCalls += 1;
    if (this.createCalls === this.failAt) throw new Error("injected anchor failure");
    const ip = `192.0.2.${40 + this.createCalls}`;
    const value = { ip, region, dropletId: null, locked: false };
    this.addresses.set(ip, value);
    if (this.createCalls === this.failResponseAt) throw new Error("injected anchor response loss");
    return { ...value };
  }
  async getReservedIpv4(ip) {
    const value = this.addresses.get(ip);
    if (!value) { const error = new Error("not found"); error.status = 404; throw error; }
    return { ...value };
  }
}
