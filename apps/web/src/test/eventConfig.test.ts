import { describe, expect, it } from "vitest";
import { selectActiveEvent, type EventRow } from "../lib/eventConfig";

const TODAY = "2026-07-08";

function event(overrides: Partial<EventRow> & { id: string }): EventRow {
  return {
    name: overrides.name ?? overrides.id,
    status: overrides.status ?? "active",
    slug: overrides.slug ?? overrides.id,
    is_active: overrides.is_active ?? false,
    event_date: overrides.event_date ?? null,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    ...overrides
  };
}

describe("selectActiveEvent", () => {
  it("returns null when there are no events", () => {
    expect(selectActiveEvent([], TODAY)).toBeNull();
  });

  it("returns the is_active event — manual control always wins", () => {
    const events = [
      event({ id: "upcoming", status: "active", event_date: "2026-07-20" }),
      event({ id: "chosen", is_active: true, status: "inactive", event_date: "2026-01-01" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("chosen");
  });

  it("honors is_active even when the flagged event is completed (reactivated edge case)", () => {
    const events = [
      event({ id: "scheduled", status: "active", event_date: "2026-07-20" }),
      event({ id: "reactivated", is_active: true, status: "completed", event_date: "2025-05-01" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("reactivated");
  });

  it("prefers an upcoming event over a past one when none is flagged", () => {
    const events = [
      event({ id: "past", status: "active", event_date: "2026-01-01" }),
      event({ id: "upcoming", status: "active", event_date: "2026-07-20" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("upcoming");
  });

  it("treats today as upcoming and picks the nearest upcoming event", () => {
    const events = [
      event({ id: "far", status: "active", event_date: "2026-09-01" }),
      event({ id: "today", status: "active", event_date: TODAY }),
      event({ id: "soon", status: "active", event_date: "2026-07-15" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("today");
  });

  it("excludes completed events even when the completed one is the upcoming option", () => {
    const events = [
      event({ id: "completed-upcoming", status: "completed", event_date: "2026-07-20" }),
      event({ id: "live-past", status: "active", event_date: "2026-02-01" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("live-past");
  });

  it("falls back to the most recent non-completed past event when none is upcoming", () => {
    const events = [
      event({ id: "older", status: "active", event_date: "2026-01-01" }),
      event({ id: "recent", status: "inactive", event_date: "2026-06-01" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("recent");
  });

  it("returns the most recent event when only completed events exist", () => {
    const events = [
      event({ id: "old-final", status: "completed", event_date: "2025-01-01" }),
      event({ id: "recent-final", status: "completed", event_date: "2026-06-01" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("recent-final");
  });

  it("tiebreaks undated non-completed events by newest created_at", () => {
    const events = [
      event({ id: "older", status: "active", event_date: null, created_at: "2026-03-01T00:00:00Z" }),
      event({ id: "newer", status: "active", event_date: null, created_at: "2026-05-01T00:00:00Z" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("newer");
  });

  it("prefers a dated past event over an undated one", () => {
    const events = [
      event({ id: "dated-past", status: "active", event_date: "2026-05-01", created_at: "2026-01-01T00:00:00Z" }),
      event({ id: "undated", status: "active", event_date: null, created_at: "2026-06-01T00:00:00Z" })
    ];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("dated-past");
  });

  it("ignores a missing is_active flag (older DB) and uses date logic", () => {
    const events = [
      { id: "a", name: "A", status: "active", slug: "a", event_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
      { id: "b", name: "B", status: "active", slug: "b", event_date: "2026-07-20", created_at: "2026-02-01T00:00:00Z" }
    ] as EventRow[];
    expect(selectActiveEvent(events, TODAY)?.id).toBe("b");
  });
});
