import { describe, expect, it } from "vitest";
import {
  drainClaimedCanonicalOutbox,
  finalizeCanonicalOutboxWithRetry,
  nextTrustedRallyNumber,
  nextTrustedScoreChangeAt,
  resolveCourtStatus,
  scoreForCurrentMatch,
  semanticProjectionMetadata,
  structuredValueEqual,
  trustedScoreActionId
} from "../lib/scoreState";

describe("scoreState", () => {
  it("selects the score row for the current match", () => {
    const scores = [
      { match_id: "old-match", team_a_score: 21, team_b_score: 17, updated_at: "2026-07-03T20:00:00Z" },
      { match_id: "current-match", team_a_score: 3, team_b_score: 2, updated_at: "2026-07-03T20:05:00Z" }
    ];

    expect(scoreForCurrentMatch(scores, "current-match")).toMatchObject({
      match_id: "current-match",
      team_a_score: 3,
      team_b_score: 2
    });
  });

  it("does not leak an old score row into a new current match", () => {
    const scores = [
      { match_id: "old-match", team_a_score: 21, team_b_score: 17, updated_at: "2026-07-03T20:00:00Z" }
    ];

    expect(scoreForCurrentMatch(scores, "current-match")).toBeNull();
  });

  it("does not leak the most recent historical score when a court has no current match", () => {
    const scores = [{ match_id: "old-match", team_a_score: 21, updated_at: "2026-07-03T20:00:00Z" }];
    expect(scoreForCurrentMatch(scores, null)).toBeNull();
  });

  it("uses structured equality for json projections regardless of object key order", () => {
    expect(structuredValueEqual(
      { timeouts: { A: 1, B: 0 }, sets: [{ setNumber: 1, complete: true }] },
      { sets: [{ complete: true, setNumber: 1 }], timeouts: { B: 0, A: 1 } }
    )).toBe(true);
  });

  it("builds a stable action id for equivalent structured input", () => {
    const actionId = trustedScoreActionId({ matchId: "m1", score: { a: 1, b: 2 } });
    expect(actionId).toBe(trustedScoreActionId({ score: { b: 2, a: 1 }, matchId: "m1" }));
    expect(actionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("advances the rally once for a score commit and preserves it for metadata-only writes", () => {
    expect(nextTrustedRallyNumber({ current: 37, commandType: "ADD_POINT", visibleScoreChanged: true })).toBe(38);
    expect(nextTrustedRallyNumber({ current: 37, commandType: "ADD_POINT", visibleScoreChanged: false })).toBe(37);
    expect(nextTrustedRallyNumber({ current: 38, commandType: "CORRECT_SCORE", visibleScoreChanged: false })).toBe(38);
    expect(nextTrustedRallyNumber({ current: 38, commandType: "CORRECT_SCORE", visibleScoreChanged: true, explicit: 44 })).toBe(44);
  });

  it("advances last score change time only for a visible change unless explicitly observed", () => {
    const old = "2026-07-03T20:00:00Z";
    const now = "2026-07-03T20:01:00Z";
    expect(nextTrustedScoreChangeAt({ current: old, visibleStateChanged: true, now })).toBe(now);
    expect(nextTrustedScoreChangeAt({ current: old, visibleStateChanged: false, now })).toBe(old);
    expect(nextTrustedScoreChangeAt({ current: old, visibleStateChanged: true, observedAt: "2026-07-03T20:00:45Z", now }))
      .toBe("2026-07-03T20:00:45Z");
    expect(nextTrustedScoreChangeAt({ current: old, visibleStateChanged: false, observedAt: now, now })).toBe(old);
  });

  it("excludes heartbeat-only freshness from canonical no-op comparison", () => {
    const base = {
      source: "api" as const,
      sourceAvailable: true,
      sourcePriority: "primary" as const,
      sourcePendingScores: [],
      stale: false,
      message: null,
      lastScoreChangeAt: "2026-07-03T20:00:00Z"
    };
    expect(semanticProjectionMetadata({ ...base, lastApiPollAt: "2026-07-03T20:00:01Z" }))
      .toEqual(semanticProjectionMetadata({ ...base, lastApiPollAt: "2026-07-03T20:00:09Z" }));
  });

  it("continues a bounded outbox drain after one projection fails and can replay it later", async () => {
    const firstAttempts: string[] = [];
    const first = await drainClaimedCanonicalOutbox([{ id: "failed" }, { id: "published" }], async (item) => {
      firstAttempts.push(item.id);
      if (item.id === "failed") throw new Error("temporary overlay failure");
    });
    expect(firstAttempts).toEqual(["failed", "published"]);
    expect(first).toEqual({ claimed: 2, published: 1, failed: 1, failedIds: ["failed"] });

    const replay = await drainClaimedCanonicalOutbox([{ id: first.failedIds[0] }], async () => undefined);
    expect(replay).toEqual({ claimed: 1, published: 1, failed: 0, failedIds: [] });
  });

  it("rebuilds after a revision race and finalizes a transitioned match without publishing its stale overlay", async () => {
    const prepared = [
      { matchId: "old-match", projectionRevision: 7, overlay: "old-overlay" },
      { matchId: null, projectionRevision: 7, overlay: null }
    ];
    const finalized: string[] = [];

    const result = await finalizeCanonicalOutboxWithRetry({
      prepare: async (attempt) => prepared[attempt - 1],
      finalize: async (projection) => {
        finalized.push(projection.overlay ?? "historical");
        return projection.matchId
          ? { status: "RETRY" as const }
          : { status: "HISTORICAL" as const };
      },
      maxAttempts: 2
    });

    expect(finalized).toEqual(["old-overlay", "historical"]);
    expect(result.attempts).toBe(2);
    expect(result.result.status).toBe("HISTORICAL");
    expect(result.prepared.overlay).toBeNull();
  });

  it("keeps a completed set live without marking the entire court finished", () => {
    expect(resolveCourtStatus("Set Complete", [])).toBe("live");
    expect(resolveCourtStatus("Completed", [])).toBe("finished");
    expect(resolveCourtStatus("Final", [])).toBe("finished");
  });
});
