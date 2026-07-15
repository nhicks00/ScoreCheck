import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EndpointAnchorManager, ENDPOINT_ANCHOR_CONFIRMATION } from "./endpoint-anchors.mjs";
import { CanaryStateStore } from "./lifecycle-canary.mjs";

test("creates and verifies exactly two durable endpoint anchors", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-anchors-"));
  const cloud = new FakeCloud();
  const path = join(root, "anchors.json");
  const manager = new EndpointAnchorManager({ cloud, store: new CanaryStateStore(path) });
  const state = await manager.create({ region: "sfo2" }, ENDPOINT_ANCHOR_CONFIRMATION);
  assert.equal(state.status, "ready");
  assert.deepEqual(Object.keys(state.reservedIpv4).sort(), ["commentary", "ingest"]);
  assert.equal(cloud.createCalls, 2);
  assert.equal((await manager.verify({ region: "sfo2" })).status, "PASS");
  assert.equal(JSON.parse(await readFile(path, "utf8")).provider, "digitalocean");
});

test("resumes a partial allocation without replacing the first address", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-anchors-resume-"));
  const cloud = new FakeCloud();
  cloud.failAt = 2;
  const path = join(root, "anchors.json");
  const manager = new EndpointAnchorManager({ cloud, store: new CanaryStateStore(path) });
  await assert.rejects(() => manager.create({ region: "sfo2" }, ENDPOINT_ANCHOR_CONFIRMATION), /injected anchor failure/);
  const partial = JSON.parse(await readFile(path, "utf8"));
  const first = partial.reservedIpv4.ingest;
  cloud.failAt = null;
  const ready = await manager.create({ region: "sfo2" }, ENDPOINT_ANCHOR_CONFIRMATION);
  assert.equal(ready.reservedIpv4.ingest, first);
  assert.equal(cloud.createCalls, 3);
  assert.equal(cloud.addresses.size, 2);
});

test("requires exact confirmation and refuses region or provider identity drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-anchors-safe-"));
  const cloud = new FakeCloud();
  const manager = new EndpointAnchorManager({ cloud, store: new CanaryStateStore(join(root, "anchors.json")) });
  await assert.rejects(() => manager.create({ region: "sfo2" }, "yes"), /exact confirmation/);
  assert.equal(cloud.createCalls, 0);
  await manager.create({ region: "sfo2" }, ENDPOINT_ANCHOR_CONFIRMATION);
  await assert.rejects(() => manager.verify({ region: "nyc3" }), /different region/);
});

class FakeCloud {
  addresses = new Map();
  createCalls = 0;
  failAt = null;
  async getAccount() { return { status: "active", dropletLimit: 12 }; }
  async createReservedIpv4(region) {
    this.createCalls += 1;
    if (this.createCalls === this.failAt) throw new Error("injected anchor failure");
    const ip = `192.0.2.${40 + this.createCalls}`;
    const value = { ip, region, dropletId: null, locked: false };
    this.addresses.set(ip, value);
    return { ...value };
  }
  async getReservedIpv4(ip) {
    const value = this.addresses.get(ip);
    if (!value) { const error = new Error("not found"); error.status = 404; throw error; }
    return { ...value };
  }
}
