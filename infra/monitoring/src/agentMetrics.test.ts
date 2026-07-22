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
    expect(output).toContain('scorecheck_egress_native_can_accept_request{agent="bvm-compositor-a"} 1');
    expect(output).toContain('scorecheck_egress_active_web_requests{agent="bvm-compositor-a"} 1');
    expect(output).toContain('scorecheck_egress_maximum_web_requests{agent="bvm-compositor-a"} 2');
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

  it("exports host-local camera content without requiring a full host recollection", async () => {
    const metrics = new AgentMetrics();
    const snapshot = compositorSnapshot({ idle: true, canAcceptRequest: true });
    snapshot.contentAnalysis = [{
      courtNumber: 1,
      sourceBranch: "raw",
      state: "ANALYZING",
      sessionStartedAt: "2026-07-12T17:59:00.000Z",
      framesAnalyzed: 61,
      visual: {
        sampledAt: "2026-07-12T17:59:59.500Z",
        meanLuma: 110,
        lumaVariance: 850,
        darkPixelRatio: 0.03,
        frameDifference: 12,
        frozenDurationMs: 16_000,
        blackDurationMs: 0
      },
      audio: {
        sampledAt: "2026-07-12T17:59:59.000Z",
        trackPresent: true,
        rmsDb: -28,
        peakDb: -9,
        clippedSampleRatio: 0.01,
        secondsSinceAudio: 0
      },
      process: { running: true, restartCount: 2, lastExitAt: null }
    }];
    metrics.update(snapshot);
    metrics.updateContentAnalysis(snapshot.agentId, snapshot.assignedCourts, snapshot.contentAnalysis, Date.parse("2026-07-12T18:00:00.000Z"));
    const output = await metrics.registry.metrics();

    expect(output).toContain('scorecheck_camera_content_analyzer_configured{agent="bvm-compositor-a",court="1"} 1');
    expect(output).toContain('scorecheck_camera_content_analyzer_configured{agent="bvm-compositor-a",court="2"} 0');
    expect(output).toContain('scorecheck_camera_content_analyzer_available{agent="bvm-compositor-a",court="1"} 1');
    expect(output).toContain('scorecheck_camera_content_sample_age_seconds{agent="bvm-compositor-a",court="1"} 0.5');
    expect(output).toContain('scorecheck_camera_visual_frozen_duration_seconds{agent="bvm-compositor-a",court="1"} 16');
    expect(output).toContain('scorecheck_camera_audio_rms_db{agent="bvm-compositor-a",court="1"} -28');
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

  it("derives FFmpeg speed from consecutive output timestamps when FFmpeg omits it", async () => {
    const metrics = new AgentMetrics();
    const snapshot = mediamtxSnapshot();

    metrics.update(snapshot);
    let output = await metrics.registry.metrics();
    expect(output).toContain('scorecheck_ffmpeg_speed_available{agent="bvm-preview-01",court="1",branch="preview"} 0');

    snapshot.ffmpegBranches[0] = {
      ...snapshot.ffmpegBranches[0]!,
      sampledAt: "2026-07-12T18:00:05.000Z",
      frame: 450,
      outputTimeMs: 15_000
    };
    metrics.update(snapshot);
    output = await metrics.registry.metrics();
    expect(output).toContain('scorecheck_ffmpeg_speed_ratio{agent="bvm-preview-01",court="1",branch="preview"} 1');
    expect(output).toContain('scorecheck_ffmpeg_speed_available{agent="bvm-preview-01",court="1",branch="preview"} 1');

    metrics.update(snapshot);
    output = await metrics.registry.metrics();
    expect(output).toContain('scorecheck_ffmpeg_speed_ratio{agent="bvm-preview-01",court="1",branch="preview"} 1');
  });

  it("rebases derived FFmpeg speed after a process timestamp reset", async () => {
    const metrics = new AgentMetrics();
    const snapshot = mediamtxSnapshot();
    metrics.update(snapshot);
    snapshot.ffmpegBranches[0] = {
      ...snapshot.ffmpegBranches[0]!,
      sampledAt: "2026-07-12T18:00:05.000Z",
      outputTimeMs: 15_000
    };
    metrics.update(snapshot);
    snapshot.ffmpegBranches[0] = {
      ...snapshot.ffmpegBranches[0]!,
      sampledAt: "2026-07-12T18:00:10.000Z",
      outputTimeMs: 1_000
    };

    metrics.update(snapshot);
    const output = await metrics.registry.metrics();
    expect(output).toContain('scorecheck_ffmpeg_speed_available{agent="bvm-preview-01",court="1",branch="preview"} 0');
    expect(output).toContain('scorecheck_ffmpeg_speed_ratio{agent="bvm-preview-01",court="1",branch="preview"} 0');
  });
});

function mediamtxSnapshot(): AgentSnapshot {
  const snapshot = compositorSnapshot({ idle: true, canAcceptRequest: true });
  snapshot.agentId = "bvm-preview-01";
  snapshot.role = "mediamtx";
  snapshot.assignedCourts = [];
  snapshot.nativeServices = { endpoints: [], livekit: null, egress: null };
  snapshot.ffmpegBranches = [{
    name: "court1_preview",
    courtNumber: 1,
    branch: "preview",
    sampledAt: "2026-07-12T18:00:00.000Z",
    frame: 300,
    framesPerSecond: 30,
    bitrateBps: 2_500_000,
    outputTimeMs: 10_000,
    duplicatedFrames: 0,
    droppedFrames: 0,
    speedRatio: null
  }];
  return snapshot;
}

function compositorSnapshot(egress: { idle: boolean; canAcceptRequest: boolean }): AgentSnapshot {
  return {
    version: 5,
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
    contentAnalysis: [],
    nativeServices: {
      endpoints: [{ service: "egress-metrics", up: true }, { service: "egress-health", up: true }],
      livekit: null,
      egress: {
        ...egress,
        nativeCanAcceptRequest: egress.canAcceptRequest,
        activeWebRequests: egress.idle ? 0 : 1,
        maximumWebRequests: egress.canAcceptRequest && !egress.idle ? 2 : 1,
        cgroupMemoryBytes: 750_000_000,
        cpuLoadRatio: 0.3,
        memoryLoadRatio: 0.2
      }
    }
  };
}
