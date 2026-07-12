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
      version: 1,
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
});
