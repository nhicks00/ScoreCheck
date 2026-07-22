import assert from "node:assert/strict";
import test from "node:test";

import { IngestRecoveryController, IngestRecoveryError, recoveryTopology } from "./ingest-recovery.mjs";

test("moves the Reserved IP, all private compositor bindings, exact output generations, and monitoring as one takeover", async () => {
  const calls = [];
  const platform = passingPlatform(calls);
  const controller = new IngestRecoveryController({ platform, now: clock() });
  const { manifest, lifecycleState, anchors } = fixture();
  const prepared = await controller.prepare({ manifest, lifecycleState, anchors });
  const result = await controller.takeover({ state: prepared, confirmation: "TAKEOVER-INGEST:recovery-event" });
  assert.equal(result.phase, "ACTIVE_ON_SPARE");
  assert.equal(result.activeHost, "spare");
  assert.deepEqual(calls.slice(0, 4), ["primary-healthy", "spare-idle", "outputs-healthy", "stage-spare"]);
  assert.equal(calls.filter((entry) => entry.startsWith("rebind-")).length, 8);
  assert.equal(calls.filter((entry) => entry.startsWith("resume-")).length, 8);
  assert.ok(calls.indexOf("move-primary-spare") < calls.indexOf("public-health-bvm-compositor-spare"));
  assert.ok(calls.indexOf("public-health-bvm-compositor-spare") < calls.indexOf("rebind-1"));
  assert.ok(calls.indexOf("resume-8") < calls.indexOf("monitor-primary-spare"));
  assert.deepEqual(Object.keys(result.outputGenerations), ["1", "2", "3", "4", "5", "6", "7", "8"]);
});

test("requires explicit confirmation and a failed primary before takeover", async () => {
  const calls = [];
  const platform = passingPlatform(calls);
  const controller = new IngestRecoveryController({ platform, now: clock() });
  const inputs = fixture();
  const prepared = await controller.prepare(inputs);
  await assert.rejects(() => controller.takeover({ state: structuredClone(prepared), confirmation: "yes" }), /exact confirmation/u);
  platform.assertPrimaryIngestFailed = async () => { throw new Error("primary is still healthy"); };
  await assert.rejects(() => controller.takeover({ state: structuredClone(prepared), confirmation: "TAKEOVER-INGEST:recovery-event" }), /still healthy/u);
  assert.equal(calls.includes("move-primary-spare"), false);
});

test("preserves a resumable failed state and never rolls back automatically", async () => {
  const calls = [];
  const platform = passingPlatform(calls);
  platform.rebindCompositorIngress = async ({ compositor }) => {
    calls.push(`rebind-${compositor.cameraNumber}`);
    if (compositor.cameraNumber === 3) throw new Error("injected compositor binding failure");
  };
  const controller = new IngestRecoveryController({ platform, now: clock() });
  const prepared = await controller.prepare(fixture());
  let failure;
  await assert.rejects(async () => {
    try { await controller.takeover({ state: prepared, confirmation: "TAKEOVER-INGEST:recovery-event" }); }
    catch (error) { failure = error; throw error; }
  }, IngestRecoveryError);
  assert.equal(failure.state.phase, "FAILED");
  assert.match(failure.state.failure, /binding failure/u);
  assert.equal(calls.some((entry) => entry.startsWith("move-spare-primary")), false);
});

test("rolls back only after primary health and restores the spare role", async () => {
  const calls = [];
  const platform = passingPlatform(calls);
  const controller = new IngestRecoveryController({ platform, now: clock() });
  const prepared = await controller.prepare(fixture());
  const active = await controller.takeover({ state: prepared, confirmation: "TAKEOVER-INGEST:recovery-event" });
  calls.length = 0;
  const rolledBack = await controller.rollback({ state: active, confirmation: "ROLLBACK-INGEST:recovery-event" });
  assert.equal(rolledBack.phase, "ROLLED_BACK");
  assert.equal(rolledBack.activeHost, "primary");
  assert.equal(calls[0], "primary-healthy");
  assert.ok(calls.indexOf("deactivate-spare") < calls.indexOf("detach-firewall"));
  assert.ok(calls.indexOf("detach-firewall") < calls.indexOf("restore-spare"));
});

test("rejects missing spare, incomplete private identity, or wrong Reserved IP slot", () => {
  const { manifest, lifecycleState, anchors } = fixture();
  assert.throws(() => recoveryTopology({ ...manifest, droplets: manifest.droplets.filter((entry) => entry.role !== "compositor-spare") }, lifecycleState, anchors), /exact production event manifest|warm compositor spare/u);
  const badState = structuredClone(lifecycleState);
  badState.droplets["bvm-compositor-a"].privateIpv4 = "203.0.113.20";
  assert.throws(() => recoveryTopology(manifest, badState, anchors), /identity is incomplete/u);
  assert.throws(() => recoveryTopology(manifest, lifecycleState, { reservedIpv4: {} }), /Reserved IPv4/u);
});

function passingPlatform(calls) {
  return {
    assertPrimaryIngestHealthy: async () => { calls.push("primary-healthy"); },
    assertPrimaryIngestFailed: async () => { calls.push("primary-failed"); },
    assertSpareIdle: async () => { calls.push("spare-idle"); },
    assertCompositorOutputsHealthy: async () => { calls.push("outputs-healthy"); },
    assertSpareIngestHealthy: async () => { calls.push("spare-ingest-healthy"); },
    stageSpareIngest: async () => { calls.push("stage-spare"); return { status: "staged" }; },
    captureOutputGenerations: async () => Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, { broadcastId: `broadcast-${index + 1}`, outputGeneration: `generation-${index + 1}`, profile: "1080p30" }])),
    attachIngestNetworkPolicy: async () => { calls.push("attach-firewall"); },
    activateSpareIngest: async () => { calls.push("activate-spare"); },
    moveReservedIpv4: async ({ fromDropletId, toDropletId }) => { calls.push(fromDropletId === "103" ? "move-primary-spare" : "move-spare-primary"); assert.notEqual(fromDropletId, toDropletId); },
    waitIngestPublicHealth: async (host) => { calls.push(`public-health-${host.name}`); },
    rebindCompositorIngress: async ({ compositor }) => { calls.push(`rebind-${compositor.cameraNumber}`); },
    resumeOutputGeneration: async ({ compositor }) => { calls.push(`resume-${compositor.cameraNumber}`); },
    switchIngestMonitoring: async ({ from, to }) => { calls.push(`monitor-${from.name.includes("preview") ? "primary" : "spare"}-${to.name.includes("preview") ? "primary" : "spare"}`); },
    verifyRecoveredIngest: async () => { calls.push("verify-recovery"); },
    deactivateSpareIngest: async () => { calls.push("deactivate-spare"); },
    detachIngestNetworkPolicy: async () => { calls.push("detach-firewall"); },
    restoreSpareCompositor: async () => { calls.push("restore-spare"); }
  };
}

function fixture() {
  const service = (name, role, extra = {}) => ({ name, providerName: `event-${name}`, role, ...extra });
  const droplets = [
    service("bvm-commentary-01", "commentary"),
    service("bvm-observability-01", "observability"),
    service("bvm-preview-01", "ingest"),
    ...Array.from({ length: 8 }, (_, index) => service(`bvm-compositor-${String.fromCharCode(97 + index)}`, "compositor", { court: index + 1 })),
    service("bvm-compositor-spare", "compositor-spare", { warmSpare: true })
  ];
  const stateDroplets = Object.fromEntries(droplets.map((entry, index) => [entry.name, {
    id: String(101 + index),
    status: "active",
    publicIpv4: `203.0.113.${10 + index}`,
    privateIpv4: `10.120.0.${10 + index}`
  }]));
  return {
    manifest: { schemaVersion: 6, kind: "production", event: "recovery-event", droplets },
    lifecycleState: { event: "recovery-event", phase: "live", droplets: stateDroplets },
    anchors: { reservedIpv4: { ingest: "198.51.100.20", commentary: "198.51.100.21" } }
  };
}

function clock() {
  let value = Date.parse("2026-07-21T12:00:00.000Z");
  return () => new Date(value += 1_000);
}
