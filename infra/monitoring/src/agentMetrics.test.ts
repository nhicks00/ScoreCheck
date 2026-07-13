import { describe, expect, it } from "vitest";
import type { AgentSnapshot } from "./contracts.js";
import { AgentMetrics } from "./agentMetrics.js";

describe("agent metrics", () => {
  it("exports compositor ownership and keeps busy separate from health", async () => {
    const metrics = new AgentMetrics();
    metrics.update(compositorSnapshot({ idle: false, canAcceptRequest: true }));
    const output = await metrics.registry.metrics();

    expect(output).toContain('scorecheck_compositor_court_assignment{agent="bvm-compositor-a",court="1"} 1');
    expect(output).toContain('scorecheck_compositor_court_assignment{agent="bvm-compositor-a",court="2"} 1');
    expect(output).toContain('scorecheck_egress_idle{agent="bvm-compositor-a"} 0');
    expect(output).toContain('scorecheck_egress_metrics_valid{agent="bvm-compositor-a"} 1');
    expect(output).toContain('scorecheck_egress_can_accept_request{agent="bvm-compositor-a"} 1');
    expect(output).not.toContain("scorecheck_egress_available");
  });

  it("marks missing required Egress metrics invalid", async () => {
    const metrics = new AgentMetrics();
    const snapshot = compositorSnapshot({ idle: true, canAcceptRequest: true });
    snapshot.nativeServices.egress = null;
    metrics.update(snapshot);
    const output = await metrics.registry.metrics();

    expect(output).toContain('scorecheck_egress_metrics_valid{agent="bvm-compositor-a"} 0');
    expect(output).not.toContain('scorecheck_egress_idle{agent="bvm-compositor-a"}');
  });
});

function compositorSnapshot(egress: { idle: boolean; canAcceptRequest: boolean }): AgentSnapshot {
  return {
    version: 1,
    agentId: "bvm-compositor-a",
    role: "compositor",
    assignedCourts: [1, 2],
    generatedAt: "2026-07-12T18:00:00.000Z",
    collectionDurationMs: 5,
    collectionErrors: [],
    host: {
      uptimeSeconds: 1_000,
      load1: 0.2,
      memoryTotalBytes: 8_000_000_000,
      memoryAvailableBytes: 6_000_000_000,
      diskTotalBytes: 80_000_000_000,
      diskFreeBytes: 60_000_000_000
    },
    services: [],
    mediaPaths: [],
    ffmpegBranches: [],
    nativeServices: {
      endpoints: [{ service: "egress-metrics", up: true }, { service: "egress-health", up: true }],
      livekit: null,
      egress: {
        ...egress,
        cgroupMemoryBytes: 750_000_000,
        cpuLoadRatio: 0.3,
        memoryLoadRatio: 0.2
      }
    }
  };
}
