import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  browserDeltaProblems,
  evaluateProductionSoak,
  evaluateSpeedifyEvidence,
  outputConformanceProblems,
  productionIdleProblems,
  productionProviderIdleProblems,
  productionProviderProblems,
  productionRawProblems,
  productionRouterPreflightProblems,
  productionSnapshotProblems,
  viewerEvidenceProblems
} from "./production-soak.mjs";
import { createSyntheticRehearsalVenueProfile, evaluateVenueAdmission } from "./venue-admission.mjs";

const startedMs = Date.parse("2026-07-21T12:00:00Z");
const venueProfile = createSyntheticRehearsalVenueProfile("six-camera-soak");
for (const camera of [1, 2]) {
  venueProfile.cameras[camera - 1].sourceProfile = "PRIORITY_1080P60";
  venueProfile.cameras[camera - 1].frameRateMode = "60/1";
  venueProfile.cameras[camera - 1].sourceRateCapMbps = 12;
}
for (const camera of [7, 8]) venueProfile.cameras[camera - 1] = { cameraNumber: camera, cameraIdentity: `camera-${camera}`, publishPath: `court${camera}_raw`, enabled: false };
venueProfile.uploadMeasurement.sustainedUploadMbps = 80;
const venue = { ...evaluateVenueAdmission(venueProfile), sha256: "f".repeat(64) };
const runBinding = {
  renderer: {
    gitSha: "a".repeat(40),
    deploymentId: "dpl_renderer123",
    assetNamespace: "dpl_renderer123",
    contracts: {
      programSession: "program-session-v1",
      overlayState: "overlay-state-v1",
      commentary: "commentary-v1",
      browserHeartbeat: "browser-heartbeat-v5"
    }
  },
  destinations: Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
    const camera = index + 1;
    return [camera, { streamId: `stream-${camera}`, broadcastId: `broadcast-${camera}` }];
  }))
};
const profiles = Object.fromEntries(venue.activeCameras.map((camera) => {
  const framesPerSecond = camera <= 2 ? 60 : 30;
  return [camera, {
    profile: framesPerSecond === 60 ? "1080p60" : "1080p30",
    width: 1920,
    height: 1080,
    framesPerSecond,
    videoBitrateKbps: framesPerSecond === 60 ? 12_000 : 10_000,
    sourcePathMode: "direct-h264",
    source: { codec: "H264", frameRateMode: framesPerSecond === 60 ? "60/1" : "30/1" },
    browserInput: { codec: "H264", hasBFrames: 0, pixelFormat: "yuv420p" }
  }];
}));

test("starts through the real CLI entrypoint after module initialization", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./production-soak.mjs", import.meta.url)), "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/);
});

test("accepts an idle twelve-host baseline with all cameras off", () => {
  assert.deepEqual(productionIdleProblems(snapshot({ active: false }), venue, startedMs), []);
});

test("accepts six native 1080 camera chains and two isolated inactive cameras", () => {
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  assert.deepEqual(productionRawProblems(after, venue, startedMs + 5_000), []);
  assert.deepEqual(productionSnapshotProblems(after, profiles, venue, before, startedMs + 5_000), []);
  assert.deepEqual(browserDeltaProblems(before, after, profiles, venue.activeCameras), []);
});

test("requires an isolated compositor normalizer only for an admitted HEVC camera", () => {
  const hevcProfile = structuredClone(venueProfile);
  hevcProfile.cameras[2].sourcePathMode = "isolated-hevc-normalizer";
  hevcProfile.cameras[2].sourceCodec = "H265";
  const hevcVenue = { ...evaluateVenueAdmission(hevcProfile), sha256: "e".repeat(64) };
  const hevcProfiles = structuredClone(profiles);
  hevcProfiles[3].sourcePathMode = "isolated-hevc-normalizer";
  hevcProfiles[3].source.codec = "H265";
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  for (const value of [before, after]) {
    const court = value.courts[2];
    court.paths.raw.videoCodec = "H265";
    court.paths.normalized = {
      ...path("normalized", 1),
      audioCodec: "OPUS"
    };
    court.ffmpeg.normalizer = ffmpeg(30, 1);
  }
  assert.deepEqual(productionSnapshotProblems(after, hevcProfiles, hevcVenue, before, startedMs + 5_000), []);

  delete after.courts[2].paths.normalized;
  assert.ok(productionSnapshotProblems(after, hevcProfiles, hevcVenue, before, startedMs + 5_000).some((entry) => entry.includes("normalized browser path")));
  after.courts[2].paths.normalized = { ...path("normalized", 1), audioCodec: "OPUS" };
  after.courts[0].paths.normalized = { ...path("normalized", 1), audioCodec: "OPUS" };
  assert.ok(productionSnapshotProblems(after, hevcProfiles, hevcVenue, before, startedMs + 5_000).some((entry) => entry.includes("Camera 1 direct-H264")));
});

test("detects source, overlay, browser continuity, and inactive-camera contamination", () => {
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  after.courts[0].paths.raw.videoHeight = 720;
  after.courts[0].browser.scoreRender.stale = true;
  after.courts[1].browser.video.framesDropped = 1;
  after.courts[6].paths.raw = path("raw", 1);
  const problems = productionSnapshotProblems(after, profiles, venue, before, startedMs + 5_000);
  assert.ok(problems.some((entry) => entry.includes("Camera 1 raw video does not match")));
  assert.ok(problems.some((entry) => entry.includes("Camera 1 scoreboard overlay")));
  assert.ok(problems.some((entry) => entry.includes("Camera 2 browser framesDropped changed")));
  assert.ok(problems.some((entry) => entry.includes("Camera 7 raw is unexpectedly active")));
});

test("requires six healthy variable-profile live YouTube broadcasts", () => {
  const provider = providerEvidence();
  assert.deepEqual(productionProviderProblems(provider, venue.activeCameras), []);
  provider.cameras[2].stream.configurationIssues.push("videoBitrateLow");
  provider.cameras[4].broadcast.lifeCycleStatus = "ready";
  const problems = productionProviderProblems(provider, venue.activeCameras);
  assert.ok(problems.includes("Camera 3 YouTube ingest is not active and healthy"));
  assert.ok(problems.includes("Camera 5 YouTube broadcast is not live, recording, unlisted, and correctly bound"));
});

test("requires six idle variable-profile destinations before arming", () => {
  const provider = providerEvidence({ active: false });
  assert.deepEqual(productionProviderIdleProblems(provider, venue.activeCameras), []);
  provider.cameras[0].stream.streamStatus = "active";
  provider.cameras[1].broadcast.lifeCycleStatus = "live";
  assert.ok(productionProviderIdleProblems(provider, venue.activeCameras).includes("Camera 1 YouTube ingest is not idle"));
  assert.ok(productionProviderIdleProblems(provider, venue.activeCameras).includes("Camera 2 YouTube broadcast is not ready, unlisted, and correctly bound"));
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
    activeCameras: venue.activeCameras,
    runBinding,
    venueAdmission: venue,
    outputConformance: outputConformanceEvidence(),
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
    activeCameras: venue.activeCameras,
    runBinding,
    venueAdmission: venue,
    outputConformance: outputConformanceEvidence(),
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

test("requires each selected output profile to be bound to encoder, renderer, and YouTube evidence", () => {
  const evidence = outputConformanceEvidence();
  assert.deepEqual(outputConformanceProblems(evidence, profiles, venue.activeCameras, runBinding), []);
  delete evidence[3];
  evidence[4].destination.broadcastId = null;
  evidence[5].renderer.gitSha = "old";
  const problems = outputConformanceProblems(evidence, profiles, venue.activeCameras, runBinding);
  assert.ok(problems.includes("Camera 3 encoded output is not qualified for 1080p30"));
  assert.ok(problems.includes("Camera 4 output qualification is not bound to its YouTube destination"));
  assert.ok(problems.includes("Camera 5 output qualification is not bound to its renderer"));

  const staleBinding = structuredClone(runBinding);
  staleBinding.destinations[1].broadcastId = "another-broadcast";
  staleBinding.renderer.gitSha = "b".repeat(40);
  const staleProblems = outputConformanceProblems(outputConformanceEvidence(), profiles, venue.activeCameras, staleBinding);
  assert.ok(staleProblems.includes("Camera 1 output qualification is not bound to its YouTube destination"));
  assert.ok(staleProblems.includes("Camera 1 output qualification is not bound to its renderer"));
});

test("requires at least one successful external viewer playback observation per active camera", () => {
  const evidence = venue.activeCameras.map((camera) => ({ camera, broadcastId: `broadcast-${camera}`, observedAt: new Date(startedMs).toISOString(), passed: true }));
  const outputConformance = outputConformanceEvidence();
  assert.deepEqual(viewerEvidenceProblems(evidence, venue.activeCameras, outputConformance), []);
  evidence[2].passed = false;
  evidence[3].broadcastId = "another_broadcast";
  evidence.pop();
  const problems = viewerEvidenceProblems(evidence, venue.activeCameras, outputConformance);
  assert.ok(problems.includes("Camera 3 has a failed external viewer playback observation"));
  assert.ok(problems.includes("Camera 4 external viewer evidence does not match its qualified broadcast"));
  assert.ok(problems.includes("Camera 6 has no external viewer playback evidence"));
});

test("arms only when Speedify and every fail-closed router control are active", () => {
  const healthy = `Enabled: yes
Speedify state: CONNECTED
Ingest IP: 138.197.236.201
Runtime status: CONNECTED_ROUTED
Policy rules:
700: from all to 138.197.236.201 ipproto udp dport 8890 lookup 900
701: from all to 138.197.236.201 ipproto tcp dport 1935 lookup 900
710: from all to 138.197.236.201 ipproto udp dport 8890 lookup 901
711: from all to 138.197.236.201 ipproto tcp dport 1935 lookup 901
Primary route table 900:
default dev connectify0 scope link src 10.202.0.2
Guard route table 901:
blackhole default
Firewall kill switch: active
Validated state:
validated_upload_mbps=31
minimum_upload_mbps=31
ingest_ip=138.197.236.201
Watchdog lock owner: 19180
`;
  assert.deepEqual(productionRouterPreflightProblems(healthy, 31), []);

  const disconnected = healthy
    .replace("Speedify state: CONNECTED", "Speedify state: AUTO_CONNECTING")
    .replace("Runtime status: CONNECTED_ROUTED", "Runtime status: SPEEDIFY_UNAVAILABLE_BLOCKED")
    .replace(/700:.*\n701:.*\n710:.*\n711:.*\n/, "none\n")
    .replace("default dev connectify0 scope link src 10.202.0.2", "")
    .replace("Watchdog lock owner: 19180", "Watchdog lock owner: none");
  const problems = productionRouterPreflightProblems(disconnected, 31);
  assert.ok(problems.includes("Speedify is not connected"));
  assert.ok(problems.includes("camera traffic is not routed through Speedify"));
  assert.ok(problems.includes("the two primary camera routing rules are not exact"));
  assert.ok(problems.includes("the primary camera route is not on Speedify"));
  assert.ok(problems.includes("the fail-closed routing watchdog is not active"));
});

function snapshot({ active = true, sampledMs = startedMs, framesMultiplier = 0 } = {}) {
  const fixed = ["commentary", "observability", "ingest"].map((role) => agent(`bvm-${role}`, role));
  const compositors = Array.from({ length: 8 }, (_, index) => agent(`bvm-compositor-${index + 1}`, "compositor", index + 1, active && index < 6));
  const spare = agent("bvm-compositor-spare", "worker", null, false);
  return {
    version: 5,
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
      networkPath: "private-vpc",
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

function outputConformanceEvidence() {
  return Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
    const camera = index + 1;
    return [camera, {
      status: "QUALIFIED",
      court: camera,
      profile: profiles[camera].profile,
      renderer: { gitSha: "a".repeat(40), deploymentId: "dpl_renderer123" },
      sample: { sha256: String(camera).repeat(64), durationSeconds: 20 },
      destination: { streamId: `stream-${camera}`, broadcastId: `broadcast-${camera}` }
    }];
  }));
}

function routerEvidence() {
  const header = "timestamp\tspeedify_state\tsrt_route_dev\trtmp_route_dev\tprimary_rule_count\tguard_rule_count\tkill_switch\tcamera_flow_count\tconnectify_rx_bytes\tconnectify_tx_bytes\teth0_rx_bytes\teth0_tx_bytes\trmnet_rx_bytes\trmnet_tx_bytes\twireguard_handshake_age_seconds\tload1\tmem_available_kb\tspeedify_rss_kb\tstreaming_stats_process_count";
  const rows = Array.from({ length: 6 }, (_, index) => {
    const counter = 1_000_000 + index * 1_000_000;
    return [new Date(startedMs + index * 1_000).toISOString(), "CONNECTED", "connectify0", "connectify0", 2, 2, "active", 6, counter, counter, counter, counter, counter, counter, -1, 0.5, 170_000, 47_000, 0].join("\t");
  });
  return `${header}\n${rows.join("\n")}\n`;
}
