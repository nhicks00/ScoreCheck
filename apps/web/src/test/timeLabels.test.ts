import { describe, expect, it } from "vitest";
import { formatRelativeTime, isFreshTimestamp, timestampAgeMs } from "../lib/timeLabels";

const now = new Date("2026-07-02T18:00:00.000Z");

describe("time labels", () => {
  it("uses explicit minute and hour labels instead of ambiguous m/mo abbreviations", () => {
    expect(formatRelativeTime("2026-07-02T17:58:00.000Z", { now })).toBe("2 min ago");
    expect(formatRelativeTime("2026-07-02T16:18:00.000Z", { now })).toBe("2 hr ago");
  });

  it("falls back to absolute dates for old records", () => {
    expect(formatRelativeTime("2026-06-01T12:30:00.000Z", { now, timeZone: "UTC" })).toBe("Jun 1, 12:30 PM");
    expect(formatRelativeTime("2025-06-01T12:30:00.000Z", { now, timeZone: "UTC" })).toBe("Jun 1, 2025, 12:30 PM");
  });

  it("guards against invalid and stale timestamps", () => {
    expect(formatRelativeTime("not-a-date", { now })).toBe("unknown");
    expect(timestampAgeMs("2026-07-02T17:59:30.000Z", now)).toBe(30_000);
    expect(isFreshTimestamp("2026-07-02T17:59:30.000Z", 60_000, now)).toBe(true);
    expect(isFreshTimestamp("2026-07-02T17:58:30.000Z", 60_000, now)).toBe(false);
  });
});
