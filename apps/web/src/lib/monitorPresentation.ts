import type { MonitorCourt, MonitorHealthState, MonitorMediaPath, MonitorSnapshot, MonitorSnapshotEnvelope } from "./monitoringTypes";

export const MONITOR_SNAPSHOT_FRESH_MS = 30_000;

const HEALTH_RANK: Record<MonitorHealthState, number> = {
  CRITICAL: 9,
  UNKNOWN: 8,
  DEGRADED: 7,
  RECOVERING: 6,
  STARTING: 5,
  HEALTHY: 4,
  MAINTENANCE: 3,
  EXPECTED_OFF: 2,
  NOT_APPLICABLE: 1
};

export function isMonitorSnapshotCurrent(envelope: MonitorSnapshotEnvelope, nowMs: number): boolean {
  return envelope.source === "live"
    && isTelemetryCurrent(true, envelope.snapshot.generatedAt, nowMs, MONITOR_SNAPSHOT_FRESH_MS);
}

export function isTelemetryCurrent(snapshotCurrent: boolean, sampledAt: string | null, nowMs: number, maximumAgeMs: number): boolean {
  if (!snapshotCurrent || !sampledAt) return false;
  const sampledAtMs = Date.parse(sampledAt);
  return Number.isFinite(sampledAtMs) && nowMs >= sampledAtMs && nowMs - sampledAtMs <= maximumAgeMs;
}

export function isCourtExpectedOff(court: MonitorCourt): boolean {
  return court.expectation.mediaExpectation === "OFF"
    && court.expectation.broadcastExpectation === "OFF"
    && court.expectation.commentaryExpectation === "NONE"
    && court.expectation.scoringExpectation === "NONE";
}

export function deriveRawCameraState(court: MonitorCourt): MonitorHealthState {
  const stageState = court.stages.find((stage) => stage.stage === "RAW_INGEST")?.state ?? "UNKNOWN";
  const transportState = liveTransportState(court.paths.raw);
  return HEALTH_RANK[transportState] > HEALTH_RANK[stageState] ? transportState : stageState;
}

export function unavailableState(expectedOff: boolean): MonitorHealthState {
  return expectedOff ? "EXPECTED_OFF" : "UNKNOWN";
}

export function isCheckpointEventOperational(event: MonitorSnapshot["event"], nowMs: number): boolean {
  if (!event || event.status.toLowerCase() !== "active") return false;
  if (!event.eventDate) return true;
  const eventDay = Date.parse(`${event.eventDate}T12:00:00.000Z`);
  const currentDay = Date.parse(`${dateInChicago(nowMs)}T12:00:00.000Z`);
  return Number.isFinite(eventDay) && Math.abs(eventDay - currentDay) <= 86_400_000;
}

function dateInChicago(nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(nowMs);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function liveTransportState(path: MonitorMediaPath | undefined): MonitorHealthState {
  if (!path?.ready) return "NOT_APPLICABLE";
  if (path.frameErrors > 0) return "DEGRADED";
  if (path.inboundBitrateBps == null) return "NOT_APPLICABLE";
  if (path.inboundBitrateBps < 500_000) return "CRITICAL";
  if (path.inboundBitrateBps < 2_000_000) return "DEGRADED";
  return "NOT_APPLICABLE";
}
