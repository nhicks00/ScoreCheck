import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateSupabaseLossRehearsal, supabaseLossSnapshotProblems } from "./supabase-loss-evidence.mjs";
import { cleanupSupabaseLossRehearsal, parseArgs, prepareSupabaseLossRehearsal, restoreInterruptedSupabaseLoss, runSupabaseLossRehearsal } from "./supabase-loss-rehearsal.mjs";
import { createSyntheticRehearsalVenueProfile, evaluateVenueAdmission } from "./venue-admission.mjs";

const startedMs = Date.parse("2026-07-22T12:00:00Z");
const event = "supabase-loss-event";
const generationId = "generation-12345678";
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
const venueProfile = createSyntheticRehearsalVenueProfile(event);
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
const target = {
  event,
  generationId,
  gateId: "supabase-loss-12345678",
  publicHost: "monitor.example.test",
  pathPrefix: `/_scorecheck-supabase-fault/${event}/`,
  publicOrigin: `https://monitor.example.test/_scorecheck-supabase-fault/${event}/`,
  upstreamOrigin: "https://project.supabase.co"
};

test("Supabase-loss CLI separates pre-soak preparation, live fault/recovery, and post-output cleanup", () => {
  const prepare = parseArgs([
    "prepare", "--profile", "/tmp/profile.json", "--renderer-binding", "/tmp/renderer.json", "--evidence", "/tmp/evidence", "--camera", "1",
    "--confirm-prepare", `PREPARE-SUPABASE-FAULT:${event}`
  ]);
  assert.equal(prepare.command, "prepare");
  const run = parseArgs([
    "run",
    "--profile", "/tmp/profile.json",
    "--soak-evidence", "/tmp/soak",
    "--publisher-state", "/tmp/publishers.json",
    "--renderer-binding", "/tmp/renderer.json",
    "--evidence", "/tmp/evidence",
    "--camera", "1",
    "--confirm-prepare", `PREPARE-SUPABASE-FAULT:${event}`,
    "--confirm-fault", `FAULT-SUPABASE:${generationId}`,
    "--confirm-restore", `RESTORE-SUPABASE:${generationId}`
  ]);
  assert.equal(run.camera, 1);
  assert.equal(run.rendererBinding, "/tmp/renderer.json");
  assert.throws(() => parseArgs(["run", "--evidence", "/tmp/evidence"]), /--profile is required/u);
  assert.equal(parseArgs([
    "restore", "--profile", "/tmp/profile.json", "--evidence", "/tmp/evidence",
    "--confirm-restore", `RESTORE-SUPABASE:${generationId}`
  ]).command, "restore");
  assert.equal(parseArgs([
    "cleanup", "--profile", "/tmp/profile.json", "--evidence", "/tmp/evidence",
    "--confirm-cleanup", `CLEANUP-SUPABASE-FAULT:${event}`
  ]).command, "cleanup");
  assert.throws(() => parseArgs([
    "run", "--profile", "/tmp/profile.json", "--soak-evidence", "/tmp/soak", "--publisher-state", "/tmp/publishers.json",
    "--renderer-binding", "/tmp/renderer.json", "--evidence", "/tmp/evidence", "--camera", "1",
    "--confirm-prepare", `PREPARE-SUPABASE-FAULT:${event}`, "--confirm-fault", `FAULT-SUPABASE:${generationId}`,
    "--confirm-restore", `RESTORE-SUPABASE:${generationId}`, "--confirm-cleanup", `CLEANUP-SUPABASE-FAULT:${event}`
  ]), /cleanup is a separate post-output command/u);
  assert.equal(parseArgs(["status", "--evidence", "/tmp/evidence"]).command, "status");
});

test("Supabase-loss phases require both dependency paths and same-page last-good media", () => {
  const baselineMonitor = snapshot(startedMs + 10_000);
  const outageMonitor = snapshot(startedMs + 25_000, { disconnected: true, incident: true });
  const recoveryMonitor = snapshot(startedMs + 60_000);
  const baselineDependency = dependency("HEALTHY");
  const outageDependency = dependency("FAULTED");
  const recoveryDependency = dependency("HEALTHY_RESTORED");
  assert.deepEqual(supabaseLossSnapshotProblems({ phase: "baseline", snapshot: baselineMonitor, dependency: baselineDependency, profiles, venue, camera: 1, renderer, nowMs: startedMs + 10_000 }), []);
  assert.deepEqual(supabaseLossSnapshotProblems({ phase: "outage", snapshot: outageMonitor, dependency: outageDependency, previous: baselineMonitor, baseline: baselineMonitor, baselineDependency, profiles, venue, camera: 1, renderer, nowMs: startedMs + 25_000 }), []);
  assert.deepEqual(supabaseLossSnapshotProblems({ phase: "recovery", snapshot: recoveryMonitor, dependency: recoveryDependency, previous: outageMonitor, baseline: baselineMonitor, baselineDependency, profiles, venue, camera: 1, renderer, nowMs: startedMs + 60_000 }), []);
});

test("Supabase-loss evidence passes only after exact cleanup and Realtime repair", () => {
  const baselineFirst = sample("baseline", snapshot(startedMs), dependency("HEALTHY"));
  const baselineFinal = sample("baseline", snapshot(startedMs + 10_000), dependency("HEALTHY"));
  const outageFirst = sample("outage", snapshot(startedMs + 20_000, { disconnected: true, incident: true }), dependency("FAULTED"));
  const outageFinal = sample("outage", snapshot(startedMs + 30_000, { disconnected: true, incident: true }), dependency("FAULTED"));
  const recoveryFirst = sample("recovery", snapshot(startedMs + 40_000), dependency("HEALTHY_RESTORED"));
  const recoveryFinal = sample("recovery", snapshot(startedMs + 60_000), dependency("HEALTHY_RESTORED"));
  const input = {
    event,
    generationId,
    camera: 1,
    renderer,
    profile: profiles[1],
    target,
    prepare: { status: "HEALTHY" },
    fault: { status: "FAULTED", faultedAt: new Date(startedMs + 12_000).toISOString() },
    restore: { status: "HEALTHY", restoredAt: new Date(startedMs + 35_000).toISOString() },
    cleanup: { status: "CLEAN" },
    baseline: phase("baseline", baselineFirst, baselineFinal),
    outage: phase("outage", outageFirst, outageFinal),
    recovery: phase("recovery", recoveryFirst, recoveryFinal),
    completedAt: new Date(startedMs + 60_000).toISOString()
  };
  const report = evaluateSupabaseLossRehearsal(input);
  assert.equal(report.classification, "PASS");
  assert.equal(report.browser.aggregateFramesPerSecond, 30);
  assert.equal(report.transitions.dependencyUnavailableMs, 8_000);
  assert.equal(report.transitions.dependencyRecoveredMs, 5_000);
  assert.equal(report.dependency.baseline.httpRequestsForwarded, 1);
  assert.equal(report.dependency.outage.requestsRejectedDuringFault, 1);
  assert.equal(report.dependency.recovery.webSocketsForwarded, 2);

  const noRealtime = structuredClone(input);
  noRealtime.recovery.final.dependency.service.counters.webSocketsForwarded = 1;
  assert.equal(evaluateSupabaseLossRehearsal(noRealtime).classification, "FAIL");
  const dirty = structuredClone(input);
  dirty.cleanup.status = "DIRTY";
  assert.equal(evaluateSupabaseLossRehearsal(dirty).classification, "FAIL");
});

test("Supabase-loss gate prepares before output and cleans only after output stops", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-supabase-loss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = startedMs;
  let status = "CLEAN";
  const actions = [];
  const evidence = join(root, "evidence");
  const fault = {
    inspect: async () => status === "CLEAN" ? { status: "CLEAN", service: null } : dependency(status),
    prepare: async () => { actions.push("prepare"); status = "HEALTHY"; return { status: "HEALTHY" }; },
    fault: async () => { actions.push("fault"); status = "FAULTED"; return { status: "FAULTED", faultedAt: new Date(clock).toISOString() }; },
    restore: async () => { actions.push("restore"); status = "HEALTHY_RESTORED"; return { status: "HEALTHY", restoredAt: new Date(clock).toISOString() }; },
    cleanup: async () => { actions.push("cleanup"); status = "CLEAN"; return { status: "CLEAN" }; }
  };
  const stale = snapshot(clock, { outputsActive: false });
  stale.agents.find((agent) => agent.nativeServices?.egress).state = "MISSING";
  await assert.rejects(() => prepareSupabaseLossRehearsal({
    options: confirmations(evidence), manifest: { event }, lifecycleState: { phase: "live", generationId }, renderer, target,
    monitor: { snapshot: async () => stale }, fault, now: () => clock
  }), /current healthy Egress agent telemetry/u);
  const prepared = await prepareSupabaseLossRehearsal({
    options: confirmations(evidence), manifest: { event }, lifecycleState: { phase: "live", generationId }, renderer, target,
    monitor: { snapshot: async () => snapshot(clock, { outputsActive: false }) }, fault, now: () => clock
  });
  assert.equal(prepared.status, "PREPARED");
  const preparedState = JSON.parse(await readFile(join(evidence, "supabase-loss-rehearsal-state.json"), "utf8"));
  const recovered = await runSupabaseLossRehearsal({
    options: confirmations(evidence),
    manifest: { event },
    lifecycleState: { phase: "live", generationId },
    renderer,
    venue,
    soakState: { phase: "RUNNING", profiles },
    publisherState: { phase: "RUNNING" },
    preparedState,
    target,
    monitor: { snapshot: async () => { clock += 5_000; return snapshot(clock, { disconnected: status === "FAULTED", incident: status === "FAULTED" }); } },
    fault,
    now: () => clock,
    sleep: async () => {}
  });
  assert.equal(recovered.status, "RECOVERED_PENDING_CLEANUP");
  assert.deepEqual(actions, ["prepare", "prepare", "fault", "restore"]);
  const recoveredState = JSON.parse(await readFile(join(evidence, "supabase-loss-rehearsal-state.json"), "utf8"));
  await assert.rejects(() => cleanupSupabaseLossRehearsal({
    options: confirmations(evidence), manifest: { event }, lifecycleState: { generationId }, state: recoveredState,
    monitor: { snapshot: async () => snapshot(clock) }, fault, now: () => clock
  }), /blocked while any Egress output is active/u);
  const report = await cleanupSupabaseLossRehearsal({
    options: confirmations(evidence), manifest: { event }, lifecycleState: { generationId }, state: recoveredState,
    monitor: { snapshot: async () => snapshot(clock, { outputsActive: false }) }, fault, now: () => clock
  });
  assert.equal(report.classification, "PASS");
  assert.deepEqual(actions, ["prepare", "prepare", "fault", "restore", "cleanup"]);
  const state = JSON.parse(await readFile(join(evidence, "supabase-loss-rehearsal-state.json"), "utf8"));
  assert.equal(state.phase, "COMPLETE");
  assert.equal(state.cleanup.status, "CLEAN");
});

test("Supabase-loss failure restores the dependency but defers route cleanup until outputs stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-supabase-loss-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = startedMs;
  let status = "CLEAN";
  let restoreCount = 0;
  let cleanupCount = 0;
  const evidence = join(root, "evidence");
  const fault = {
    inspect: async () => status === "CLEAN" ? { status: "CLEAN", service: null } : dependency(status),
    prepare: async () => { status = "HEALTHY"; return { status: "HEALTHY" }; },
    fault: async () => { status = "FAULTED"; return { status: "FAULTED", faultedAt: new Date(clock).toISOString() }; },
    restore: async () => { restoreCount += 1; status = "HEALTHY_RESTORED"; return { status: "HEALTHY", restoredAt: new Date(clock).toISOString() }; },
    cleanup: async () => { cleanupCount += 1; status = "CLEAN"; return { status: "CLEAN" }; }
  };
  await prepareSupabaseLossRehearsal({
    options: confirmations(evidence), manifest: { event }, lifecycleState: { phase: "live", generationId }, renderer, target,
    monitor: { snapshot: async () => snapshot(clock, { outputsActive: false }) }, fault, now: () => clock
  });
  const preparedState = JSON.parse(await readFile(join(evidence, "supabase-loss-rehearsal-state.json"), "utf8"));
  await assert.rejects(() => runSupabaseLossRehearsal({
    options: confirmations(evidence),
    manifest: { event },
    lifecycleState: { phase: "live", generationId },
    renderer,
    venue,
    soakState: { phase: "RUNNING", profiles },
    publisherState: { phase: "RUNNING" },
    preparedState,
    target,
    monitor: { snapshot: async () => { clock += 5_000; return snapshot(clock); } },
    fault,
    now: () => clock,
    sleep: async () => {}
  }), /outage Supabase-loss evidence did not stabilize/u);
  assert.equal(restoreCount, 1);
  assert.equal(cleanupCount, 0);
  assert.equal(status, "HEALTHY_RESTORED");
  const failedState = JSON.parse(await readFile(join(evidence, "supabase-loss-rehearsal-state.json"), "utf8"));
  assert.equal(failedState.phase, "FAILED_RESTORED_PENDING_CLEANUP");
  const cleaned = await cleanupSupabaseLossRehearsal({
    options: confirmations(evidence), manifest: { event }, lifecycleState: { generationId }, state: failedState,
    monitor: { snapshot: async () => snapshot(clock, { outputsActive: false }) }, fault, now: () => clock
  });
  assert.equal(cleaned.classification, "FAIL");
  assert.equal(cleanupCount, 1);
  assert.equal(status, "CLEAN");
});

test("Supabase-loss manual restore refuses completed evidence", async () => {
  let restoreCount = 0;
  await assert.rejects(() => restoreInterruptedSupabaseLoss({
    options: { evidence: "/tmp/evidence", confirmRestore: `RESTORE-SUPABASE:${generationId}` },
    manifest: { event },
    lifecycleState: { generationId },
    state: { event, generationId, camera: 1, phase: "COMPLETE", target },
    fault: { restore: async () => { restoreCount += 1; } }
  }), /already complete/u);
  assert.equal(restoreCount, 0);
});

function confirmations(evidence) {
  return {
    evidence,
    camera: 1,
    confirmPrepare: `PREPARE-SUPABASE-FAULT:${event}`,
    confirmFault: `FAULT-SUPABASE:${generationId}`,
    confirmRestore: `RESTORE-SUPABASE:${generationId}`,
    confirmCleanup: `CLEANUP-SUPABASE-FAULT:${event}`
  };
}

function dependency(status) {
  const restored = status === "HEALTHY_RESTORED";
  const faulted = status === "FAULTED";
  const serviceStatus = faulted ? "FAULTED" : "HEALTHY";
  return {
    status: serviceStatus,
    service: {
      status: serviceStatus,
      counters: {
        httpRequestsForwarded: restored ? 2 : 1,
        webSocketsForwarded: restored ? 2 : 1,
        requestsRejectedDuringFault: faulted || restored ? 1 : 0,
        upstreamErrors: 0,
        faultCount: faulted || restored ? 1 : 0,
        restoreCount: restored ? 1 : 0,
        activeHttpRequests: 0,
        pendingWebSocketUpgrades: 0,
        activeWebSockets: faulted ? 0 : 1
      }
    }
  };
}

function snapshot(sampledMs, { disconnected = false, incident = false, outputsActive = true } = {}) {
  const agents = [
    agent("bvm-commentary", "commentary"),
    agent("bvm-observability", "observability"),
    agent("bvm-ingest", "ingest"),
    ...Array.from({ length: 8 }, (_, index) => agent(`bvm-compositor-${index + 1}`, "compositor", index + 1, outputsActive)),
    agent("bvm-compositor-spare", "worker")
  ];
  return {
    version: 5,
    generatedAt: new Date(sampledMs).toISOString(),
    collector: { state: "HEALTHY", agentsExpected: 12, agentsFresh: 12 },
    notifications: { pushover: { configured: true } },
    incidents: incident ? [{ id: "incident-1", status: "open", courtNumber: 1, stage: "SCORE_RENDER", issueCode: "SCOREBUG_STATE_UNAVAILABLE" }] : [],
    faultGates: [],
    agents,
    courts: Array.from({ length: 8 }, (_, index) => {
      const camera = index + 1;
      return {
        courtNumber: camera,
        paths: { raw: path("raw", 2), preview: path("preview", 1), program: path("program", 1) },
        ffmpeg: { preview: ffmpeg(null), program: ffmpeg(1) },
        browser: browser(sampledMs, camera === 1 && disconnected),
        youtube: { courtNumber: camera, state: "HEALTHY", streamStatus: "active", healthStatus: "good", configurationIssues: [], broadcastLifecycle: "live" }
      };
    })
  };
}

function browser(sampledMs, disconnected) {
  const framesRendered = Math.round((sampledMs - startedMs) / 1_000 * 30);
  return {
    heartbeatSeq: Math.round((sampledMs - startedMs) / 5_000) + 1,
    receivedAt: new Date(sampledMs).toISOString(),
    pageLoadedAt: "2026-07-22T11:59:00Z",
    pageBuildVersion: renderer.gitSha,
    configurationVersion: "configuration-1234",
    video: {
      state: "playing", connectionState: "connected", transport: "whep", networkPath: "private-vpc", width: 1920, height: 1080,
      framesRendered, framesDropped: 0, freezeCount: 0, totalFreezesDurationMs: 0, packetsLost: 0, reconnectCount: 0, reloadCount: 0
    },
    commentary: { cameraTrackPresent: true },
    scoreRender: {
      loaded: true,
      connected: !disconnected,
      stale: disconnected,
      frozen: false,
      matchId: "match-1",
      phase: "LIVE",
      sourceSignature: "match-1:LIVE:1:0:0",
      renderedSignature: "match-1:LIVE:1:0:0",
      domMismatchReason: null,
      stateUpdatedAt: "2026-07-22T11:59:30Z"
    }
  };
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

function sample(label, monitor, dependencyValue) { return { label, observedAt: monitor.generatedAt, monitor, dependency: dependencyValue, problems: [] }; }
function phase(label, first, final) { return { label, passed: true, startedAt: first.observedAt, completedAt: final.observedAt, stableSamples: 3, sampleCount: 3, first, final }; }
