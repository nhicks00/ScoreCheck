import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

type Row = Record<string, unknown>;

const harness = vi.hoisted(() => {
  const writes: Array<{ table: string; op: "insert" | "update" | "upsert"; payload: Row }> = [];
  let idCounter = 0;
  const fixtures: Record<string, Row | null> = {
    events: {
      id: "event-1",
      slug: "avp-denver",
      name: "AVP Denver Open",
      status: "active",
      is_active: true,
      settings: {}
    },
    courts: {
      id: "court-1",
      event_id: "event-1",
      court_number: 1,
      display_name: "Center Court",
      current_match_id: "match-1",
      status: "waiting",
      mode: "hybrid",
      frozen: false,
      scoring_open: true,
      matches: null,
      score_states: []
    }
  };

  function builderFor(table: string) {
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Row = {};
    const rowResult = () => {
      if (op === "select") return fixtures[table] ?? null;
      idCounter += 1;
      return { id: `${table}-${idCounter}`, ...payload };
    };
    const builder: Row = {};
    for (const method of ["select", "eq", "in", "lt", "gt", "not", "is", "order", "limit"]) {
      builder[method] = () => builder;
    }
    for (const write of ["insert", "update", "upsert"] as const) {
      builder[write] = (value: Row) => {
        op = write;
        payload = value;
        writes.push({ table, op: write, payload: value });
        return builder;
      };
    }
    builder.maybeSingle = async () => ({ data: rowResult(), error: null });
    builder.single = async () => ({ data: rowResult(), error: null });
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: op === "select" ? [] : rowResult(), error: null, count: 0 }).then(resolve);
    return builder;
  }

  return {
    writes,
    db: { from: (table: string) => builderFor(table) }
  };
});

vi.mock("../lib/supabase", () => ({ supabaseAdmin: () => harness.db }));

import { startClaim } from "../lib/scorerSessions";

function fakeRequest(): NextRequest {
  return {
    url: "http://localhost:3000/api/scoring/claims/start",
    headers: new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.7" })
  } as unknown as NextRequest;
}

describe("instant scoring claims", () => {
  it("creates a claim and immediately returns a scorer session URL", async () => {
    const result = await startClaim({
      req: fakeRequest(),
      eventSlug: "avp-denver",
      courtNumber: 1,
      displayName: "  Mike\nAva's Dad  ",
      watchMode: "courtside"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.role).toBe("active");
    expect(result.sessionUrl).toMatch(/^http:\/\/localhost:3000\/score\/session\/[A-Za-z0-9_-]+$/);

    const claimInsert = harness.writes.find((write) => write.table === "scorer_claims" && write.op === "insert");
    expect(claimInsert?.payload.display_name).toBe("Mike Ava's Dad");
    expect(claimInsert?.payload).not.toHaveProperty("verification_code_hash");
    expect(claimInsert?.payload).not.toHaveProperty("verification_code_label");
    expect(claimInsert?.payload).not.toHaveProperty("claim_status_token_hash");

    const sessionInsert = harness.writes.find((write) => write.table === "scorer_sessions" && write.op === "insert");
    expect(sessionInsert?.payload.role).toBe("active");
    expect(sessionInsert?.payload.watch_mode).toBe("courtside");

    const eventTypes = harness.writes
      .filter((write) => write.table === "scorer_session_events")
      .map((write) => write.payload.type);
    expect(eventTypes).toContain("claim_started");
    expect(eventTypes).toContain("session_assigned");
    expect(eventTypes).not.toContain("claim_verified");
  });
});
