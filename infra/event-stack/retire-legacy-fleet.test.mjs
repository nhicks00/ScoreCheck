import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertSafeMonitorSnapshot,
  createRetirementPlan,
  executeRetirement,
  validateFleetSpec
} from "./retire-legacy-fleet.mjs";

const NOW = new Date("2026-07-16T18:55:00.000Z");

test("plans the exact seven-host retirement and retained address bindings", async () => {
  const setup = fixture();
  const plan = await createRetirementPlan({ ...setup, now: NOW });
  assert.equal(plan.event, "gate8-2026-07-13");
  assert.equal(plan.resources.length, 7);
  assert.deepEqual(plan.reservedIpv4.map((entry) => entry.slot), ["commentary", "ingest"]);
  assert.match(plan.confirmation, /^RETIRE:gate8-2026-07-13:/);
  assert.equal(plan.baseline.collector, "HEALTHY");
});

test("refuses to plan when an extra Droplet exists", async () => {
  const setup = fixture();
  setup.cloud.droplets.push(droplet({ id: "999", name: "unowned-extra", tags: [] }));
  await assert.rejects(() => createRetirementPlan({ ...setup, now: NOW }), /exactly 7 legacy Droplets/);
});

test("refuses stale, active-event, active-media, and active-Egress baselines", () => {
  const stale = snapshot();
  stale.generatedAt = new Date(NOW.getTime() - 16_000).toISOString();
  assert.throws(() => assertSafeMonitorSnapshot(stale, NOW), /stale/);
  const event = snapshot(); event.event = { id: "event" };
  assert.throws(() => assertSafeMonitorSnapshot(event, NOW), /event is active/);
  const media = snapshot(); media.courts[0].media.raw.ready = true;
  assert.throws(() => assertSafeMonitorSnapshot(media, NOW), /active media path/);
  const egress = snapshot(); egress.agents[0].nativeServices.egress.activeWebRequests = 1;
  assert.throws(() => assertSafeMonitorSnapshot(egress, NOW), /active Egress/);
});

test("executes exact-ID retirement, pauses dead-man, retains addresses, and records Pushover", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-retirement-"));
  const statePath = join(root, "state.json");
  const setup = fixture();
  const plan = await createRetirementPlan({ ...setup, now: NOW });
  let tick = NOW.getTime();
  const state = await executeRetirement({
    ...setup,
    plan,
    statePath,
    confirmation: plan.confirmation,
    now: () => new Date(tick += 1_000)
  });
  assert.equal(state.phase, "retired");
  assert.equal(setup.cloud.droplets.length, 0);
  assert.ok(setup.cloud.addresses.every((entry) => entry.dropletId === null));
  assert.equal(setup.healthchecks.pauseCalls, 1);
  assert.deepEqual(setup.notifier.messages.map((entry) => entry.title), [
    "ScoreCheck event servers are shutting down",
    "ScoreCheck event servers are fully shut down"
  ]);
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.phase, "retired");
  assert.ok(Object.values(persisted.resources).every((entry) => entry.status === "deleted"));
});

test("requires exact confirmation without pausing or deleting", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-retirement-confirm-"));
  const setup = fixture();
  const plan = await createRetirementPlan({ ...setup, now: NOW });
  await assert.rejects(() => executeRetirement({ ...setup, plan, statePath: join(root, "state.json"), confirmation: "APPROVED", now: () => NOW }), /confirmation must be exactly/);
  assert.equal(setup.cloud.droplets.length, 7);
  assert.equal(setup.healthchecks.pauseCalls, 0);
  assert.equal(setup.notifier.messages.length, 0);
});

test("reconciles an already absent planned Droplet on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-retirement-resume-"));
  const statePath = join(root, "state.json");
  const setup = fixture();
  const plan = await createRetirementPlan({ ...setup, now: NOW });
  setup.cloud.deleteFailureAfter = 2;
  let tick = NOW.getTime();
  await assert.rejects(() => executeRetirement({ ...setup, plan, statePath, confirmation: plan.confirmation, now: () => new Date(tick += 1_000) }), /injected delete interruption/);
  assert.equal(setup.cloud.droplets.length, 5);
  setup.cloud.deleteFailureAfter = null;
  tick = Date.parse(plan.expiresAt) + 60_000;
  const result = await executeRetirement({ ...setup, plan, statePath, confirmation: plan.confirmation, now: () => new Date(tick += 1_000) });
  assert.equal(result.phase, "retired");
  assert.equal(setup.cloud.droplets.length, 0);
  assert.equal(setup.notifier.messages.length, 2);
  assert.equal(setup.healthchecks.pauseCalls, 1);
});

test("legacy fleet spec is hard-bound to the known migration inventory", () => {
  assert.equal(validateFleetSpec(fleet()).resources.length, 7);
  const changed = fleet(); changed.event = "different";
  assert.throws(() => validateFleetSpec(changed), /identity is invalid/);
});

function fixture() {
  const spec = fleet();
  const droplets = spec.resources.map((entry, index) => droplet({
    id: String(index + 1),
    name: entry.name,
    size: entry.size,
    tags: [...spec.requiredTags, `role:${entry.role}`]
  }));
  const byName = new Map(droplets.map((entry) => [entry.name, entry]));
  const addresses = [
    { ip: "203.0.113.10", dropletId: byName.get("bvm-preview-01").id, locked: false },
    { ip: "203.0.113.11", dropletId: byName.get("bvm-commentary-01").id, locked: false }
  ];
  const cloud = new FakeCloud(droplets, addresses);
  const monitor = { snapshot: async () => snapshot() };
  const healthchecks = new FakeHealthchecks();
  const notifier = { messages: [], async send(value) { this.messages.push(value); } };
  return { cloud, monitor, healthchecks, notifier, fleet: spec, anchors: anchors() };
}

class FakeCloud {
  constructor(droplets, addresses) { this.droplets = droplets; this.addresses = addresses; this.deleteCalls = 0; this.deleteFailureAfter = null; }
  async getAccount() { return { uuid: "account-1", status: "active", dropletLimit: 15 }; }
  async listAllDroplets() { return structuredClone(this.droplets); }
  async listReservedIpv4s() { return structuredClone(this.addresses); }
  async getReservedIpv4(ip) { return structuredClone(this.addresses.find((entry) => entry.ip === ip)); }
  async unassignReservedIpv4(ip) { this.addresses.find((entry) => entry.ip === ip).dropletId = null; }
  async waitReservedIpv4Unassigned(ip) { return this.getReservedIpv4(ip); }
  async getDroplet(id) {
    const value = this.droplets.find((entry) => entry.id === String(id));
    if (!value) { const error = new Error("missing"); error.status = 404; throw error; }
    return structuredClone(value);
  }
  async deleteDroplet(id) {
    if (this.deleteFailureAfter !== null && this.deleteCalls >= this.deleteFailureAfter) throw new Error("injected delete interruption");
    this.deleteCalls += 1;
    this.droplets = this.droplets.filter((entry) => entry.id !== String(id));
  }
  async waitDropletAbsent() { return true; }
}

class FakeHealthchecks {
  constructor() { this.baseline = "up"; this.active = "paused"; this.pauseCalls = 0; }
  async inspect() { return { baseline: { status: this.baseline, lastPing: NOW.toISOString() }, active: { status: this.active, lastPing: NOW.toISOString() } }; }
  async pauseBaseline() { this.baseline = "paused"; this.pauseCalls += 1; return { status: "paused" }; }
}

function fleet() {
  return {
    schemaVersion: 1,
    event: "gate8-2026-07-13",
    region: "sfo2",
    requiredTags: ["scorecheck-event:gate8-2026-07-13", "scorecheck-temporary"],
    resources: [
      { name: "bvm-preview-01", role: "ingest", size: "c-4", reservedIpv4Slot: "ingest" },
      { name: "bvm-commentary-01", role: "commentary", size: "s-2vcpu-2gb", reservedIpv4Slot: "commentary" },
      { name: "bvm-observability-01", role: "observability", size: "s-2vcpu-4gb", reservedIpv4Slot: null },
      ...["a", "b", "c", "d"].map((suffix) => ({ name: `bvm-compositor-${suffix}`, role: "compositor", size: "c-4", reservedIpv4Slot: null }))
    ]
  };
}

function anchors() {
  return { schemaVersion: 2, provider: "digitalocean", region: "sfo2", retention: "persistent", status: "ready", reservedIpv4: { ingest: "203.0.113.10", commentary: "203.0.113.11" } };
}

function droplet({ id, name, size = "c-4", tags = [] }) {
  return { id: String(id), name, status: "active", region: "sfo2", size, tags };
}

function snapshot() {
  return {
    generatedAt: NOW.toISOString(),
    collector: { state: "HEALTHY", agentsFresh: 6, agentsExpected: 6 },
    event: null,
    faultGates: [],
    incidents: [],
    courts: EXPECTED_COURTS.map((courtNumber) => ({
      courtNumber,
      overallState: "EXPECTED_OFF",
      expectation: { coveragePhase: "OFF" },
      media: { raw: { ready: null }, preview: { ready: null }, program: { ready: null } }
    })),
    agents: [{ agentId: "bvm-compositor-a", role: "compositor", nativeServices: { egress: { activeWebRequests: 0 } } }]
  };
}

const EXPECTED_COURTS = Array.from({ length: 8 }, (_, index) => index + 1);
