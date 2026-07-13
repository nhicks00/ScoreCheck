import { describe, expect, it } from "vitest";
import type { AgentTarget } from "./config.js";
import { browserHeartbeatPayloadSchema, type AgentSnapshot, type BrowserHeartbeatSnapshot, type ControlPlaneSnapshot, type IncidentSnapshot } from "./contracts.js";
import { buildMonitorSnapshot, type AgentRuntime } from "./correlator.js";

const target: AgentTarget = { id: "preview", role: "mediamtx", url: "http://agent", token: "abcdefghijklmnopqrstuvwxyz", assignedCourts: [] };
const compositorTarget: AgentTarget = { id: "compositor-a", role: "compositor", url: "http://compositor-agent", token: "zyxwvutsrqponmlkjihgfedcba", assignedCourts: [1, 2] };

describe("monitor correlator", () => {
  it("never preserves stale green agent state", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const snapshot = emptyAgentSnapshot(generatedAt);
    const runtimes = new Map<string, AgentRuntime>([[target.id, { target, snapshot, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const result = buildMonitorSnapshot([target], runtimes, 1, Date.parse(generatedAt) + 21_000);
    expect(result.agents[0]?.state).toBe("UNKNOWN");
    expect(result.collector.state).toBe("UNKNOWN");
  });

  it("reports healthy observed paths and expected-off unobserved stages", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const snapshot: AgentSnapshot = {
      ...emptyAgentSnapshot(generatedAt),
      mediaPaths: [{
        name: "court1_raw",
        courtNumber: 1,
        branch: "raw",
        ready: true,
        readySince: generatedAt,
        bytesReceived: 10,
        bytesSent: 0,
        inboundBitrateBps: null,
        frameErrors: 0,
        readerCount: 0,
        sourceProtocol: "RTMP",
        sourceMode: "PUSH",
        videoCodec: "H264",
        audioCodec: "AAC",
        videoWidth: 1920,
        videoHeight: 1080,
        videoProfile: "Main",
        audioSampleRateHz: 48_000,
        audioChannelCount: 2,
        transport: null
      }]
    };
    const runtimes = new Map<string, AgentRuntime>([[target.id, { target, snapshot, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const result = buildMonitorSnapshot([target], runtimes, 1, Date.parse(generatedAt) + 1_000);
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "RAW_INGEST")?.state).toBe("HEALTHY");
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "PREVIEW")?.state).toBe("EXPECTED_OFF");
  });

  it("keeps an advertised but inactive on-demand path expected-off", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const snapshot: AgentSnapshot = {
      ...emptyAgentSnapshot(generatedAt),
      mediaPaths: [{
        name: "court1_preview",
        courtNumber: 1,
        branch: "preview",
        ready: false,
        readySince: null,
        bytesReceived: 0,
        bytesSent: 0,
        inboundBitrateBps: 0,
        frameErrors: 0,
        readerCount: 0,
        sourceProtocol: null,
        sourceMode: null,
        videoCodec: null,
        audioCodec: null,
        videoWidth: null,
        videoHeight: null,
        videoProfile: null,
        audioSampleRateHz: null,
        audioChannelCount: null,
        transport: null
      }]
    };
    const runtimes = new Map<string, AgentRuntime>([[target.id, { target, snapshot, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const result = buildMonitorSnapshot([target], runtimes, 1, Date.parse(generatedAt) + 1_000);
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "PREVIEW")?.state).toBe("EXPECTED_OFF");
    expect(result.courts[0]?.overallState).toBe("EXPECTED_OFF");
  });

  it("escalates missing media and browser telemetry only when explicitly required", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const snapshot = emptyAgentSnapshot(generatedAt);
    const runtimes = new Map<string, AgentRuntime>([[target.id, { target, snapshot, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const result = buildMonitorSnapshot(
      [target],
      runtimes,
      1,
      Date.parse(generatedAt) + 1_000,
      [],
      new Map(),
      liveControlPlane(generatedAt)
    );
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "RAW_INGEST")?.state).toBe("CRITICAL");
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "PROGRAM_BROWSER")?.state).toBe("CRITICAL");
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "SCORE_SOURCE")?.state).toBe("HEALTHY");
  });

  it("projects durable court incidents onto the matching pipeline stage", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const snapshot: AgentSnapshot = {
      ...emptyAgentSnapshot(generatedAt),
      mediaPaths: [{
        name: "court1_preview",
        courtNumber: 1,
        branch: "preview",
        ready: true,
        readySince: generatedAt,
        bytesReceived: 10,
        bytesSent: 10,
        inboundBitrateBps: 2_000_000,
        frameErrors: 0,
        readerCount: 1,
        sourceProtocol: "RTMP",
        sourceMode: "PUSH",
        videoCodec: "H264",
        audioCodec: "AAC",
        videoWidth: 1920,
        videoHeight: 1080,
        videoProfile: "Main",
        audioSampleRateHz: 48_000,
        audioChannelCount: 2,
        transport: null
      }]
    };
    const incident: IncidentSnapshot = {
      id: "30000000-0000-4000-8000-000000000001",
      fingerprint: "event|ffmpeg|PREVIEW|1|PREVIEW_BRANCH_FPS_LOW",
      eventId: "10000000-0000-4000-8000-000000000001",
      rootDependency: "mediamtx-ffmpeg",
      status: "acknowledged",
      severity: "critical",
      stage: "PREVIEW",
      issueCode: "PREVIEW_BRANCH_FPS_LOW",
      courtNumber: 1,
      host: null,
      summary: "Preview normalization FPS is below 20.",
      firstAction: "Inspect the preview branch.",
      openedAt: generatedAt,
      lastObservedAt: generatedAt,
      acknowledgedAt: generatedAt,
      acknowledgedBy: "operator",
      resolvedAt: null
    };
    const runtimes = new Map<string, AgentRuntime>([[target.id, { target, snapshot, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const result = buildMonitorSnapshot([target], runtimes, 1, Date.parse(generatedAt) + 1_000, [incident]);
    const preview = result.courts[0]?.stages.find((stage) => stage.stage === "PREVIEW");
    expect(preview?.state).toBe("CRITICAL");
    expect(preview?.issueCode).toBe("PREVIEW_BRANCH_FPS_LOW");
    expect(preview?.evidence.incidentId).toBe(incident.id);
    expect(result.courts[0]?.overallState).toBe("CRITICAL");
  });

  it("maps each court to its assigned compositor and treats a busy Egress worker as healthy", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const compositor = {
      ...emptyAgentSnapshot(generatedAt),
      agentId: compositorTarget.id,
      role: "compositor" as const,
      assignedCourts: [1, 2],
      nativeServices: {
        endpoints: [{ service: "egress-metrics" as const, up: true }, { service: "egress-health" as const, up: true }],
        livekit: null,
        egress: { idle: false, canAcceptRequest: true, cgroupMemoryBytes: 700_000_000, cpuLoadRatio: 0.4, memoryLoadRatio: 0.2 }
      }
    };
    const runtimes = new Map<string, AgentRuntime>([[compositorTarget.id, { target: compositorTarget, snapshot: compositor, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const result = buildMonitorSnapshot([compositorTarget], runtimes, 1, Date.parse(generatedAt) + 1_000, [], new Map(), liveControlPlane(generatedAt));
    const egress = result.courts[0]?.stages.find((stage) => stage.stage === "EGRESS");
    expect(result.courts[0]?.egressHost).toBe(compositorTarget.id);
    expect(egress?.state).toBe("HEALTHY");
    expect(egress?.summary).toContain("processing output");
    expect(egress?.evidence.idle).toBe(false);
    expect(egress?.evidence.host).toBe(compositorTarget.id);
  });

  it("detects a repeated full-bitrate picture while transport frames continue", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const agent = rawAgentSnapshot(generatedAt);
    const runtimes = new Map<string, AgentRuntime>([[target.id, { target, snapshot: agent, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const browser = browserHeartbeat(generatedAt, { frozenDurationMs: 16_000 });
    const result = buildMonitorSnapshot([target], runtimes, 1, Date.parse(generatedAt) + 1_000, [], new Map([[1, browser]]), liveControlPlane(generatedAt));
    const ingest = result.courts[0]?.stages.find((stage) => stage.stage === "RAW_INGEST");
    expect(ingest?.state).toBe("CRITICAL");
    expect(ingest?.issueCode).toBe("FULL_BITRATE_VISUAL_FREEZE");
    expect(ingest?.evidence.renderedFps).toBe(30);
  });

  it("distinguishes a persistently black picture from a missing transport", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const agent = rawAgentSnapshot(generatedAt);
    const runtimes = new Map<string, AgentRuntime>([[target.id, { target, snapshot: agent, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const browser = browserHeartbeat(generatedAt, { blackDurationMs: 21_000, meanLuma: 2, lumaVariance: 1, darkPixelRatio: 1 });
    const result = buildMonitorSnapshot([target], runtimes, 1, Date.parse(generatedAt) + 1_000, [], new Map([[1, browser]]), liveControlPlane(generatedAt));
    const ingest = result.courts[0]?.stages.find((stage) => stage.stage === "RAW_INGEST");
    expect(ingest?.issueCode).toBe("CAMERA_CONTENT_BLACK");
    expect(ingest?.evidence.renderedFps).toBe(30);
  });

  it("makes a missing required commentary track critical without declaring video down", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const agent = rawAgentSnapshot(generatedAt);
    const runtimes = new Map<string, AgentRuntime>([[target.id, { target, snapshot: agent, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const browser = browserHeartbeat(generatedAt);
    const result = buildMonitorSnapshot([target], runtimes, 1, Date.parse(generatedAt) + 1_000, [], new Map([[1, browser]]), liveControlPlane(generatedAt));
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "COMMENTARY")?.issueCode).toBe("COMMENTARY_TRACK_MISSING");
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "PROGRAM_BROWSER")?.state).toBe("HEALTHY");
  });
});

function rawAgentSnapshot(generatedAt: string): AgentSnapshot {
  return {
    ...emptyAgentSnapshot(generatedAt),
    mediaPaths: [{
      name: "court1_raw",
      courtNumber: 1,
      branch: "raw",
      ready: true,
      readySince: generatedAt,
      bytesReceived: 10_000_000,
      bytesSent: 0,
      inboundBitrateBps: 4_000_000,
      frameErrors: 0,
      readerCount: 1,
      sourceProtocol: "RTMP",
      sourceMode: "PUSH",
      videoCodec: "H264",
      audioCodec: "AAC",
      videoWidth: 1920,
      videoHeight: 1080,
      videoProfile: "Main",
      audioSampleRateHz: 48_000,
      audioChannelCount: 2,
      transport: null
    }]
  };
}

function browserHeartbeat(observedAt: string, visual: Partial<BrowserHeartbeatSnapshot["visual"]> = {}): BrowserHeartbeatSnapshot {
  const payload = browserHeartbeatPayloadSchema.parse({
    version: 2,
    credentialId: "40000000-0000-4000-8000-000000000001",
    courtNumber: 1,
    heartbeatSeq: 1,
    sampledAt: observedAt,
    pageLoadedAt: observedAt,
    pageBuildVersion: "test",
    configurationVersion: "test",
    video: {
      state: "playing",
      transport: "whep",
      connectionState: "connected",
      framesRendered: 900,
      framesPerSecond: 30,
      width: 1280,
      height: 720,
      rttMs: 20,
      jitterBufferMs: 80,
      packetsLost: 0,
      packetsReceived: 1_000,
      framesDropped: 0,
      bytesReceived: 5_000_000,
      reconnectCount: 0,
      reloadCount: 0
    },
    visual: {
      sampledAt: observedAt,
      meanLuma: 120,
      lumaVariance: 900,
      darkPixelRatio: 0.02,
      frameDifference: 14,
      frozenDurationMs: 0,
      blackDurationMs: 0,
      ...visual
    },
    commentary: {
      configured: true,
      roomConnected: true,
      participantCount: 0,
      audioTrackCount: 0,
      rmsDb: null,
      peakDb: null,
      secondsSinceAudio: null,
      cameraTrackPresent: true,
      cameraRmsDb: -24,
      syncStatus: "fallback",
      configuredDelayMs: null,
      targetDelayMs: null,
      appliedDelayMs: null,
      clockRttMs: null,
      syncSampleAgeMs: null
    },
    scoreRender: {
      loaded: true,
      connected: true,
      stale: false,
      frozen: false,
      matchId: null,
      phase: "LIVE",
      sourceSignature: "same",
      renderedSignature: "same",
      domMismatchReason: null,
      stateUpdatedAt: observedAt
    }
  });
  return { ...payload, receivedAt: observedAt };
}

function liveControlPlane(observedAt: string): ControlPlaneSnapshot {
  return {
    observedAt,
    event: { id: "10000000-0000-4000-8000-000000000001", name: "Test", status: "live", eventDate: "2026-07-12" },
    worker: { state: "HEALTHY", status: "active", lastSeenAt: observedAt, ageMs: 0 },
    courts: [{
      courtId: "20000000-0000-4000-8000-000000000001",
      courtNumber: 1,
      displayName: "Court 1",
      physicalCourtLabel: "Stadium",
      courtStatus: "live",
      expectation: {
        coveragePhase: "LIVE_MATCH",
        mediaExpectation: "REQUIRED",
        broadcastExpectation: "LIVE",
        commentaryExpectation: "REQUIRED",
        scoringExpectation: "LIVE",
        overrideExpiresAt: null
      },
      currentMatch: null,
      nextMatch: null,
      score: null,
      overlay: null,
      alignment: { state: "HEALTHY", issueCodes: [], sourceAgeMs: 1_000 },
      youtubeVideoId: null
    }]
  };
}

function emptyAgentSnapshot(generatedAt: string): AgentSnapshot {
  return {
    version: 2,
    agentId: "preview",
    role: "mediamtx",
    assignedCourts: [],
    generatedAt,
    collectionDurationMs: 1,
    collectionErrors: [],
    host: { uptimeSeconds: 1, load1: 0, memoryTotalBytes: 1, memoryAvailableBytes: 1, diskTotalBytes: 1, diskFreeBytes: 1 },
    services: [],
    mediaPaths: [],
    ffmpegBranches: [],
    nativeServices: { endpoints: [], livekit: null, egress: null }
  };
}
