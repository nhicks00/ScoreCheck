import { describe, expect, it } from "vitest";
import { isCheckpointEventOperational, isMonitorSnapshotCurrent, isTelemetryCurrent, unavailableState } from "../lib/monitorPresentation";
import type { MonitorSnapshotEnvelope } from "../lib/monitoringTypes";

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

  it("expires a live snapshot after fifteen seconds", () => {
    const current = envelope("live", "2026-08-05T12:00:00.000Z");
    expect(isMonitorSnapshotCurrent(current, Date.parse("2026-08-05T12:00:15.000Z"))).toBe(true);
    expect(isMonitorSnapshotCurrent(current, Date.parse("2026-08-05T12:00:15.001Z"))).toBe(false);
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
