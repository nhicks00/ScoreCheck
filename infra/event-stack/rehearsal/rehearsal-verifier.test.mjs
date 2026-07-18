import assert from "node:assert/strict";
import test from "node:test";

import { browserQualityDeltaProblems, RehearsalVerifier, fullCurrentProblems, fullProblems, idleProblems, preflightProblems, programSubscriberProblems, providerProblems, rawProblems } from "./rehearsal-verifier.mjs";

const now = Date.parse("2026-07-15T12:00:00Z");

function snapshot(mode) {
  const active = mode === "full";
  const raw = mode === "raw" || active;
  const host = { memoryTotalBytes: 8_000_000_000, memoryAvailableBytes: 6_000_000_000, diskTotalBytes: 80_000_000_000, diskFreeBytes: 60_000_000_000 };
  const services = [{ name: "scorecheck-service", running: true, healthy: true, restartCount: 0, oomKilled: false }];
  const agent = (value) => ({ host, services, ...value });
  const agents = [
    agent({ agentId: "commentary", role: "commentary", assignedCourts: [], state: "HEALTHY", nativeServices: null }),
    agent({ agentId: "ingest", role: "mediamtx", assignedCourts: [], state: "HEALTHY", nativeServices: null }),
    agent({ agentId: "observability", role: "observability", assignedCourts: [], state: "HEALTHY", nativeServices: null }),
    ...Array.from({ length: 8 }, (_, index) => agent({ agentId: `compositor-${index + 1}`, role: "compositor", assignedCourts: [index + 1], state: "HEALTHY", nativeServices: { egress: { idle: !active, canAcceptRequest: !active, activeWebRequests: active ? 1 : 0, maximumWebRequests: 1, cpuLoadRatio: active ? 0.4 : 0, memoryLoadRatio: active ? 0.4 : 0 } } })),
    agent({ agentId: "spare", role: "worker", assignedCourts: [], state: "HEALTHY", nativeServices: { egress: { idle: true, canAcceptRequest: true, activeWebRequests: 0, maximumWebRequests: 1, cpuLoadRatio: 0, memoryLoadRatio: 0 } } })
  ];
  return {
    version: 4,
    generatedAt: new Date(now).toISOString(),
    collector: { agentsExpected: 12, agentsFresh: 12 },
    event: null,
    incidents: [],
    faultGates: [],
    agents,
    courts: Array.from({ length: 8 }, (_, index) => {
      const court = index + 1;
      const path = (branch) => ({ ready: branch === "raw" ? raw : active, readerCount: active ? ({ raw: 2, preview: 2, program: 1 })[branch] : 0, inboundBitrateBps: branch === "raw" && raw ? 2_500_000 : active ? 2_000_000 : 0, frameErrors: 0, sourceMode: branch === "raw" && raw ? "PUSH" : null, sourceProtocol: branch === "raw" && raw ? (court <= 2 ? "RTMP" : "SRT") : null, videoCodec: "H264", videoProfile: "Main", audioCodec: branch === "raw" ? "AAC" : "Opus", videoWidth: 1280, videoHeight: 720, audioSampleRateHz: 48_000, audioChannelCount: 2 });
      return {
        courtNumber: court,
        paths: { raw: path("raw"), preview: path("preview"), program: path("program") },
        ffmpeg: active ? { preview: { framesPerSecond: 30, droppedFrames: 0, duplicatedFrames: 0, speedRatio: 1 }, program: { framesPerSecond: 30, droppedFrames: 0, duplicatedFrames: 0, speedRatio: 1 } } : {},
        browser: active ? {
          credentialId: `00000000-0000-4000-8000-00000000000${court}`,
          heartbeatSeq: 100,
          receivedAt: new Date(now).toISOString(),
          pageLoadedAt: new Date(now - 60_000).toISOString(),
          pageBuildVersion: "rehearsal-build",
          configurationVersion: "rehearsal-config",
          video: { state: "playing", connectionState: "connected", transport: "whep", framesRendered: 1_800, framesPerSecond: 30, framesDropped: 0, freezeCount: 0, totalFreezesDurationMs: 0, packetsLost: 0, reconnectCount: 0, reloadCount: 0 },
          commentary: {
            configured: true, roomConnected: true, participantCount: 1, audioTrackCount: 1, mutedAudioTrackCount: 0,
            rmsDb: -20, clippedSampleRatio: 0, secondsSinceAudio: 0, packetsLost: 0, cameraTrackPresent: true,
            cameraRmsDb: -24, cameraClippedSampleRatio: 0, secondsSinceCameraAudio: 0, syncStatus: "locked",
            targetDelayMs: 3_500, appliedDelayMs: 3_500, clockRttMs: 20, syncSampleAgeMs: 100
          }
        } : null
      };
    })
  };
}

test("accepts a completely idle isolated preflight", () => {
  assert.deepEqual(preflightProblems(snapshot("idle"), now), []);
});

test("hard-cuts the rehearsal monitor fetch contract to version 4", async () => {
  const verifier = (value) => new RehearsalVerifier({
    monitorOrigin: "https://monitor.example.com",
    monitorToken: "x".repeat(24),
    youtube: null,
    sampler: null,
    fetchImpl: async () => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }),
    sleep: async () => {},
    now: () => now
  });
  assert.equal((await verifier(snapshot("idle")).preflight()).passed, true);
  await assert.rejects(() => verifier({ ...snapshot("idle"), version: 2 }).preflight(), /snapshot contract is invalid/);
});

test("preserves the complete sanitized snapshot and problem set when stabilization expires", async () => {
  let current = now;
  const value = snapshot("idle");
  value.collector.agentsFresh = 11;
  const verifier = new RehearsalVerifier({
    monitorOrigin: "https://monitor.example.com",
    monitorToken: "x".repeat(24),
    youtube: null,
    sampler: null,
    fetchImpl: async () => new Response(JSON.stringify({ ...value, generatedAt: new Date(current).toISOString() }), { status: 200, headers: { "content-type": "application/json" } }),
    sleep: async (ms) => { current += ms; },
    now: () => current
  });
  await assert.rejects(() => verifier.preflight(), (error) => {
    assert.equal(error.name, "RehearsalStabilizationError");
    assert.equal(error.evidenceKind, "monitor");
    assert.equal(error.evidence.passed, false);
    assert.equal(error.evidence.snapshot.agentCount, 12);
    assert.match(error.evidence.problems.join("; "), /all 12 rehearsal agents fresh/);
    return true;
  });
});

test("reports a missing agent host snapshot without throwing", () => {
  const value = snapshot("idle");
  value.collector.agentsFresh = 11;
  value.agents[1].state = "UNKNOWN";
  value.agents[1].host = null;
  const problems = preflightProblems(value, now).join("; ");
  assert.match(problems, /all 12 rehearsal agents fresh/);
  assert.match(problems, /agents are unhealthy/);
  assert.match(problems, /insufficient memory headroom/);
});

test("accepts all eight protocol-correct raw camera feeds", () => {
  assert.deepEqual(rawProblems(snapshot("raw"), now), []);
});

test("requires the actual program browser commentary-room subscriber before microphone publication", async () => {
  const value = snapshot("full");
  value.courts[0].browser.commentary.participantCount = 0;
  value.courts[0].browser.commentary.audioTrackCount = 0;
  value.courts[0].browser.commentary.rmsDb = null;
  value.courts[0].browser.commentary.secondsSinceAudio = null;
  assert.deepEqual(programSubscriberProblems(value, now, 1), []);

  value.courts[0].browser.commentary.roomConnected = false;
  assert.match(programSubscriberProblems(value, now, 1).join("; "), /not connected to its commentary room/u);

  value.courts[0].browser.commentary.roomConnected = true;
  let current = now;
  let fetches = 0;
  const verifier = new RehearsalVerifier({
    monitorOrigin: "https://monitor.example.com",
    monitorToken: "x".repeat(24),
    youtube: null,
    sampler: null,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ ...value, generatedAt: new Date(current).toISOString(), courts: value.courts.map((court) => court.courtNumber === 1 ? { ...court, browser: { ...court.browser, receivedAt: new Date(current).toISOString() } } : court) }), { status: 200, headers: { "content-type": "application/json" } });
    },
    sleep: async (ms) => { current += ms; },
    now: () => current
  });
  const evidence = await verifier.waitForProgramSubscriber({ court: 1 });
  assert.equal(evidence.passed, true);
  assert.equal(evidence.stableSamples, 2);
  assert.equal(fetches, 2);
});

test("hard-cuts raw audio telemetry to the monitor AAC label", () => {
  const value = snapshot("raw");
  value.courts[0].paths.raw.audioCodec = "MPEG4Audio";
  assert.match(rawProblems(value, now).join("; "), /raw codec\/profile/);
});

test("rejects raw feeds that are unsafe for shared-ingest video stream copy", () => {
  const value = snapshot();
  value.courts[0].paths.raw.videoProfile = "High";
  value.courts[1].paths.raw.audioSampleRateHz = 44_100;
  value.courts[2].paths.raw.audioChannelCount = 1;
  assert.match(rawProblems(value, now).join("; "), /Camera 1 raw codec\/profile.*Camera 2 raw codec\/profile.*Camera 3 raw codec\/profile/);
});

test("accepts the exact normalization, commentary-preview, and program reader topology", () => {
  assert.deepEqual(fullProblems(snapshot("full"), now), []);
});

test("tolerates bounded monitor and browser clock skew while rejecting invalid or excessive future timestamps", () => {
  const value = snapshot("full");
  value.generatedAt = new Date(now + 5_000).toISOString();
  for (const court of value.courts) court.browser.receivedAt = new Date(now + 5_000).toISOString();
  assert.deepEqual(fullCurrentProblems(value, now), []);
  assert.deepEqual(programSubscriberProblems(value, now, 1), []);

  value.generatedAt = new Date(now + 5_001).toISOString();
  assert.match(fullCurrentProblems(value, now).join("; "), /monitor snapshot is stale/);

  value.generatedAt = new Date(now).toISOString();
  value.courts[0].browser.receivedAt = new Date(now + 5_001).toISOString();
  assert.match(fullCurrentProblems(value, now).join("; "), /Camera 1 browser heartbeat is not fresh/);
  assert.match(programSubscriberProblems(value, now, 1).join("; "), /Camera 1 program browser heartbeat is not fresh/);

  value.courts[0].browser.receivedAt = "not-a-timestamp";
  assert.match(fullCurrentProblems(value, now).join("; "), /Camera 1 browser heartbeat is not fresh/);
});

test("detects viewer, commentary, reader, FFmpeg, and headroom defects", () => {
  const value = snapshot("full");
  value.courts[0].paths.program.readerCount = 2;
  value.courts[0].ffmpeg.program.droppedFrames = 1;
  value.courts[0].browser.video.freezeCount = 1;
  value.courts[0].browser.commentary.syncStatus = "fallback";
  value.agents.find((agent) => agent.assignedCourts?.includes(1)).nativeServices.egress.cpuLoadRatio = 0.9;
  const problems = fullProblems(value, now).join("; ");
  assert.match(problems, /exactly 1 reader/);
  assert.match(problems, /FFmpeg/);
  assert.match(problems, /browser quality/);
  assert.match(problems, /commentary/);
  assert.match(problems, /headroom/);
});

test("uses a reset-safe quality window while preserving historical startup counters", async () => {
  let current = now;
  let sequence = 0;
  const verifier = new RehearsalVerifier({
    monitorOrigin: "https://monitor.example.com",
    monitorToken: "x".repeat(24),
    youtube: {
      getStream: async (id) => {
        const court = Number(id.replace("stream", ""));
        return { id, court, title: `ScoreCheck Court ${court} Test Stream`, isReusable: true, streamStatus: "active", healthStatus: "good", configurationIssues: [] };
      }
    },
    sampler: { inspect: async () => ({ pid: 42 }) },
    fetchImpl: async () => {
      const value = snapshot("full");
      for (const court of value.courts) {
        court.browser.heartbeatSeq = 100 + sequence;
        court.browser.receivedAt = new Date(current).toISOString();
        court.browser.video.framesRendered = 1_800 + sequence * 150;
      }
      value.courts[1].browser.video.freezeCount = 1;
      value.courts[1].browser.video.totalFreezesDurationMs = 200;
      value.courts[1].browser.commentary.packetsLost = 1;
      value.generatedAt = new Date(current).toISOString();
      sequence += 1;
      return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    },
    sleep: async (ms) => { current += ms; },
    now: () => current
  });
  const state = {
    sampler: { output: "/tmp/rehearsal-sampler.ndjson" },
    courts: Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
      const court = index + 1;
      return [court, { stream: { id: `stream${court}` } }];
    })),
    providerMode: "persistent-youtube-stream-ingest-v1"
  };

  const result = await verifier.waitForFull({ state });
  assert.equal(result.passed, true);
  assert.equal(result.stableSamples, 6);
  assert.equal(result.qualityWindow.baseline[1].freezeCount, 1);
  assert.equal(result.qualityWindow.endpoint[1].freezeCount, 1);
  assert.equal(result.qualityWindow.baseline[1].commentaryPacketsLost, 1);
  assert.equal(result.qualityWindow.endpoint[1].commentaryPacketsLost, 1);
  assert.deepEqual(result.problems, []);
});

test("restores a persisted accepted browser baseline across CLI process boundaries", async () => {
  let current = now + 5_000;
  const baseline = snapshot("full");
  const currentSnapshot = structuredClone(baseline);
  currentSnapshot.generatedAt = new Date(current).toISOString();
  for (const court of currentSnapshot.courts) {
    court.browser.heartbeatSeq += 1;
    court.browser.receivedAt = new Date(current).toISOString();
    court.browser.video.framesRendered += 150;
  }
  const verifier = new RehearsalVerifier({
    monitorOrigin: "https://monitor.example.com",
    monitorToken: "x".repeat(24),
    youtube: null,
    sampler: { inspect: async () => ({ pid: 42 }) },
    fetchImpl: async () => new Response(JSON.stringify(currentSnapshot), { status: 200, headers: { "content-type": "application/json" } }),
    sleep: async () => {},
    now: () => current
  });
  assert.deepEqual(verifier.restoreAcceptedFullSnapshot(baseline), { restored: true, generatedAt: baseline.generatedAt });
  const observation = await verifier.observeFull({ state: { sampler: { output: "/tmp/pool.jsonl" } } });
  assert.equal(observation.passed, true);
  assert.deepEqual(observation.problems, []);
  assert.throws(() => verifier.restoreAcceptedFullSnapshot(snapshot("idle")), /persisted rehearsal browser quality baseline is incomplete/);
});

test("rejects browser counter growth and identity or heartbeat discontinuity", () => {
  const before = snapshot("full");
  const after = structuredClone(before);
  for (const court of after.courts) {
    court.browser.heartbeatSeq += 1;
    court.browser.receivedAt = new Date(now + 5_000).toISOString();
    court.browser.video.framesRendered += 150;
  }
  assert.deepEqual(browserQualityDeltaProblems(before, after), []);

  after.courts[0].browser.video.framesDropped += 1;
  after.courts[1].browser.pageLoadedAt = new Date(now).toISOString();
  after.courts[2].browser.heartbeatSeq -= 1;
  after.courts[3].browser.commentary.packetsLost += 1;
  const problems = browserQualityDeltaProblems(before, after).join("; ");
  assert.match(problems, /Camera 1 browser framesDropped changed/);
  assert.match(problems, /Camera 2 browser pageLoadedAt changed/);
  assert.match(problems, /Camera 3 browser heartbeat sequence did not advance/);
  assert.match(problems, /Camera 4 commentary packetsLost changed/);
});

test("uses reset-safe rendered-frame deltas instead of quantized point-in-time browser FPS", () => {
  const before = snapshot("full");
  const after = structuredClone(before);
  for (const court of before.courts) court.browser.video.framesPerSecond = 47;
  for (const court of after.courts) {
    court.browser.video.framesPerSecond = 12;
    court.browser.heartbeatSeq += 1;
    court.browser.receivedAt = new Date(now + 5_000).toISOString();
    court.browser.video.framesRendered += 150;
  }
  assert.deepEqual(fullCurrentProblems(before, now), []);
  assert.deepEqual(browserQualityDeltaProblems(before, after), []);

  after.courts[0].browser.video.framesRendered -= 100;
  assert.match(browserQualityDeltaProblems(before, after).join("; "), /Camera 1 aggregate rendered cadence is outside 25-35fps \(10\.00fps\)/);
});

test("keeps strict point-in-time checks while current health tolerates flat startup history", () => {
  const value = snapshot("full");
  value.courts[0].browser.video.freezeCount = 1;
  value.courts[0].browser.video.totalFreezesDurationMs = 200;
  value.courts[0].browser.commentary.packetsLost = 1;
  assert.match(fullProblems(value, now).join("; "), /browser quality counters are not clean/);
  assert.match(fullProblems(value, now).join("; "), /commentary\/audio synchronization is not healthy/);
  assert.deepEqual(fullCurrentProblems(value, now), []);
});

test("accepts full post-stop retirement", () => {
  assert.deepEqual(idleProblems(snapshot("idle"), now), []);
});

test("requires each persistent YouTube stream to be exact, reusable, active, and healthy", () => {
  const provider = {
    mode: "persistent-youtube-stream-ingest-v1",
    courts: Array.from({ length: 8 }, (_, index) => ({
      court: index + 1,
      streamId: `stream${index + 1}`,
      title: `ScoreCheck Court ${index + 1} Test Stream`,
      isReusable: true,
      streamStatus: "active",
      healthStatus: "good",
      configurationIssues: []
    }))
  };
  assert.deepEqual(providerProblems(provider), []);
  provider.courts[0].title = "wrong";
  assert.match(providerProblems(provider).join("; "), /persistent YouTube ingest stream/);
});
