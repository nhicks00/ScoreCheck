import { describe, expect, it } from "vitest";
import { coverageDateKeys, dateKeyInTimeZone, eventCoverageAt, workerHeartbeatStale } from "../lib/workerSchedule";

describe("worker schedule gate", () => {
  it("recognizes VolleyballLife scheduled date strings as coverage dates", () => {
    expect(coverageDateKeys({ event_date: null, settings: null }, ["Fri 2026-07-03", "Sun 2026-07-05"]))
      .toEqual(["2026-07-03", "2026-07-05"]);
  });

  it("uses event_date and explicit coverageDates from event settings", () => {
    expect(coverageDateKeys({
      event_date: "2026-07-04",
      settings: { coverageDates: ["2026-07-05", "Sun 2026-07-06"] }
    }, [])).toEqual(["2026-07-04", "2026-07-05", "2026-07-06"]);
  });

  it("expands explicit coverage date ranges", () => {
    expect(coverageDateKeys({
      event_date: null,
      settings: { coverageStartDate: "2026-07-03", coverageEndDate: "2026-07-05" }
    }, [])).toEqual(["2026-07-03", "2026-07-04", "2026-07-05"]);
  });

  it("falls back to cost-safe no-date coverage when an active event has no dates", () => {
    expect(coverageDateKeys({ event_date: null, settings: {} }, [])).toEqual([]);
  });

  it("computes today's date in the configured tournament timezone", () => {
    expect(dateKeyInTimeZone(new Date("2026-07-04T05:30:00.000Z"), "America/Denver")).toBe("2026-07-03");
    expect(dateKeyInTimeZone(new Date("2026-07-04T07:30:00.000Z"), "America/Denver")).toBe("2026-07-04");
  });

  it("gates each active event using that event's local timezone", () => {
    const now = new Date("2026-07-04T05:30:00.000Z");
    const chicago = eventCoverageAt({
      id: "chicago-event",
      settings: { timezone: "America/Chicago", coverageDate: "2026-07-04" }
    }, [], now, "America/Denver");
    const denver = eventCoverageAt({
      id: "denver-event",
      settings: { timezone: "America/Denver", coverageDate: "2026-07-04" }
    }, [], now, "America/Denver");

    expect(chicago).toMatchObject({ today: "2026-07-04", timezone: "America/Chicago" });
    expect(chicago.dates).toContain(chicago.today);
    expect(denver).toMatchObject({ today: "2026-07-03", timezone: "America/Denver" });
    expect(denver.dates).not.toContain(denver.today);
  });
});

describe("worker heartbeat staleness", () => {
  const now = Date.parse("2026-07-07T12:00:00.000Z");
  const seenAgo = (ms: number) => new Date(now - ms).toISOString();

  it("treats a missing or unparseable heartbeat as stale", () => {
    expect(workerHeartbeatStale(null, now)).toBe(true);
    expect(workerHeartbeatStale({ status: "polling", last_seen_at: null }, now)).toBe(true);
    expect(workerHeartbeatStale({ status: "polling", last_seen_at: "not-a-date" }, now)).toBe(true);
  });

  it("uses the 60s threshold while polling", () => {
    expect(workerHeartbeatStale({ status: "polling", last_seen_at: seenAgo(30_000) }, now)).toBe(false);
    expect(workerHeartbeatStale({ status: "polling", last_seen_at: seenAgo(2 * 60_000) }, now)).toBe(true);
  });

  it("judges a sleeping worker against its declared interval", () => {
    const sleeping = (ageMs: number, nextCheckMs?: unknown) => workerHeartbeatStale({
      status: "sleeping",
      last_seen_at: seenAgo(ageMs),
      metadata: nextCheckMs === undefined ? {} : { nextCheckMs }
    }, now);
    expect(sleeping(10 * 60_000, 15 * 60_000)).toBe(false);
    expect(sleeping(20 * 60_000, 15 * 60_000)).toBe(false);
    expect(sleeping(30 * 60_000, 15 * 60_000)).toBe(true);
    expect(sleeping(14 * 60_000)).toBe(false);
    expect(sleeping(25 * 60_000)).toBe(true);
    expect(sleeping(14 * 60_000, "junk")).toBe(false);
  });

  it("caps a huge declared interval at the six-hour maximum", () => {
    expect(workerHeartbeatStale({
      status: "sleeping",
      last_seen_at: seenAgo(10 * 60 * 60_000),
      metadata: { nextCheckMs: 48 * 60 * 60_000 }
    }, now)).toBe(true);
  });
});
