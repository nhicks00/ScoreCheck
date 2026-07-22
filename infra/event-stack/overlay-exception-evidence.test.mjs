import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateOverlayExceptionRehearsal, overlayExceptionSnapshotProblems } from "./overlay-exception-evidence.mjs";
import { cleanupOverlayExceptionRehearsal, parseArgs, prepareOverlayExceptionRehearsal, runOverlayExceptionRehearsal } from "./overlay-exception-rehearsal.mjs";
import { createSyntheticRehearsalVenueProfile, evaluateVenueAdmission } from "./venue-admission.mjs";

const startedMs = Date.parse("2026-07-22T12:00:00Z");
const renderer = {
  schemaVersion: 1,
  provider: "vercel",
  origin: "https://scorecheck-abc123-team.vercel.app",
  deploymentId: "dpl_renderer123",
  gitSha: "a".repeat(40),
  assetNamespace: "dpl_renderer123",
  contracts: {
    programSession: "program-session-v1",
    overlayState: "overlay-state-v1",
    commentary: "commentary-v1",
    browserHeartbeat: "browser-heartbeat-v5"
  }
};
const venueProfile = createSyntheticRehearsalVenueProfile("overlay-exception-event");
venueProfile.uploadMeasurement.sustainedUploadMbps = 100;
const venue = { ...evaluateVenueAdmission(venueProfile), sha256: "f".repeat(64) };
const profiles = Object.fromEntries(venue.activeCameras.map((camera) => [camera, {
  profile: "1080p30",
  width: 1920,
  height: 1080,
  framesPerSecond: 30,
  videoBitrateKbps: 10_000,
  sourcePathMode: "direct-h264",
  source: { codec: "H264", frameRateMode: "30/1" },
  browserInput: { codec: "H264", hasBFrames: 0, pixelFormat: "yuv420p" }
}]));

test("overlay-exception phase accepts only the expected fail-transparent score fault", () => {
  const baseline = snapshot(startedMs + 10_000);
  const fault = snapshot(startedMs + 25_000, { fault: true });
  assert.deepEqual(overlayExceptionSnapshotProblems({
    phase: "baseline", snapshot: baseline, page: page(startedMs + 10_000), profiles, venue, camera: 1, renderer, nowMs: startedMs + 10_000
  }), []);
  assert.deepEqual(overlayExceptionSnapshotProblems({
    phase: "fault", snapshot: fault, page: page(startedMs + 25_000, true), previous: baseline, baseline, profiles, venue, camera: 1, renderer, nowMs: startedMs + 25_000
  }), []);
});

test("overlay-exception evidence passes only with exact-page media continuity and a bounded scorebug failure", () => {
  const input = passingEvidence();
  const report = evaluateOverlayExceptionRehearsal(input);
  assert.equal(report.classification, "PASS");
  assert.equal(report.browser.aggregateFramesPerSecond, 30);
  assert.equal(report.fault.throwCount, 2);
  assert.equal(report.fault.scorebugPresent, false);

  const reloaded = structuredClone(input);
  reloaded.fault.final.monitor.courts[0].browser.video.reloadCount = 1;
  const failed = evaluateOverlayExceptionRehearsal(reloaded);
  assert.equal(failed.classification, "FAIL");
  assert.ok(failed.problems.some((problem) => problem.includes("reloadCount")));
});

test("overlay-exception gate rejects visible scorebug, peer impact, unrelated incidents, and stalled page video", () => {
  const baseline = snapshot(startedMs + 10_000);
  const fault = snapshot(startedMs + 20_000, { fault: true });
  fault.courts[1].paths.program.ready = false;
  fault.incidents.push({ id: "other", status: "open", courtNumber: 2, stage: "RAW", issueCode: "CAMERA_OFFLINE" });
  const badPage = page(startedMs + 20_000, true);
  badPage.boardPresent = true;
  badPage.video.currentTime = 1;
  const problems = overlayExceptionSnapshotProblems({
    phase: "fault", snapshot: fault, page: badPage, previous: baseline, baseline, profiles, venue, camera: 1, renderer, nowMs: startedMs + 20_000
  });
  assert.ok(problems.some((problem) => problem.includes("Camera 2 program path")));
  assert.ok(problems.some((problem) => problem.includes("unrelated active incident")));
  assert.ok(problems.some((problem) => problem.includes("not bounded and transparent")));
});

test("overlay-exception runner prepares idle, captures the exact fault, and defers cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-overlay-exception-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = join(root, "evidence");
  let clock = startedMs;
  let faulted = false;
  let sessionClosed = false;
  let cleaned = false;
  const target = passingEvidence().target;
  const debug = {
    plan: () => target,
    prepare: async () => ({ status: "PREPARED", preparedAt: new Date(clock).toISOString() }),
    activate: async () => ({ schemaVersion: 1, containerId: "d".repeat(64), containerIp: "172.20.0.7", egressId: "EG_exact123", activatedAt: new Date(clock).toISOString() }),
    connect: async () => ({
      install: async () => ({ ...page(clock), video: page(clock).video }),
      arm: async () => { faulted = true; return { armedAt: new Date(clock).toISOString(), status: { installed: true, armed: true } }; },
      status: async () => page(clock, faulted, faulted ? 2 : 0),
      close: async () => { sessionClosed = true; }
    }),
    complete: async () => ({ status: "COMPLETE", completedAt: new Date(clock).toISOString() }),
    cleanup: async () => { cleaned = true; return { status: "CLEAN", cleanedAt: new Date(clock).toISOString() }; }
  };
  const prepared = await prepareOverlayExceptionRehearsal({
    options: { evidence, camera: 1, confirmPrepare: "PREPARE-OVERLAY-DEBUG:overlay-exception-event:CAMERA-1" },
    manifest: { event: "overlay-exception-event" },
    lifecycleState: { phase: "ready", generationId: "generation-test-01" },
    renderer,
    venue,
    compositorHost: "203.0.113.21",
    egressConfig: "unused",
    debug,
    now: () => clock
  });
  assert.equal(prepared.phase, "PREPARED");
  const state = JSON.parse(await readFile(join(evidence, "overlay-exception-rehearsal-state.json"), "utf8"));
  const report = await runOverlayExceptionRehearsal({
    options: {
      evidence,
      confirmArm: "ARM-OVERLAY-EXCEPTION:overlay-exception-event:CAMERA-1",
      confirmFault: "FAULT-OVERLAY:overlay-exception-event:CAMERA-1"
    },
    manifest: { event: "overlay-exception-event" },
    lifecycleState: { phase: "live", generationId: "generation-test-01" },
    renderer,
    venue,
    soakState: {
      phase: "RUNNING",
      event: "overlay-exception-event",
      activeCameras: [...venue.activeCameras],
      profiles,
      runId: "run-12345678",
      egress: { 1: { id: "EG_exact123" } },
      runBinding: { renderer: { gitSha: renderer.gitSha, deploymentId: renderer.deploymentId }, destinations: { 1: { broadcastId: "broadcast-1" } } }
    },
    publisherState: { phase: "RUNNING", event: "overlay-exception-event", generationId: "generation-test-01", publishers: Object.fromEntries(venue.activeCameras.map((camera) => [camera, {}])) },
    state,
    monitor: { snapshot: async () => { clock += 5_000; return snapshot(clock, { fault: faulted }); } },
    debug,
    now: () => clock,
    sleep: async () => {}
  });
  assert.equal(report.classification, "PASS");
  assert.equal(report.phases.baseline.stableSamples, 6);
  assert.equal(report.phases.fault.stableSamples, 6);
  assert.equal(sessionClosed, true);
  assert.equal(cleaned, false, "run must not recreate or clean the active Egress worker");

  const completedState = JSON.parse(await readFile(join(evidence, "overlay-exception-rehearsal-state.json"), "utf8"));
  const cleanup = await cleanupOverlayExceptionRehearsal({
    options: { evidence, confirmCleanup: "CLEANUP-OVERLAY-DEBUG:overlay-exception-event:CAMERA-1" },
    manifest: { event: "overlay-exception-event" },
    lifecycleState: { generationId: "generation-test-01" },
    state: completedState,
    debug,
    now: () => clock
  });
  assert.equal(cleanup.phase, "CLEANED");
  assert.equal(cleaned, true);
});

test("overlay-exception CLI keeps preparation, faulting, and cleanup confirmations separate", () => {
  assert.equal(parseArgs(["status", "--evidence", "/tmp/evidence"]).command, "status");
  assert.equal(parseArgs(["prepare", "--profile", "/tmp/profile", "--evidence", "/tmp/evidence", "--camera", "1", "--confirm-prepare", "PREPARE"]).camera, 1);
  assert.equal(parseArgs(["run", "--profile", "/tmp/profile", "--soak-evidence", "/tmp/soak", "--publisher-state", "/tmp/publishers", "--evidence", "/tmp/evidence", "--confirm-arm", "ARM", "--confirm-fault", "FAULT"]).command, "run");
  assert.equal(parseArgs(["cleanup", "--profile", "/tmp/profile", "--evidence", "/tmp/evidence", "--confirm-cleanup", "CLEAN"]).command, "cleanup");
  assert.throws(() => parseArgs(["run", "--profile", "/tmp/profile", "--evidence", "/tmp/evidence"]), /--soak-evidence is required/u);
});

function passingEvidence() {
  const baselineFirst = sample("baseline", snapshot(startedMs), page(startedMs));
  const baselineFinal = sample("baseline", snapshot(startedMs + 10_000), page(startedMs + 10_000));
  const faultFirst = sample("fault", snapshot(startedMs + 20_000, { fault: true }), page(startedMs + 20_000, true));
  const faultFinal = sample("fault", snapshot(startedMs + 30_000, { fault: true }), page(startedMs + 30_000, true, 3));
  return {
    event: "overlay-exception-event",
    generationId: "generation-test-01",
    camera: 1,
    renderer,
    profile: profiles[1],
    target: {
      event: "overlay-exception-event",
      generationId: "generation-test-01",
      camera: 1,
      gateId: "overlay-exception-123e4567-e89b-12d3-a456-426614174000",
      rendererGitSha: renderer.gitSha,
      rendererDeploymentId: renderer.deploymentId,
      rendererOrigin: renderer.origin,
      baselineConfigSha256: "b".repeat(64),
      debugConfigSha256: "c".repeat(64)
    },
    owner: owner(),
    prepared: { status: "PREPARED", preparedAt: new Date(startedMs - 60_000).toISOString() },
    activation: { egressId: "EG_exact123", activatedAt: new Date(startedMs - 1_000).toISOString() },
    installed: { installed: true, armed: false, throwCount: 0, interceptCount: 0 },
    armed: { armedAt: new Date(startedMs + 12_000).toISOString(), status: { installed: true, armed: true } },
    baseline: phase("baseline", baselineFirst, baselineFinal, 3),
    fault: phase("fault", faultFirst, faultFinal, 3),
    completed: { status: "COMPLETE", completedAt: new Date(startedMs + 31_000).toISOString() },
    completedAt: new Date(startedMs + 31_000).toISOString()
  };
}

function snapshot(sampledMs, { fault = false } = {}) {
  return {
    version: 5,
    generatedAt: new Date(sampledMs).toISOString(),
    collector: { state: "HEALTHY", agentsExpected: 12, agentsFresh: 12 },
    notifications: { pushover: { configured: true } },
    incidents: fault ? [{ id: "score-render", status: "open", courtNumber: 1, stage: "SCORE_RENDER", issueCode: "SCOREBUG_STATE_UNAVAILABLE" }] : [],
    faultGates: [],
    agents: [
      agent("bvm-commentary", "commentary"),
      agent("bvm-observability", "observability"),
      agent("bvm-ingest", "ingest"),
      ...Array.from({ length: 8 }, (_, index) => agent(`bvm-compositor-${index + 1}`, "compositor", index + 1, true)),
      agent("bvm-compositor-spare", "worker")
    ],
    courts: Array.from({ length: 8 }, (_, index) => {
      const camera = index + 1;
      return {
        courtNumber: camera,
        paths: { raw: path("raw", 2), preview: path("preview", 1), program: path("program", 1) },
        ffmpeg: { preview: ffmpeg(null), program: ffmpeg(1) },
        browser: browser(sampledMs, fault && camera === 1),
        youtube: { courtNumber: camera, state: "HEALTHY", streamStatus: "active", healthStatus: "good", configurationIssues: [], broadcastLifecycle: "live" }
      };
    })
  };
}

function browser(sampledMs, fault) {
  return {
    heartbeatSeq: Math.round((sampledMs - startedMs) / 5_000) + 1,
    receivedAt: new Date(sampledMs).toISOString(),
    pageLoadedAt: "2026-07-22T11:59:00Z",
    pageBuildVersion: renderer.gitSha,
    configurationVersion: "configuration-1234",
    video: {
      state: "playing", connectionState: "connected", transport: "whep", networkPath: "private-vpc", width: 1920, height: 1080,
      framesRendered: Math.round((sampledMs - startedMs) / 1_000 * 30), framesDropped: 0, freezeCount: 0, totalFreezesDurationMs: 0, packetsLost: 0, reconnectCount: 0, reloadCount: 0
    },
    commentary: { cameraTrackPresent: true },
    scoreRender: fault ? {
      loaded: false, connected: false, stale: true, frozen: true, matchId: null, phase: "ERROR", sourceSignature: null, renderedSignature: null, domMismatchReason: null, stateUpdatedAt: null
    } : {
      loaded: true, connected: true, stale: false, frozen: false, matchId: "match-1", phase: "LIVE", sourceSignature: "score", renderedSignature: "score", domMismatchReason: null, stateUpdatedAt: "2026-07-22T11:59:30Z"
    }
  };
}

function page(sampledMs, fault = false, interceptCount = 1) {
  return {
    installed: true,
    armed: fault,
    throwCount: fault ? 2 : 0,
    interceptCount: fault ? interceptCount : 0,
    programRootPresent: true,
    boardPresent: !fault,
    video: { paused: false, readyState: 4, currentTime: (sampledMs - startedMs) / 1_000, width: 1920, height: 1080 }
  };
}

function owner() {
  return { event: "overlay-exception-event", camera: 1, rendererGitSha: renderer.gitSha, rendererDeploymentId: renderer.deploymentId, egressId: "EG_exact123", destinationId: "broadcast-1", outputGeneration: "run-12345678" };
}

function path(branch, readerCount) {
  return { branch, ready: true, readerCount, inboundBitrateBps: 8_000_000, frameErrors: 0, videoCodec: "H264", videoWidth: 1920, videoHeight: 1080, audioCodec: "AAC", audioSampleRateHz: 48_000, audioChannelCount: 2 };
}

function ffmpeg(speedRatio) {
  return { framesPerSecond: 30, droppedFrames: 0, duplicatedFrames: 0, speedRatio };
}

function agent(agentId, role, assignedCourt = null, outputActive = false) {
  return {
    agentId,
    role,
    assignedCourts: assignedCourt === null ? [] : [assignedCourt],
    state: "HEALTHY",
    host: { memoryTotalBytes: 8_000_000_000, memoryAvailableBytes: 6_000_000_000, diskTotalBytes: 100_000_000_000, diskFreeBytes: 80_000_000_000 },
    services: [],
    nativeServices: ["compositor", "worker"].includes(role) ? {
      egress: { idle: !outputActive, activeWebRequests: outputActive ? 1 : 0, maximumWebRequests: 1, canAcceptRequest: !outputActive, cpuLoadRatio: outputActive ? 0.35 : 0.02, memoryLoadRatio: outputActive ? 0.25 : 0.02 }
    } : null
  };
}

function sample(label, monitor, browserPage) {
  return { label, observedAt: monitor.generatedAt, monitor, page: browserPage, problems: [] };
}

function phase(label, first, final, stableSamples) {
  return { label, passed: true, startedAt: first.observedAt, completedAt: final.observedAt, stableSamples, sampleCount: stableSamples, first, final };
}
