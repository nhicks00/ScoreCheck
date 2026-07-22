import { describe, expect, it } from "vitest";
import { agentSnapshotSchema, incidentFingerprint, worstHealthState } from "./contracts.js";

describe("monitoring contract", () => {
  it("treats unknown as requiring more attention than healthy", () => {
    expect(worstHealthState(["HEALTHY", "UNKNOWN"])).toBe("UNKNOWN");
    expect(worstHealthState(["UNKNOWN", "CRITICAL"])).toBe("CRITICAL");
  });

  it("creates stable fingerprints without timestamps", () => {
    expect(incidentFingerprint({
      eventId: "Event 1",
      rootDependency: "Compositor A",
      stage: "PROGRAM_BROWSER",
      courtOrHost: "Court 1",
      issueCode: "Frames Stalled"
    })).toBe("event-1|compositor-a|program_browser|court-1|frames-stalled");
  });

  it("rejects unbounded service names", () => {
    expect(() => agentSnapshotSchema.parse({
      version: 5,
      agentId: "agent-1",
      role: "mediamtx",
      generatedAt: new Date().toISOString(),
      collectionDurationMs: 1,
      collectionErrors: [],
      host: { uptimeSeconds: 1, load1: 0, memoryTotalBytes: 1, memoryAvailableBytes: 1, diskTotalBytes: 1, diskFreeBytes: 1 },
      services: [{ name: "bad service name", running: true, healthy: true, restartCount: 0, oomKilled: false, memoryUsageBytes: null, memoryLimitBytes: null, cpuRatio: null }],
      mediaPaths: []
    })).toThrow();
  });

  it("hard-cuts Egress activity from available to idle", () => {
    const snapshot = {
      version: 5,
      agentId: "compositor-a",
      role: "compositor",
      assignedCourts: [1, 2],
      generatedAt: new Date().toISOString(),
      collectionDurationMs: 1,
      collectionErrors: [],
      host: { uptimeSeconds: 1, load1: 0, memoryTotalBytes: 1, memoryAvailableBytes: 1, diskTotalBytes: 1, diskFreeBytes: 1 },
      services: [],
      mediaPaths: [],
      ffmpegBranches: [],
      nativeServices: {
        endpoints: [{ service: "egress-metrics", up: true }, { service: "egress-health", up: true }],
        livekit: null,
        egress: { idle: false, canAcceptRequest: true, nativeCanAcceptRequest: true, activeWebRequests: 1, maximumWebRequests: 2, cgroupMemoryBytes: 1, cpuLoadRatio: 0.1, memoryLoadRatio: 0.1 }
      }
    };
    expect(agentSnapshotSchema.parse(snapshot).nativeServices.egress?.idle).toBe(false);
    expect(() => agentSnapshotSchema.parse({ ...snapshot, version: 1 })).toThrow();
    expect(() => agentSnapshotSchema.parse({
      ...snapshot,
      nativeServices: {
        ...snapshot.nativeServices,
        egress: { available: false, canAcceptRequest: true, nativeCanAcceptRequest: true, activeWebRequests: 1, maximumWebRequests: 2, cgroupMemoryBytes: 1, cpuLoadRatio: 0.1, memoryLoadRatio: 0.1 }
      }
    })).toThrow();
  });
});
