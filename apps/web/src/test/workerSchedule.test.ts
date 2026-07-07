import { describe, expect, it } from "vitest";
import { coverageDateKeys, dateKeyInTimeZone } from "../lib/workerSchedule";

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
});
