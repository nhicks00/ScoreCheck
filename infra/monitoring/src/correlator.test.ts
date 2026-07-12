import { describe, expect, it } from "vitest";
import type { AgentTarget } from "./config.js";
import type { AgentSnapshot } from "./contracts.js";
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

  it("reports healthy observed paths and unknown unobserved stages", () => {
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
    expect(result.courts[0]?.stages.find((stage) => stage.stage === "PREVIEW")?.state).toBe("UNKNOWN");
  });
});

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
    mediaPaths: []
  };
}
