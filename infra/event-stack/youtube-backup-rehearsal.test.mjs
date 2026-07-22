import assert from "node:assert/strict";
import test from "node:test";

import { evaluateYoutubeBackupRehearsal, YoutubeBackupRehearsalController } from "./youtube-backup-rehearsal.mjs";

test("runs one priority court through backup-only delivery and returns to primary", async () => {
  const calls = [];
  const checkpoints = [];
  const controller = new YoutubeBackupRehearsalController({
    platform: passingPlatform(calls),
    checkpoint: async (state) => { checkpoints.push(state); },
    now: clock()
  });
  const state = await controller.run({ context: context() });
  assert.equal(state.report.classification, "PASS");
  assert.deepEqual(calls, [
    "stage", "start-backup", "capture:dual-ingest:11", "start-continuity",
    "mark:primary-stop-requested", "stop-primary", "mark:primary-stopped",
    "capture:backup-only:01", "mark:backup-only-verified", "mark:primary-start-requested",
    "start-primary", "mark:primary-restored", "capture:dual-restored:11",
    "mark:dual-restored-verified", "mark:backup-stop-requested", "stop-backup",
    "mark:backup-stopped", "cleanup", "capture:primary-only:10",
    "mark:primary-only-verified", "finish-continuity", "close-continuity"
  ]);
  assert.equal(checkpoints.at(-1).phase, "ROLLED_BACK");
  assert.equal(state.primaryEgressId, "EG_primary2");
  assert.equal(state.backupEgressId, "EG_backup1");
});

test("resumes safely after primary stop but does not pass after losing the continuous viewer session", async () => {
  const firstCalls = [];
  const saved = [];
  const controller = new YoutubeBackupRehearsalController({
    platform: {
      ...passingPlatform(firstCalls),
      ensurePrimaryStarted: async () => { throw new Error("intentional restart interruption"); }
    },
    checkpoint: async (state) => { saved.push(state); },
    now: clock()
  });
  await assert.rejects(() => controller.run({ context: context() }), /intentional restart/u);
  assert.equal(saved.at(-1).phase, "PRIMARY_STOPPED");

  const resumedCalls = [];
  const resumedPlatform = passingPlatform(resumedCalls);
  resumedPlatform.markContinuity = async (label) => { resumedCalls.push(`mark-missed:${label}`); return { label, recorded: false }; };
  resumedPlatform.finishContinuity = async (status) => {
    resumedCalls.push("finish-continuity-missed");
    return { ...status, label: "continuity", status: "FAILED", passed: false, problems: ["session lost"] };
  };
  const resumed = await new YoutubeBackupRehearsalController({
    platform: resumedPlatform,
    checkpoint: async () => {},
    now: clock()
  }).run({ context: context(), state: saved.at(-1) });
  assert.equal(resumed.report.classification, "FAIL");
  assert.deepEqual(resumedCalls, [
    "capture:backup-only:01", "mark-missed:backup-only-verified", "mark-missed:primary-start-requested",
    "start-primary", "mark-missed:primary-restored", "capture:dual-restored:11",
    "mark-missed:dual-restored-verified", "mark-missed:backup-stop-requested", "stop-backup",
    "mark-missed:backup-stopped", "cleanup", "capture:primary-only:10",
    "mark-missed:primary-only-verified", "finish-continuity-missed", "close-continuity"
  ]);
});

test("fails the report when any delivery phase does not pass", async () => {
  const state = await new YoutubeBackupRehearsalController({
    platform: { ...passingPlatform([]), capture: async ({ label }) => ({ label, passed: label !== "backup-only", problems: label === "backup-only" ? ["viewer stalled"] : [] }) },
    now: clock()
  }).run({ context: context() });
  const report = evaluateYoutubeBackupRehearsal(state);
  assert.equal(report.classification, "FAIL");
  assert.match(report.problems.join("\n"), /backup-only/u);
});

test("fails the report when required evidence is missing or lifecycle events are reordered", async () => {
  const state = await new YoutubeBackupRehearsalController({ platform: passingPlatform([]), now: clock() }).run({ context: context() });
  const missing = structuredClone(state);
  delete missing.evidence.backupOnly;
  assert.match(evaluateYoutubeBackupRehearsal(missing).problems.join("\n"), /backup-only evidence did not pass/u);
  const reordered = structuredClone(state);
  [reordered.timeline[0], reordered.timeline[1]] = [reordered.timeline[1], reordered.timeline[0]];
  assert.match(evaluateYoutubeBackupRehearsal(reordered).problems.join("\n"), /lifecycle events are not in the required order/u);
});

test("restores primary before removing backup when stale phase evidence no longer shows dual ingest", async () => {
  const calls = [];
  const platform = passingPlatform(calls);
  platform.capture = async ({ label }) => {
    calls.push(`capture:${label}`);
    return { label, passed: label !== "dual-ingest", problems: ["primary was already absent"] };
  };
  const state = await new YoutubeBackupRehearsalController({ platform, now: clock() }).run({ context: context() });
  assert.equal(state.report.classification, "FAIL");
  assert.deepEqual(calls, [
    "stage", "start-backup", "capture:dual-ingest", "start-primary",
    "stop-backup", "cleanup", "capture:primary-only", "close-continuity"
  ]);
});

function passingPlatform(calls) {
  return {
    stageAssignment: async () => { calls.push("stage"); return assignment(); },
    ensureBackupStarted: async () => { calls.push("start-backup"); return { id: "EG_backup1" }; },
    ensurePrimaryStopped: async () => { calls.push("stop-primary"); return { absent: true }; },
    ensurePrimaryStarted: async () => { calls.push("start-primary"); return { id: "EG_primary2" }; },
    ensureBackupStopped: async () => { calls.push("stop-backup"); return { absent: true }; },
    cleanupAssignment: async () => { calls.push("cleanup"); return { removed: true }; },
    startContinuity: async () => { calls.push("start-continuity"); return continuityStatus(); },
    markContinuity: async (label) => { calls.push(`mark:${label}`); return { label, recorded: true }; },
    finishContinuity: async () => { calls.push("finish-continuity"); return continuityEvidence(); },
    closeContinuity: async () => { calls.push("close-continuity"); },
    capture: async ({ label, primaryExpected, backupExpected }) => {
      calls.push(`capture:${label}:${primaryExpected ? 1 : 0}${backupExpected ? 1 : 0}`);
      return { label, passed: true, problems: [] };
    }
  };
}

function continuityStatus() {
  return { schemaVersion: 1, label: "continuity", traceId: `youtube-continuity-${"a".repeat(36)}`, camera: 1, broadcastId: "broadcast-1", startedAt: "2026-07-22T00:00:00Z", status: "RUNNING", passed: false, problems: ["running"] };
}

function continuityEvidence() {
  return { ...continuityStatus(), completedAt: "2026-07-22T00:02:00Z", status: "COMPLETE", passed: true, problems: [] };
}

function context() {
  return {
    event: "event-test",
    generation: "generation-test",
    camera: 1,
    primaryHost: "198.51.100.1",
    spareHost: "198.51.100.12",
    profile: "1080p30",
    stream: {
      id: "stream-1",
      court: 1,
      streamName: "protected-stream-key-1",
      rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
      rtmpsBackupIngestionAddress: "rtmps://b.rtmps.youtube.com/live2"
    },
    broadcastId: "broadcast-1",
    primaryOwner: {
      schemaVersion: 2,
      event: "event-test",
      court: 1,
      destinationId: "broadcast-1",
      destinationRole: "primary",
      outputGeneration: "generation-test",
      outputProfile: "1080p30",
      rendererGitSha: "a".repeat(40),
      rendererDeploymentId: "dpl_test123",
      egressId: "EG_primary1",
      requestSha256: "b".repeat(64),
      startedAt: "2026-07-22T00:00:00Z"
    }
  };
}

function assignment() {
  return {
    schemaVersion: 1,
    event: "event-test",
    generation: "generation-test",
    court: 1,
    streamId: "stream-1",
    id: "a".repeat(20),
    sha256: "b".repeat(64),
    remotePath: "requests/court-1.backup.env"
  };
}

function clock() {
  let value = Date.parse("2026-07-22T00:00:00Z");
  return () => { value += 1_000; return value; };
}
