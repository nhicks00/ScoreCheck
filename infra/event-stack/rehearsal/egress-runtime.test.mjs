import assert from "node:assert/strict";
import test from "node:test";

import { EgressRuntime, parseActiveEgress, parseEgressOwnership } from "./egress-runtime.mjs";

const owner = Object.freeze({
  event: "event-test",
  destinationId: "broadcast-test",
  destinationRole: "primary",
  outputGeneration: "generation-test",
  rendererGitSha: "a".repeat(40),
  rendererDeploymentId: "dpl_test123"
});

function ownership(egressId = "EG_started") {
  return {
    schemaVersion: 2,
    ...owner,
    court: 1,
    outputProfile: "1080p30",
    egressId,
    requestSha256: "b".repeat(64),
    startedAt: "2026-07-22T00:00:00Z"
  };
}

test("parses null or exact unique active Egress identities", () => {
  assert.deepEqual(parseActiveEgress("null\n"), []);
  assert.deepEqual(parseActiveEgress('[{"egress_id":"EG_abc123","status":"EGRESS_ACTIVE"}]'), [{ id: "EG_abc123", status: "EGRESS_ACTIVE", startedAt: null, updatedAt: null, error: null }]);
  assert.throws(() => parseActiveEgress('[{"egress_id":"EG_same"},{"egress_id":"EG_same"}]'), /duplicate/);
});

test("parses an exact immutable Egress ownership record", () => {
  assert.deepEqual(parseEgressOwnership(JSON.stringify(ownership())), ownership());
  assert.throws(() => parseEgressOwnership(JSON.stringify({ ...ownership(), requestSha256: "bad" })), /digest/);
});

test("starts one Egress, adopts it on resume, and proves second admission rejection", async () => {
  let active = [];
  let recordedOwner = null;
  const calls = [];
  const runner = async (_command, args, options) => {
    const remote = args.at(-1);
    calls.push(remote);
    if (remote.includes("list-egress")) return { code: 0, stdout: JSON.stringify(active), stderr: "" };
    if (remote.includes("owner.json")) return { code: 0, stdout: JSON.stringify(recordedOwner), stderr: "" };
    if (remote.includes("start-court")) {
      if (active.length) return { code: 1, stdout: "", stderr: "already active" };
      active = [{ egress_id: "EG_started", status: "EGRESS_ACTIVE" }];
      recordedOwner = ownership();
      return { code: 0, stdout: "saved owned egress id EG_started", stderr: "" };
    }
    return { code: options?.allowFailure ? 1 : 0, stdout: "", stderr: "" };
  };
  const runtime = new EgressRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known", runner, sleep: async () => {} });
  const started = await runtime.ensureStarted({ host: "198.51.100.1", court: 1, owner });
  assert.equal(started.id, "EG_started");
  assert.equal(started.adopted, false);
  assert.equal((await runtime.ensureStarted({ host: "198.51.100.1", court: 1, owner, expectedId: "EG_started" })).adopted, true);
  assert.deepEqual(await runtime.proveSecondStartRejected({ host: "198.51.100.1", court: 1, owner, expectedId: "EG_started" }), { rejected: true, activeId: "EG_started" });
  assert.ok(calls.some((entry) => entry.includes("start-court.sh 1 1080p30 event-test broadcast-test generation-test primary")));
});

test("stops only the recorded Egress id and is resumable after confirmed absence", async () => {
  let active = [{ egress_id: "EG_started", status: "EGRESS_ACTIVE" }];
  const runner = async (_command, args) => {
    const remote = args.at(-1);
    if (remote.includes("list-egress")) return { code: 0, stdout: JSON.stringify(active), stderr: "" };
    if (remote.includes("owner.json")) return { code: 0, stdout: JSON.stringify(ownership()), stderr: "" };
    if (remote.includes("stop-court.sh 1 EG_started")) { active = []; return { code: 0, stdout: "stopped", stderr: "" }; }
    throw new Error(`unexpected ${remote}`);
  };
  const runtime = new EgressRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known", runner, sleep: async () => {} });
  assert.deepEqual(await runtime.stopExact({ host: "198.51.100.1", court: 1, egressId: "EG_started", profile: "1080p30", owner }), { absent: true });
  assert.deepEqual(await runtime.stopExact({ host: "198.51.100.1", court: 1, egressId: "EG_started" }), { absent: true });
});

test("fails closed when an unexpected active Egress replaces the recorded one", async () => {
  const runtime = new EgressRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known",
    runner: async () => ({ code: 0, stdout: '[{"egress_id":"EG_other"}]', stderr: "" })
  });
  await assert.rejects(() => runtime.stopExact({ host: "198.51.100.1", court: 1, egressId: "EG_expected" }), /unexpected active Egress/);
});

test("retries only transient SSH failures for idempotent Egress reads", async () => {
  let attempts = 0;
  const waits = [];
  const runtime = new EgressRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known",
    sleep: async (milliseconds) => { waits.push(milliseconds); },
    runner: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("ssh failed with exit 255: Connection reset by peer");
      return { code: 0, stdout: "[]", stderr: "" };
    }
  });
  assert.deepEqual(await runtime.listActive("198.51.100.1"), []);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
});

test("does not retry Egress mutations after a transient SSH failure", async () => {
  let attempts = 0;
  const runtime = new EgressRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known",
    sleep: async () => { throw new Error("mutation retry is unsafe"); },
    runner: async (_command, args) => {
      const remote = args.at(-1);
      if (remote.includes("list-egress")) return { code: 0, stdout: "[]", stderr: "" };
      attempts += 1;
      throw new Error("ssh failed with exit 255: Connection reset by peer");
    }
  });
  await assert.rejects(() => runtime.ensureStarted({ host: "198.51.100.1", court: 1, owner }), /Connection reset by peer/);
  assert.equal(attempts, 1);
});

test("refuses to adopt an active Egress whose durable owner differs", async () => {
  const runtime = new EgressRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known",
    runner: async (_command, args) => {
      const remote = args.at(-1);
      if (remote.includes("list-egress")) return { code: 0, stdout: '[{"egress_id":"EG_started","status":"EGRESS_ACTIVE"}]', stderr: "" };
      if (remote.includes("owner.json")) return { code: 0, stdout: JSON.stringify({ ...ownership(), outputGeneration: "another-generation" }), stderr: "" };
      throw new Error(`unexpected ${remote}`);
    }
  });
  await assert.rejects(
    () => runtime.ensureStarted({ host: "198.51.100.1", court: 1, owner, expectedId: "EG_started" }),
    /outputGeneration changed/
  );
});
