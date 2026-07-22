import assert from "node:assert/strict";
import test from "node:test";

import { evaluateYoutubeBackupSample, YoutubeBackupObserver, YoutubeBackupPlatform } from "./youtube-backup-runtime.mjs";

const nowMs = Date.parse("2026-07-22T12:00:00Z");

test("maps the controller contract to exact primary and spare Egress ownership", async () => {
  const calls = [];
  const egress = {
    preflight: async (host) => { calls.push(`preflight:${host}`); return { healthy: true }; },
    ensureStarted: async ({ host, owner }) => { calls.push(`start:${host}:${owner.destinationRole}`); return { id: owner.destinationRole === "backup" ? "EG_backup" : "EG_primary2" }; },
    stopExact: async ({ host, egressId }) => { calls.push(`stop:${host}:${egressId}`); return { absent: true }; },
    listActive: async (host) => host.endsWith("1") ? [{ id: "EG_primary" }] : [{ id: "EG_backup" }],
    reconcileOwned: async ({ host, owner, expectedId }) => { calls.push(`reconcile:${host}:${owner.destinationRole}:${expectedId}`); return { id: expectedId }; }
  };
  const assignment = {
    stage: async () => { calls.push("assignment:stage"); return { id: "assignment" }; },
    verify: async () => { calls.push("assignment:verify"); },
    cleanup: async () => { calls.push("assignment:cleanup"); return { removed: true }; }
  };
  const observer = {
    capture: async ({ primary, backup }) => ({ primary, backup, passed: true }),
    startContinuity: async () => { calls.push("continuity:start"); return { status: "RUNNING" }; },
    markContinuity: async (label) => { calls.push(`continuity:mark:${label}`); return { recorded: true }; },
    finishContinuity: async () => { calls.push("continuity:finish"); return { passed: true }; },
    closeContinuity: async () => { calls.push("continuity:close"); }
  };
  const platform = new YoutubeBackupPlatform({ egress, assignment, observer });
  const base = { ...context(), assignment: { id: "assignment" }, primaryExpected: true, backupExpected: true, primaryEgressId: "EG_primary", backupEgressId: "EG_backup" };
  await platform.stageAssignment(base);
  await platform.ensureBackupStarted({ ...base, owner: base.backupOwner });
  await platform.ensurePrimaryStopped({ ...base, owner: base.primaryOwner, egressId: "EG_primary" });
  await platform.ensurePrimaryStarted({ ...base, owner: base.primaryOwner });
  await platform.ensureBackupStopped({ ...base, owner: base.backupOwner, egressId: "EG_backup" });
  await platform.cleanupAssignment(base);
  await platform.startContinuity(base);
  await platform.markContinuity("primary-stop-requested");
  await platform.finishContinuity({ status: "RUNNING" });
  await platform.closeContinuity();
  const captured = await platform.capture(base);
  assert.equal(captured.primary[0].id, "EG_primary");
  assert.equal(captured.backup[0].id, "EG_backup");
  assert.deepEqual(calls, [
    "preflight:198.51.100.12", "assignment:stage", "assignment:verify",
    "start:198.51.100.12:backup", "stop:198.51.100.1:EG_primary",
    "start:198.51.100.1:primary", "stop:198.51.100.12:EG_backup",
    "preflight:198.51.100.12", "assignment:cleanup", "continuity:start",
    "continuity:mark:primary-stop-requested", "continuity:finish", "continuity:close",
    "reconcile:198.51.100.1:primary:EG_primary",
    "reconcile:198.51.100.12:backup:EG_backup"
  ]);
});

test("admits the expected dual, backup-only, and primary-only topology without hiding other quality failures", () => {
  for (const topology of [
    { label: "dual-ingest", primaryExpected: true, backupExpected: true },
    { label: "backup-only", primaryExpected: false, backupExpected: true },
    { label: "primary-only", primaryExpected: true, backupExpected: false }
  ]) {
    const value = fixture(topology);
    const result = evaluateYoutubeBackupSample(value);
    assert.equal(result.passed, true, `${topology.label}: ${result.problems.join("; ")}`);
  }
  const broken = fixture({ label: "backup-only", primaryExpected: false, backupExpected: true });
  broken.snapshot.courts[1].paths.raw.frameErrors = 1;
  const result = evaluateYoutubeBackupSample(broken);
  assert.equal(result.passed, false);
  assert.match(result.problems.join("\n"), /Camera 2 raw frame errors/u);
});

test("owns one continuous viewer session and fails closed when a resumed process lost it", async () => {
  const calls = [];
  const session = {
    status: () => ({ schemaVersion: 1, label: "continuity", traceId: `youtube-continuity-${"a".repeat(36)}`, status: "RUNNING", passed: false, problems: ["running"] }),
    mark: async (label) => { calls.push(`mark:${label}`); },
    finish: async () => { calls.push("finish"); return { label: "continuity", status: "COMPLETE", passed: true, problems: [] }; },
    close: async () => { calls.push("close"); }
  };
  const observer = new YoutubeBackupObserver({
    monitorOrigin: "https://monitor.example.com",
    monitorToken: "token",
    youtube: {},
    viewer: { startContinuity: async () => { calls.push("start"); return session; } },
    destinations: {},
    profiles: {},
    venue: { activeCameras: [] },
    now: () => nowMs
  });
  const status = await observer.startContinuity({ camera: 1, broadcastId: "broadcast_1" });
  await observer.markContinuity("primary-stop-requested");
  const completed = await observer.finishContinuity(status);
  assert.equal(completed.passed, true);
  const lost = await observer.finishContinuity(status);
  assert.equal(lost.passed, false);
  assert.match(lost.problems[0], /did not survive/u);
  assert.deepEqual(calls, ["start", "mark:primary-stop-requested", "finish"]);
});

function fixture({ label, primaryExpected, backupExpected }) {
  const venue = {
    passed: true,
    requiredSustainedUploadMbps: 62.4,
    activeCameras: [1, 2, 3, 4, 5, 6],
    inactiveCameras: [7, 8],
    assignments: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1, {
      cameraNumber: index + 1,
      cameraIdentity: `camera-${index + 1}`,
      sourceProfile: "STANDARD_1080P30",
      outputProfile: "1080p30",
      minimumSourceBitrateBps: 5_000_000,
      maximumSourceBitrateBps: 8_000_000,
      sourceCodec: "H264",
      frameRateMode: "30/1",
      sourcePathMode: "direct-h264"
    }]))
  };
  const profiles = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1, {
    profile: "1080p30",
    framesPerSecond: 30,
    sourcePathMode: "direct-h264",
    source: { codec: "H264", frameRateMode: "30/1" },
    browserInput: { codec: "H264", hasBFrames: 0, pixelFormat: "yuv420p" }
  }]));
  const snapshot = monitorSnapshot({ primaryExpected, backupExpected });
  return {
    label,
    camera: 1,
    primaryExpected,
    backupExpected,
    primary: primaryExpected ? [{ id: "EG_primary" }] : [],
    backup: backupExpected ? [{ id: "EG_backup" }] : [],
    snapshot,
    provider: providerEvidence(),
    profiles,
    venue,
    nowMs
  };
}

function monitorSnapshot({ primaryExpected, backupExpected }) {
  const fixed = ["commentary", "observability", "ingest"].map((role) => agent(`bvm-${role}`, role));
  const compositors = Array.from({ length: 8 }, (_, index) => agent(`bvm-compositor-${index + 1}`, "compositor", index + 1, index === 0 ? primaryExpected : index < 6));
  const spare = agent("bvm-compositor-spare", "worker", null, backupExpected);
  return {
    version: 5,
    generatedAt: new Date(nowMs).toISOString(),
    collector: { agentsExpected: 12, agentsFresh: 12 },
    notifications: { pushover: { configured: true } },
    incidents: [],
    faultGates: [],
    agents: [...fixed, ...compositors, spare],
    courts: Array.from({ length: 8 }, (_, index) => {
      const camera = index + 1;
      const active = camera <= 6;
      return {
        courtNumber: camera,
        paths: active ? {
          raw: path(camera === 1 ? 2 + Number(backupExpected) : 2),
          preview: path(1),
          program: path(camera === 1 ? Number(primaryExpected) + Number(backupExpected) : 1)
        } : {},
        ffmpeg: active ? { preview: ffmpeg(null), program: ffmpeg(1) } : {},
        browser: active ? browser(camera) : null
      };
    })
  };
}

function path(readerCount) {
  return { ready: true, readerCount, inboundBitrateBps: 8_000_000, frameErrors: 0, videoCodec: "H264", videoWidth: 1920, videoHeight: 1080, audioCodec: "AAC", audioSampleRateHz: 48_000, audioChannelCount: 2 };
}
function ffmpeg(speedRatio) { return { framesPerSecond: 30, droppedFrames: 0, duplicatedFrames: 0, speedRatio }; }
function browser(camera) {
  return {
    heartbeatSeq: 10,
    receivedAt: new Date(nowMs).toISOString(),
    pageLoadedAt: "2026-07-22T11:59:00Z",
    pageBuildVersion: "build",
    video: { state: "playing", connectionState: "connected", transport: "whep", networkPath: "private-vpc", width: 1920, height: 1080, framesRendered: 1_000, framesDropped: 0, freezeCount: 0, totalFreezesDurationMs: 0, packetsLost: 0, reconnectCount: 0, reloadCount: 0 },
    commentary: { cameraTrackPresent: true },
    scoreRender: { loaded: true, connected: true, stale: false, frozen: false, domMismatchReason: null, camera }
  };
}
function agent(agentId, role, assignedCourt = null, active = false) {
  return {
    agentId, role, assignedCourts: assignedCourt === null ? [] : [assignedCourt], state: "HEALTHY",
    host: { memoryTotalBytes: 8e9, memoryAvailableBytes: 6e9, diskTotalBytes: 1e11, diskFreeBytes: 8e10 }, services: [],
    nativeServices: ["compositor", "worker"].includes(role) ? { egress: { idle: !active, activeWebRequests: active ? 1 : 0, maximumWebRequests: 1, canAcceptRequest: !active, cpuLoadRatio: active ? 0.35 : 0.02, memoryLoadRatio: active ? 0.25 : 0.02 } } : null
  };
}
function providerEvidence() {
  return { observedAt: new Date(nowMs).toISOString(), cameras: Array.from({ length: 6 }, (_, index) => { const camera = index + 1; const id = `stream-${camera}`; return { camera, stream: { id, court: camera, resolution: "variable", frameRate: "variable", streamStatus: "active", healthStatus: "good", configurationIssues: [] }, broadcast: { court: camera, privacyStatus: "unlisted", lifeCycleStatus: "live", recordingStatus: "recording", streamId: id } }; }) };
}
function context() {
  return {
    event: "event-test", generation: "generation-test", camera: 1, primaryHost: "198.51.100.1", spareHost: "198.51.100.12", profile: "1080p30",
    stream: { id: "stream-1", court: 1, streamName: "protected-key-1", rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2", rtmpsBackupIngestionAddress: "rtmps://b.rtmps.youtube.com/live2" },
    primaryOwner: { event: "event-test", court: 1, destinationId: "broadcast-1", destinationRole: "primary", outputGeneration: "generation-test", rendererGitSha: "a".repeat(40), rendererDeploymentId: "dpl_test123", egressId: "EG_primary" },
    backupOwner: { event: "event-test", destinationId: "broadcast-1", destinationRole: "backup", outputGeneration: "generation-test-backup-1", rendererGitSha: "a".repeat(40), rendererDeploymentId: "dpl_test123" }
  };
}
