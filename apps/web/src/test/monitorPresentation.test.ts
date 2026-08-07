import { describe, expect, it } from "vitest";
import { deriveRawCameraState, isCheckpointEventOperational, isMonitorSnapshotCurrent, isTelemetryCurrent, unavailableState } from "../lib/monitorPresentation";
import type { MonitorCourt, MonitorMediaPath, MonitorSnapshotEnvelope } from "../lib/monitoringTypes";

function envelope(source: MonitorSnapshotEnvelope["source"], generatedAt: string): MonitorSnapshotEnvelope {
  return {
    source,
    fetchedAt: "2026-08-05T12:00:00.000Z",
    monitorError: null,
    snapshot: { generatedAt } as MonitorSnapshotEnvelope["snapshot"]
  };
}

describe("monitor presentation freshness", () => {
  it("never presents a durable checkpoint as current telemetry", () => {
    expect(isMonitorSnapshotCurrent(envelope("checkpoint", "2026-08-05T12:00:00.000Z"), Date.parse("2026-08-05T12:00:01.000Z"))).toBe(false);
  });

  it("keeps a live snapshot current across the fifteen-second collector cadence", () => {
    const current = envelope("live", "2026-08-05T12:00:00.000Z");
    expect(isMonitorSnapshotCurrent(current, Date.parse("2026-08-05T12:00:30.000Z"))).toBe(true);
    expect(isMonitorSnapshotCurrent(current, Date.parse("2026-08-05T12:00:30.001Z"))).toBe(false);
  });

  it("does not label a ready camera healthy when its current delivered bitrate has collapsed", () => {
    expect(deriveRawCameraState(courtWithRaw(rawPath(3_000_000)))).toBe("HEALTHY");
    expect(deriveRawCameraState(courtWithRaw(rawPath(1_500_000)))).toBe("DEGRADED");
    expect(deriveRawCameraState(courtWithRaw(rawPath(50_000)))).toBe("CRITICAL");
  });

  it("does not keep a recovered camera red because its current SRT session has older loss counters", () => {
    expect(deriveRawCameraState(courtWithRaw(rawPath(3_000_000, 20_000, 80_000)))).toBe("HEALTHY");
  });

  it("requires both a current snapshot and a fresh subsystem timestamp", () => {
    const nowMs = Date.parse("2026-08-05T12:00:30.000Z");
    expect(isTelemetryCurrent(true, "2026-08-05T12:00:00.000Z", nowMs, 30_000)).toBe(true);
    expect(isTelemetryCurrent(false, "2026-08-05T12:00:30.000Z", nowMs, 30_000)).toBe(false);
    expect(isTelemetryCurrent(true, null, nowMs, 30_000)).toBe(false);
  });

  it("labels unavailable expected-off equipment as off and required equipment as unknown", () => {
    expect(unavailableState(true)).toBe("EXPECTED_OFF");
    expect(unavailableState(false)).toBe("UNKNOWN");
  });

  it("expires a stale active-event record outside its operating day", () => {
    const event = { id: "event", name: "Dry run", status: "active", eventDate: "2026-07-27" };
    expect(isCheckpointEventOperational(event, Date.parse("2026-07-27T18:00:00.000Z"))).toBe(true);
    expect(isCheckpointEventOperational(event, Date.parse("2026-07-28T18:00:00.000Z"))).toBe(true);
    expect(isCheckpointEventOperational(event, Date.parse("2026-08-05T18:00:00.000Z"))).toBe(false);
  });
});

function rawPath(inboundBitrateBps: number, packetsLost = 0, packetsReceived = 1_000): MonitorMediaPath {
  return {
    name: "court1_raw",
    courtNumber: 1,
    branch: "raw",
    ready: true,
    readySince: "2026-08-05T12:00:00.000Z",
    bytesReceived: 1,
    bytesSent: 1,
    inboundBitrateBps,
    frameErrors: 0,
    readerCount: 1,
    sourceProtocol: "SRT",
    sourceMode: "PUSH",
    videoCodec: "H264",
    audioCodec: "AAC",
    videoWidth: 1920,
    videoHeight: 1080,
    videoProfile: "High",
    audioSampleRateHz: 48_000,
    audioChannelCount: 2,
    transport: {
      rttMs: 50,
      packetsReceived,
      packetsLost,
      packetsRetransmitted: 0,
      packetsDropped: 0,
      receiveRateBps: 3_000_000,
      receiveBufferMs: 100,
      configuredLatencyMs: 2_500
    }
  };
}

function courtWithRaw(raw: MonitorMediaPath): MonitorCourt {
  return {
    courtNumber: 1,
    stages: [{ stage: "RAW_INGEST", state: "HEALTHY" }],
    paths: { raw }
  } as MonitorCourt;
}
