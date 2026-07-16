import assert from "node:assert/strict";
import test from "node:test";

import { RehearsalVerifier, fullProblems, idleProblems, preflightProblems, providerProblems, rawProblems } from "./rehearsal-verifier.mjs";

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
    version: 3,
    generatedAt: new Date(now).toISOString(),
    collector: { agentsExpected: 12, agentsFresh: 12 },
    event: null,
    incidents: [],
    faultGates: [],
    agents,
    courts: Array.from({ length: 8 }, (_, index) => {
      const court = index + 1;
      const path = (branch) => ({ ready: branch === "raw" ? raw : active, readerCount: active ? 1 : 0, inboundBitrateBps: branch === "raw" && raw ? 2_500_000 : active ? 2_000_000 : 0, frameErrors: 0, sourceMode: branch === "raw" && raw ? "PUSH" : null, sourceProtocol: branch === "raw" && raw ? (court <= 2 ? "RTMP" : "SRT") : null, videoCodec: branch === "raw" && raw ? "H264" : "H264", audioCodec: branch === "raw" && raw ? "AAC" : "Opus", videoWidth: 1280, videoHeight: 720 });
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

test("hard-cuts the rehearsal monitor fetch contract to version 3", async () => {
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

test("hard-cuts raw audio telemetry to the monitor AAC label", () => {
  const value = snapshot("raw");
  value.courts[0].paths.raw.audioCodec = "MPEG4Audio";
  assert.match(rawProblems(value, now).join("; "), /raw codec\/profile/);
});

test("accepts exact one-reader program chains, clean browser quality, commentary, Egress, and spare", () => {
  assert.deepEqual(fullProblems(snapshot("full"), now), []);
});

test("detects viewer, commentary, reader, FFmpeg, and headroom defects", () => {
  const value = snapshot("full");
  value.courts[0].paths.program.readerCount = 2;
  value.courts[0].ffmpeg.program.droppedFrames = 1;
  value.courts[0].browser.video.freezeCount = 1;
  value.courts[0].browser.commentary.syncStatus = "fallback";
  value.agents.find((agent) => agent.assignedCourts?.includes(1)).nativeServices.egress.cpuLoadRatio = 0.9;
  const problems = fullProblems(value, now).join("; ");
  assert.match(problems, /exactly one reader/);
  assert.match(problems, /FFmpeg/);
  assert.match(problems, /browser quality/);
  assert.match(problems, /commentary/);
  assert.match(problems, /headroom/);
});

test("accepts full post-stop retirement", () => {
  assert.deepEqual(idleProblems(snapshot("idle"), now), []);
});

test("requires each YouTube broadcast to be recording, unlisted, healthy, and bound to its exact stream", () => {
  const provider = {
    courts: Array.from({ length: 8 }, (_, index) => ({
      court: index + 1,
      streamId: `stream${index + 1}`,
      boundStreamId: `stream${index + 1}`,
      streamStatus: "active",
      healthStatus: "good",
      configurationIssues: [],
      broadcastLifecycle: "live",
      recordingStatus: "recording",
      privacyStatus: "unlisted"
    }))
  };
  assert.deepEqual(providerProblems(provider), []);
  provider.courts[0].boundStreamId = "wrong";
  assert.match(providerProblems(provider).join("; "), /exact stream/);
});
