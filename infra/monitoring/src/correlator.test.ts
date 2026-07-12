import { describe, expect, it } from "vitest";
import type { AgentTarget } from "./config.js";
import type { AgentSnapshot, ControlPlaneSnapshot } from "./contracts.js";
import { buildMonitorSnapshot, type AgentRuntime } from "./correlator.js";

const target: AgentTarget = { id: "preview", role: "mediamtx", url: "http://agent", token: "abcdefghijklmnopqrstuvwxyz" };

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
    generatedAt,
    collectionDurationMs: 1,
    collectionErrors: [],
    host: { uptimeSeconds: 1, load1: 0, memoryTotalBytes: 1, memoryAvailableBytes: 1, diskTotalBytes: 1, diskFreeBytes: 1 },
    services: [],
    mediaPaths: [],
    ffmpegBranches: [],
    nativeServices: { endpoints: [], livekit: null }
  };
}
