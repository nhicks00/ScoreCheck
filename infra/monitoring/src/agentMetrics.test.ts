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

  it("exports bounded source transport metrics without identity labels", async () => {
    const metrics = new AgentMetrics();
    const snapshot = compositorSnapshot({ idle: true, canAcceptRequest: true });
    snapshot.role = "mediamtx";
    snapshot.assignedCourts = [];
    snapshot.mediaPaths = [{
      name: "court3_raw",
      courtNumber: 3,
      branch: "raw",
      ready: true,
      readySince: "2026-07-12T18:00:00.000Z",
      bytesReceived: 12_000_000,
      bytesSent: 0,
      inboundBitrateBps: 3_250_000,
      frameErrors: 0,
      readerCount: 0,
      sourceProtocol: "SRT",
      sourceMode: "PUSH",
      videoCodec: "H265",
      audioCodec: "AAC",
      videoWidth: 1920,
      videoHeight: 1080,
      videoProfile: "Main",
      audioSampleRateHz: 48_000,
      audioChannelCount: 2,
      transport: {
        rttMs: 138,
        packetsReceived: 20_000,
        packetsLost: 40,
        packetsRetransmitted: 120,
        packetsDropped: 3,
        receiveRateBps: 3_250_000,
        receiveBufferMs: 2_610,
        configuredLatencyMs: 2_500
      }
    }];
    metrics.update(snapshot);
    const output = await metrics.registry.metrics();

    expect(output).toContain('scorecheck_media_transport_metrics_available{agent="bvm-compositor-a",court="3",branch="raw",protocol="SRT"} 1');
    expect(output).toContain('scorecheck_media_transport_rtt_ms{agent="bvm-compositor-a",court="3",branch="raw",protocol="SRT"} 138');
    expect(output).toContain('scorecheck_media_transport_packets_lost_total{agent="bvm-compositor-a",court="3",branch="raw",protocol="SRT"} 40');
    expect(output).not.toContain("remoteAddr");
    expect(output).not.toContain("query=");
  });
});

function compositorSnapshot(egress: { idle: boolean; canAcceptRequest: boolean }): AgentSnapshot {
  return {
    version: 2,
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
