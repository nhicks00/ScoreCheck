import { describe, expect, it } from "vitest";
import { eventTimeZone, localScheduleTimestamp } from "../lib/scheduleTime";

describe("event schedule time", () => {
  it("uses the event timezone instead of the deployment default", () => {
    expect(eventTimeZone({ timezone: "America/Chicago" }, "America/Denver")).toBe("America/Chicago");
    expect(eventTimeZone({ timezone: "Not/AZone" }, "America/Denver")).toBe("America/Denver");
  });

  it("converts summer tournament wall time with the correct DST offset", () => {
    const chicago = localScheduleTimestamp("Wed 2026-07-08", "9:30 AM", "America/Chicago");
    const denver = localScheduleTimestamp("Wed 2026-07-08", "9:30 AM", "America/Denver");

    expect(new Date(chicago).toISOString()).toBe("2026-07-08T14:30:00.000Z");
    expect(new Date(denver).toISOString()).toBe("2026-07-08T15:30:00.000Z");
  });

  it("uses standard time in winter rather than a fixed summer offset", () => {
    const chicago = localScheduleTimestamp("2026-01-08", "09:30", "America/Chicago");
    expect(new Date(chicago).toISOString()).toBe("2026-01-08T15:30:00.000Z");
  });

  it("rejects malformed and nonexistent wall-clock values", () => {
    expect(localScheduleTimestamp("2026-02-30", "9:30 AM", "America/Chicago")).toBeNaN();
    expect(localScheduleTimestamp("2026-07-08", "25:00", "America/Chicago")).toBeNaN();
    expect(localScheduleTimestamp("2026-03-08", "2:30 AM", "America/Chicago")).toBeNaN();
  });
});
