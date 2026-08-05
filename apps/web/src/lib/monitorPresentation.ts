import type { MonitorCourt, MonitorHealthState, MonitorSnapshot, MonitorSnapshotEnvelope } from "./monitoringTypes";

export const MONITOR_SNAPSHOT_FRESH_MS = 15_000;

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
