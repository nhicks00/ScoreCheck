import { describe, expect, it } from "vitest";
import type { AgentTarget } from "./config.js";
import {
  browserHeartbeatPayloadSchema,
  type AgentSnapshot,
  type BrowserHeartbeatSnapshot,
  type ControlPlaneSnapshot,
  type YouTubeMonitorSnapshot
} from "./contracts.js";
import { buildMonitorSnapshot, type AgentRuntime } from "./correlator.js";
import { IncidentManager } from "./incidents.js";

const observedAt = "2026-07-12T18:00:00.000Z";
const nowMs = Date.parse(observedAt) + 1_000;
const mediaTarget: AgentTarget = { id: "bvm-preview-01", role: "mediamtx", url: "http://media", token: "abcdefghijklmnopqrstuvwxyz", assignedCourts: [] };
const compositorTargets: AgentTarget[] = [
  { id: "bvm-compositor-a", role: "compositor", url: "http://a", token: "abcdefghijklmnopqrstuvwxyz", assignedCourts: [1, 2] },
  { id: "bvm-compositor-b", role: "compositor", url: "http://b", token: "abcdefghijklmnopqrstuvwxyz", assignedCourts: [3, 4] },
  { id: "bvm-compositor-c", role: "compositor", url: "http://c", token: "abcdefghijklmnopqrstuvwxyz", assignedCourts: [5, 6] },
  { id: "bvm-compositor-d", role: "compositor", url: "http://d", token: "abcdefghijklmnopqrstuvwxyz", assignedCourts: [7, 8] }
];
const targets = [mediaTarget, ...compositorTargets];

describe("deterministic eight-court fault gate", () => {
  it("keeps a stopped camera publisher isolated to its physical court", () => {
    const media = mediaAgent();
    media.mediaPaths = media.mediaPaths.filter((path) => !(path.courtNumber === 4 && path.branch === "raw"));
    const snapshot = build(media, healthyBrowsers());
    expect(criticalCourts(snapshot)).toEqual([4]);
    expect(stage(snapshot, 4, "RAW_INGEST")?.issueCode).toBe("REQUIRED_PATH_MISSING");
    expect(stage(snapshot, 3, "RAW_INGEST")?.state).toBe("HEALTHY");
    expect(stage(snapshot, 5, "RAW_INGEST")?.state).toBe("HEALTHY");
  });

  it("detects repeated content on one court without blaming its transport or seven peers", () => {
    const browsers = healthyBrowsers();
    browsers.set(3, browser(3, { frozenDurationMs: 16_000 }));
    const snapshot = build(mediaAgent(), browsers);
    expect(criticalCourts(snapshot)).toEqual([3]);
    expect(stage(snapshot, 3, "RAW_INGEST")?.issueCode).toBe("FULL_BITRATE_VISUAL_FREEZE");
    expect(stage(snapshot, 3, "PROGRAM_BROWSER")?.state).toBe("HEALTHY");
  });

  it("limits a compositor failure to its assigned court pair", () => {
    const runtimes = healthyRuntimes(mediaAgent());
    const failed = compositorTargets[1]!;
    runtimes.set(failed.id, { target: failed, snapshot: null, lastSeenAt: null, lastErrorAt: observedAt });
    const snapshot = buildMonitorSnapshot(targets, runtimes, 8, nowMs, [], healthyBrowsers(), controlPlane(), youtube());
    expect(criticalCourts(snapshot)).toEqual([3, 4]);
    expect(stage(snapshot, 3, "EGRESS")?.issueCode).toBe("EGRESS_HOST_UNREACHABLE");
    expect(stage(snapshot, 4, "EGRESS")?.issueCode).toBe("EGRESS_HOST_UNREACHABLE");
    expect(stage(snapshot, 2, "EGRESS")?.state).toBe("HEALTHY");
    expect(stage(snapshot, 5, "EGRESS")?.state).toBe("HEALTHY");
  });

  it("keeps a wrong rendered score identity isolated from score source and other courts", () => {
    const browsers = healthyBrowsers();
    const wrong = browser(5);
    wrong.scoreRender.renderedSignature = "wrong-match";
    browsers.set(5, wrong);
    const snapshot = build(mediaAgent(), browsers);
    expect(criticalCourts(snapshot)).toEqual([5]);
    expect(stage(snapshot, 5, "SCORE_RENDER")?.issueCode).toBe("SCOREBUG_DOM_MISMATCH");
    expect(stage(snapshot, 5, "SCORE_SOURCE")?.state).toBe("HEALTHY");
  });

  it("reports YouTube API failure as unknown instead of a definitive stream outage", () => {
    const provider = youtube();
    provider.apiState = "UNKNOWN";
    const snapshot = buildMonitorSnapshot(targets, healthyRuntimes(mediaAgent()), 8, nowMs, [], healthyBrowsers(), controlPlane(), provider);
    expect(snapshot.courts.every((court) => stage(snapshot, court.courtNumber, "YOUTUBE")?.state === "UNKNOWN")).toBe(true);
    expect(snapshot.courts.some((court) => stage(snapshot, court.courtNumber, "YOUTUBE")?.state === "CRITICAL")).toBe(false);
  });

  it("models a paused score worker as one shared incident rather than eight pages", () => {
    const manager = new IncidentManager();
    manager.applyWebhook({
      status: "firing",
      alerts: [{
        status: "firing",
        labels: { severity: "critical", stage: "SCORE_SOURCE", issue_code: "SCORE_WORKER_UNAVAILABLE", root_dependency: "scorecheck-worker" },
        annotations: { summary: "Shared score worker unavailable." }
      }]
    }, new Date(observedAt));
    manager.applyWebhook({
      status: "firing",
      alerts: [{
        status: "firing",
        labels: { severity: "critical", stage: "SCORE_SOURCE", issue_code: "SCORE_WORKER_UNAVAILABLE", root_dependency: "scorecheck-worker" },
        annotations: { summary: "Shared score worker still unavailable." }
      }]
    }, new Date(nowMs));
    expect(manager.active()).toHaveLength(1);
    expect(manager.active()[0]?.courtNumber).toBeNull();
    expect(manager.active()[0]?.rootDependency).toBe("SCORECHECK-WORKER");
  });
});

function build(media: AgentSnapshot, browsers: Map<number, BrowserHeartbeatSnapshot>) {
  return buildMonitorSnapshot(targets, healthyRuntimes(media), 8, nowMs, [], browsers, controlPlane(), youtube());
}

function healthyRuntimes(media: AgentSnapshot): Map<string, AgentRuntime> {
  const runtimes = new Map<string, AgentRuntime>([[mediaTarget.id, { target: mediaTarget, snapshot: media, lastSeenAt: observedAt, lastErrorAt: null }]]);
  compositorTargets.forEach((target, index) => {
    const firstCourt = index * 2 + 1;
    runtimes.set(target.id, {
      target,
      snapshot: compositorAgent(target.id, [firstCourt, firstCourt + 1]),
      lastSeenAt: observedAt,
      lastErrorAt: null
    });
  });
  return runtimes;
}

function mediaAgent(): AgentSnapshot {
  return {
    ...agentBase("bvm-preview-01", "mediamtx"),
    mediaPaths: Array.from({ length: 8 }, (_, index) => index + 1).flatMap((courtNumber) =>
      (["raw", "preview", "program"] as const).map((branch) => ({
        name: `court${courtNumber}_${branch}` as `court${number}_${typeof branch}`,
        courtNumber,
        branch,
        ready: true,
        readySince: observedAt,
        bytesReceived: 10_000_000,
        bytesSent: 9_000_000,
        inboundBitrateBps: 4_000_000,
        frameErrors: 0,
        readerCount: 1,
        sourceProtocol: "RTMP" as const,
        sourceMode: "PUSH" as const,
        videoCodec: "H264",
        audioCodec: "AAC",
        videoWidth: 1920,
        videoHeight: 1080,
        videoProfile: "Main",
        audioSampleRateHz: 48_000,
        audioChannelCount: 2,
        transport: null
      })))
  };
}

function compositorAgent(agentId: string, assignedCourts: number[]): AgentSnapshot {
  return {
    ...agentBase(agentId, "compositor"),
    assignedCourts,
    nativeServices: {
      endpoints: [{ service: "egress-metrics", up: true }, { service: "egress-health", up: true }],
      livekit: null,
      egress: { idle: true, canAcceptRequest: true, nativeCanAcceptRequest: true, activeWebRequests: 0, maximumWebRequests: 1, cgroupMemoryBytes: 750_000_000, cpuLoadRatio: 0.3, memoryLoadRatio: 0.2 }
    }
  };
}

function agentBase(agentId: string, role: AgentSnapshot["role"]): AgentSnapshot {
  return {
    version: 2,
    agentId,
    role,
    assignedCourts: [],
    generatedAt: observedAt,
    collectionDurationMs: 5,
    collectionErrors: [],
    host: { uptimeSeconds: 1_000, load1: 0.2, memoryTotalBytes: 8_000_000_000, memoryAvailableBytes: 6_000_000_000, diskTotalBytes: 80_000_000_000, diskFreeBytes: 60_000_000_000 },
    services: [],
    mediaPaths: [],
    ffmpegBranches: [],
    nativeServices: { endpoints: [], livekit: null, egress: null }
  };
}

function healthyBrowsers(): Map<number, BrowserHeartbeatSnapshot> {
  return new Map(Array.from({ length: 8 }, (_, index) => [index + 1, browser(index + 1)]));
}

function browser(courtNumber: number, visualPatch: Partial<BrowserHeartbeatSnapshot["visual"]> = {}): BrowserHeartbeatSnapshot {
  const payload = browserHeartbeatPayloadSchema.parse({
    version: 2,
    credentialId: `40000000-0000-4000-8000-${String(courtNumber).padStart(12, "0")}`,
    courtNumber,
    heartbeatSeq: 1,
    sampledAt: observedAt,
    pageLoadedAt: observedAt,
    pageBuildVersion: "test",
    configurationVersion: "test",
    video: { state: "playing", transport: "whep", connectionState: "connected", framesRendered: 1_000, framesPerSecond: 30, width: 1280, height: 720, rttMs: 20, jitterBufferMs: 80, packetsLost: 0, packetsReceived: 1_000, framesDropped: 0, bytesReceived: 5_000_000, reconnectCount: 0, reloadCount: 0 },
    visual: { sampledAt: observedAt, meanLuma: 120, lumaVariance: 900, darkPixelRatio: 0.02, frameDifference: 14, frozenDurationMs: 0, blackDurationMs: 0, ...visualPatch },
    commentary: { configured: false, roomConnected: false, participantCount: 0, audioTrackCount: 0, rmsDb: null, peakDb: null, secondsSinceAudio: null, cameraTrackPresent: true, cameraRmsDb: -24, syncStatus: "fallback", configuredDelayMs: null, targetDelayMs: null, appliedDelayMs: null, clockRttMs: null, syncSampleAgeMs: null },
    scoreRender: { loaded: true, connected: true, stale: false, frozen: false, matchId: `match-${courtNumber}`, phase: "LIVE", sourceSignature: `match-${courtNumber}`, renderedSignature: `match-${courtNumber}`, domMismatchReason: null, stateUpdatedAt: observedAt }
  });
  return { ...payload, receivedAt: observedAt };
}

function controlPlane(): ControlPlaneSnapshot {
  return {
    observedAt,
    event: { id: "10000000-0000-4000-8000-000000000001", name: "Eight Court Gate", status: "live", eventDate: "2026-07-12" },
    worker: { state: "HEALTHY", status: "active", lastSeenAt: observedAt, ageMs: 0 },
    courts: Array.from({ length: 8 }, (_, index) => {
      const courtNumber = index + 1;
      return {
        courtId: `20000000-0000-4000-8000-${String(courtNumber).padStart(12, "0")}`,
        courtNumber,
        displayName: `Court ${courtNumber}`,
        physicalCourtLabel: courtNumber === 1 ? "Stadium" : `Court ${courtNumber}`,
        courtStatus: "live",
        expectation: { coveragePhase: "LIVE_MATCH" as const, mediaExpectation: "REQUIRED" as const, broadcastExpectation: "LIVE" as const, commentaryExpectation: "OPTIONAL" as const, scoringExpectation: "LIVE" as const, overrideExpiresAt: null },
        currentMatch: null,
        nextMatch: null,
        score: null,
        overlay: null,
        alignment: { state: "HEALTHY" as const, issueCodes: [], sourceAgeMs: 1_000 },
        youtubeVideoId: `video-${courtNumber}`
      };
    })
  };
}

function youtube(): YouTubeMonitorSnapshot {
  return {
    observedAt,
    apiState: "HEALTHY",
    courts: Array.from({ length: 8 }, (_, index) => ({
      courtNumber: index + 1,
      videoId: `video-${index + 1}`,
      state: "HEALTHY" as const,
      broadcastLifecycle: "live",
      streamStatus: "active",
      healthStatus: "good",
      configurationIssues: [],
      observedAt
    }))
  };
}

function criticalCourts(snapshot: ReturnType<typeof buildMonitorSnapshot>): number[] {
  return snapshot.courts.filter((court) => court.overallState === "CRITICAL").map((court) => court.courtNumber);
}

function stage(snapshot: ReturnType<typeof buildMonitorSnapshot>, courtNumber: number, name: string) {
  return snapshot.courts.find((court) => court.courtNumber === courtNumber)?.stages.find((entry) => entry.stage === name);
}
