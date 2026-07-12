import { describe, expect, it } from "vitest";
import type { AgentTarget } from "./config.js";
import type { AgentSnapshot, ControlPlaneSnapshot, IncidentSnapshot } from "./contracts.js";
import { buildMonitorSnapshot, type AgentRuntime } from "./correlator.js";

const target: AgentTarget = { id: "preview", role: "mediamtx", url: "http://agent", token: "abcdefghijklmnopqrstuvwxyz" };
const compositorTarget: AgentTarget = { id: "compositor-a", role: "compositor", url: "http://compositor-agent", token: "zyxwvutsrqponmlkjihgfedcba" };

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
        videoCodec: "H264",
        audioCodec: "MPEG4Audio"
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
        videoCodec: null,
        audioCodec: null
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
        videoCodec: "H264",
        audioCodec: "MPEG4Audio"
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

  it("maps each court to its assigned compositor and evaluates Egress capacity", () => {
    const generatedAt = "2026-07-12T12:00:00.000Z";
    const compositor = {
      ...emptyAgentSnapshot(generatedAt),
      agentId: compositorTarget.id,
      role: "compositor" as const,
      assignedCourts: [1, 2],
      nativeServices: {
        endpoints: [{ service: "egress-metrics" as const, up: true }, { service: "egress-health" as const, up: true }],
        livekit: null,
        egress: { available: true, canAcceptRequest: true, cgroupMemoryBytes: 700_000_000, cpuLoadRatio: 0.4, memoryLoadRatio: 0.2 }
      }
    };
    const runtimes = new Map<string, AgentRuntime>([[compositorTarget.id, { target: compositorTarget, snapshot: compositor, lastSeenAt: generatedAt, lastErrorAt: null }]]);
    const result = buildMonitorSnapshot([compositorTarget], runtimes, 1, Date.parse(generatedAt) + 1_000, [], new Map(), liveControlPlane(generatedAt));
    const egress = result.courts[0]?.stages.find((stage) => stage.stage === "EGRESS");
    expect(result.courts[0]?.egressHost).toBe(compositorTarget.id);
    expect(egress?.state).toBe("HEALTHY");
    expect(egress?.evidence.host).toBe(compositorTarget.id);
  });
});

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
    version: 1,
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
