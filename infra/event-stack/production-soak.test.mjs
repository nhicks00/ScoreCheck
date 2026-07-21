import test from "node:test";
import assert from "node:assert/strict";

import {
  browserDeltaProblems,
  evaluateProductionSoak,
  evaluateSpeedifyEvidence,
  productionIdleProblems,
  productionProviderIdleProblems,
  productionProviderProblems,
  productionRawProblems,
  productionSnapshotProblems
} from "./production-soak.mjs";

const startedMs = Date.parse("2026-07-21T12:00:00Z");
const profiles = Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
  const camera = index + 1;
  const framesPerSecond = camera <= 2 ? 60 : 30;
  return [camera, { profile: framesPerSecond === 60 ? "1080p60" : "1080p30", width: 1920, height: 1080, framesPerSecond, videoBitrateKbps: framesPerSecond === 60 ? 12_000 : 10_000 }];
}));

test("accepts an idle twelve-host baseline with all cameras off", () => {
  assert.deepEqual(productionIdleProblems(snapshot({ active: false }), startedMs), []);
});

test("accepts six native 1080 camera chains and two isolated inactive cameras", () => {
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  assert.deepEqual(productionRawProblems(after, startedMs + 5_000), []);
  assert.deepEqual(productionSnapshotProblems(after, profiles, before, startedMs + 5_000), []);
  assert.deepEqual(browserDeltaProblems(before, after, profiles), []);
});

test("detects source, overlay, browser continuity, and inactive-camera contamination", () => {
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  after.courts[0].paths.raw.videoHeight = 720;
  after.courts[0].browser.scoreRender.stale = true;
  after.courts[1].browser.video.framesDropped = 1;
  after.courts[6].paths.raw = path("raw", 1);
  const problems = productionSnapshotProblems(after, profiles, before, startedMs + 5_000);
  assert.ok(problems.some((entry) => entry.includes("Camera 1 raw video is not H.264/H.265 1920x1080")));
  assert.ok(problems.some((entry) => entry.includes("Camera 1 scoreboard overlay")));
  assert.ok(problems.some((entry) => entry.includes("Camera 2 browser framesDropped changed")));
  assert.ok(problems.some((entry) => entry.includes("Camera 7 raw is unexpectedly active")));
});

test("requires six healthy variable-profile live YouTube broadcasts", () => {
  const provider = providerEvidence();
  assert.deepEqual(productionProviderProblems(provider), []);
  provider.cameras[2].stream.configurationIssues.push("videoBitrateLow");
  provider.cameras[4].broadcast.lifeCycleStatus = "ready";
  const problems = productionProviderProblems(provider);
  assert.ok(problems.includes("Camera 3 YouTube ingest is not active and healthy"));
  assert.ok(problems.includes("Camera 5 YouTube broadcast is not live, recording, unlisted, and correctly bound"));
});

test("requires six idle variable-profile destinations before arming", () => {
  const provider = providerEvidence({ active: false });
  assert.deepEqual(productionProviderIdleProblems(provider), []);
  provider.cameras[0].stream.streamStatus = "active";
  provider.cameras[1].broadcast.lifeCycleStatus = "live";
  assert.ok(productionProviderIdleProblems(provider).includes("Camera 1 YouTube ingest is not idle"));
  assert.ok(productionProviderIdleProblems(provider).includes("Camera 2 YouTube broadcast is not ready, unlisted, and correctly bound"));
});

test("qualifies reset-safe aggregate cadence and fails on any sample defect", () => {
  const first = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const last = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  const state = {
    event: "six-camera-soak",
    runId: "run-12345678",
    startedAt: new Date(startedMs).toISOString(),
    maximumGapMs: 5_000,
    profiles,
    egress: {},
    notifications: []
  };
  const samples = [
    { runId: state.runId, slot: 0, monitor: first, problems: [] },
    { runId: state.runId, slot: 1, monitor: last, problems: [] }
  ];
  const pass = evaluateProductionSoak({ state, samples, hostEvidence: { passed: true, problems: [] }, routerEvidence: { passed: true, problems: [] }, endedMs: startedMs + 5_000, minimumDurationMs: 5_000, maximumDurationMs: 10_000 });
  assert.equal(pass.classification, "PASS");
  samples[1].problems.push("Camera 1 YouTube ingest is not active and healthy");
  const fail = evaluateProductionSoak({ state, samples, hostEvidence: { passed: true, problems: [] }, routerEvidence: { passed: true, problems: [] }, endedMs: startedMs + 5_000, minimumDurationMs: 5_000, maximumDurationMs: 10_000 });
  assert.equal(fail.classification, "FAIL");
});

test("fails qualification when an operator notification could not be delivered", () => {
  const first = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const last = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  const state = {
    event: "six-camera-soak",
    runId: "run-12345678",
    startedAt: new Date(startedMs).toISOString(),
    maximumGapMs: 5_000,
    profiles,
    egress: {},
    notifications: [{ kind: "FAILURE", title: "ScoreCheck needs attention" }]
  };
  const samples = [
    { runId: state.runId, slot: 0, monitor: first, problems: [] },
    { runId: state.runId, slot: 1, monitor: last, problems: [] }
  ];

  const report = evaluateProductionSoak({ state, samples, hostEvidence: { passed: true, problems: [] }, routerEvidence: { passed: true, problems: [] }, endedMs: startedMs + 5_000, minimumDurationMs: 5_000, maximumDurationMs: 10_000 });

  assert.equal(report.classification, "FAIL");
  assert.ok(report.problems.includes("one or more Pushover notifications failed"));
});

test("qualifies continuous fail-closed Speedify evidence and rejects route drift", () => {
  const good = evaluateSpeedifyEvidence({ content: routerEvidence(), startMs: startedMs, endMs: startedMs + 5_000, activeCameras: 6, intervalMs: 1_000 });
  assert.equal(good.passed, true);
  assert.equal(good.observedRows, 6);
  assert.ok(good.connectifyTxBitrateBps.average > 0);

  const drift = routerEvidence().replace("CONNECTED\tconnectify0\tconnectify0\t2\t2\tactive\t6", "CONNECTED\teth0\tconnectify0\t2\t2\tinactive\t5");
  const failed = evaluateSpeedifyEvidence({ content: drift, startMs: startedMs, endMs: startedMs + 5_000, activeCameras: 6, intervalMs: 1_000 });
  assert.equal(failed.passed, false);
  assert.ok(failed.problems.includes("camera ingest routes did not remain on Speedify"));
  assert.ok(failed.problems.includes("camera fail-closed kill switch was not continuously active"));
  assert.ok(failed.problems.includes("fewer than 6 camera flows reached the ingest endpoint"));
});

function snapshot({ active = true, sampledMs = startedMs, framesMultiplier = 0 } = {}) {
  const fixed = ["commentary", "observability", "ingest"].map((role) => agent(`bvm-${role}`, role));
  const compositors = Array.from({ length: 8 }, (_, index) => agent(`bvm-compositor-${index + 1}`, "compositor", index + 1, active && index < 6));
  const spare = agent("bvm-compositor-spare", "worker", null, false);
  return {
    version: 4,
    generatedAt: new Date(sampledMs).toISOString(),
    collector: { state: "HEALTHY", agentsExpected: 12, agentsFresh: 12 },
    notifications: { pushover: { configured: true } },
    incidents: [],
    faultGates: [],
    agents: [...fixed, ...compositors, spare],
    courts: Array.from({ length: 8 }, (_, index) => {
      const camera = index + 1;
      const running = active && camera <= 6;
      const fps = profiles[camera]?.framesPerSecond ?? 30;
      return {
        courtNumber: camera,
        paths: running ? { raw: path("raw", 2), preview: path("preview", 1), program: path("program", 1) } : {},
        ffmpeg: running ? { preview: ffmpeg(fps, null), program: ffmpeg(fps, 1) } : {},
        browser: running ? browser(camera, sampledMs, framesMultiplier * fps) : null
      };
    })
  };
}

function path(branch, readerCount) {
  return {
    branch,
    ready: true,
    readerCount,
    inboundBitrateBps: 8_000_000,
    frameErrors: 0,
    videoCodec: "H264",
    videoWidth: 1920,
    videoHeight: 1080,
    audioCodec: "AAC",
    audioSampleRateHz: 48_000,
    audioChannelCount: 2
  };
}

function ffmpeg(framesPerSecond, speedRatio) {
  return { framesPerSecond, droppedFrames: 0, duplicatedFrames: 0, speedRatio };
}

function browser(camera, sampledMs, framesRendered) {
  return {
    heartbeatSeq: Math.floor((sampledMs - startedMs) / 1_000) + 1,
    receivedAt: new Date(sampledMs).toISOString(),
    pageLoadedAt: "2026-07-21T11:59:00Z",
    pageBuildVersion: "build-1080",
    video: {
      state: "playing",
      connectionState: "connected",
      transport: "whep",
      width: 1920,
      height: 1080,
      framesRendered,
      framesDropped: 0,
      freezeCount: 0,
      totalFreezesDurationMs: 0,
      packetsLost: 0,
      reconnectCount: 0,
      reloadCount: 0
    },
    commentary: { cameraTrackPresent: true },
    scoreRender: { loaded: true, connected: true, stale: false, frozen: false, domMismatchReason: null, camera }
  };
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
      egress: {
        idle: !outputActive,
        activeWebRequests: outputActive ? 1 : 0,
        maximumWebRequests: 1,
        canAcceptRequest: !outputActive,
        cpuLoadRatio: outputActive ? 0.35 : 0.02,
        memoryLoadRatio: outputActive ? 0.25 : 0.02
      }
    } : null
  };
}

function providerEvidence({ active = true } = {}) {
  return {
    observedAt: new Date(startedMs).toISOString(),
    cameras: Array.from({ length: 6 }, (_, index) => {
      const camera = index + 1;
      const id = `stream-${camera}`;
      return {
        camera,
        stream: { id, court: camera, resolution: "variable", frameRate: "variable", streamStatus: active ? "active" : "inactive", healthStatus: active ? "good" : null, configurationIssues: [] },
        broadcast: { court: camera, privacyStatus: "unlisted", lifeCycleStatus: active ? "live" : "ready", recordingStatus: active ? "recording" : "notRecording", streamId: id }
      };
    })
  };
}

function routerEvidence() {
  const header = "timestamp\tspeedify_state\tsrt_route_dev\trtmp_route_dev\tprimary_rule_count\tguard_rule_count\tkill_switch\tcamera_flow_count\tconnectify_rx_bytes\tconnectify_tx_bytes\teth0_rx_bytes\teth0_tx_bytes\trmnet_rx_bytes\trmnet_tx_bytes\twireguard_handshake_age_seconds\tload1\tmem_available_kb\tspeedify_rss_kb\tstreaming_stats_process_count";
  const rows = Array.from({ length: 6 }, (_, index) => {
    const counter = 1_000_000 + index * 1_000_000;
    return [new Date(startedMs + index * 1_000).toISOString(), "CONNECTED", "connectify0", "connectify0", 2, 2, "active", 6, counter, counter, counter, counter, counter, counter, -1, 0.5, 170_000, 47_000, 0].join("\t");
  });
  return `${header}\n${rows.join("\n")}\n`;
}
