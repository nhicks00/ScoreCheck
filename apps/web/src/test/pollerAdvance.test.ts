import { describe, expect, it } from "vitest";
import {
  bracketPayloadShowsLiveScoring,
  hasLivePointScoringStarted,
  hasScoreClinchedMatch,
  orderedLaterQueueCandidates,
  resolvePostFinalHoldStart,
  scoreStatePatchMatches,
  shouldWriteWorkerHeartbeat,
  shouldAdvanceFinalMatchOverlay,
  vblBracketFinalVisibleAt
} from "../lib/poller";
import { parseVblPostFinalHoldMs } from "../lib/vblDelay";

describe("poller final-match advancement", () => {
  it("advances immediately when the next queued VBL match starts live scoring", () => {
    expect(shouldAdvanceFinalMatchOverlay({
      finalVisibleAt: "2026-07-04T15:00:00.000Z",
      now: "2026-07-04T15:00:08.000Z",
      nextLiveScoringStarted: true
    })).toBe(true);
  });

  it("keeps a completed match on screen during the three-minute post-final hold", () => {
    expect(shouldAdvanceFinalMatchOverlay({
      finalVisibleAt: "2026-07-04T15:00:00.000Z",
      now: "2026-07-04T15:02:59.999Z",
      nextLiveScoringStarted: false
    })).toBe(false);
  });

  it("advances to the next queued teams after three minutes even without next-match live scoring", () => {
    expect(shouldAdvanceFinalMatchOverlay({
      finalVisibleAt: "2026-07-04T15:00:00.000Z",
      now: "2026-07-04T15:03:00.000Z",
      nextLiveScoringStarted: false
    })).toBe(true);
  });

  it("does not advance from a malformed final timestamp unless next live scoring is active", () => {
    expect(shouldAdvanceFinalMatchOverlay({
      finalVisibleAt: null,
      now: "2026-07-04T15:03:00.000Z",
      nextLiveScoringStarted: false
    })).toBe(false);
  });

  it("requires enough completed set wins before treating a best-of-three match as clinched", () => {
    expect(hasScoreClinchedMatch({
      status: "Final",
      team_a_sets: 0,
      team_b_sets: 2,
      set_scores: [
        { setNumber: 1, teamAScore: 19, teamBScore: 21, isComplete: true },
        { setNumber: 2, teamAScore: 12, teamBScore: 21, isComplete: true }
      ]
    }, {
      format: { bestOf: 3, setsToWin: 2 }
    })).toBe(true);

    expect(hasScoreClinchedMatch({
      status: "Final",
      team_a_sets: 0,
      team_b_sets: 1,
      set_scores: [
        { setNumber: 1, teamAScore: 19, teamBScore: 21, isComplete: true }
      ]
    }, {
      format: { bestOf: 3, setsToWin: 2 }
    })).toBe(false);
  });

  it("supports one-set match formats without forcing best-of-three rules", () => {
    expect(hasScoreClinchedMatch({
      status: "Final",
      team_a_sets: 1,
      team_b_sets: 0,
      set_scores: [
        { setNumber: 1, teamAScore: 28, teamBScore: 20, isComplete: true }
      ]
    }, {
      format: { bestOf: 1, setsToWin: 1 }
    })).toBe(true);
  });

  it("does not treat a loaded 0-0 next match as live scoring for post-final advance", () => {
    expect(hasLivePointScoringStarted({
      status: "In Progress",
      teamAScore: 0,
      teamBScore: 0,
      setScores: []
    })).toBe(false);
  });

  it("treats the first actual next-match point as live scoring for post-final advance", () => {
    expect(hasLivePointScoringStarted({
      status: "In Progress",
      teamAScore: 1,
      teamBScore: 0,
      setScores: [{ setNumber: 1, teamAScore: 1, teamBScore: 0, isComplete: false }]
    })).toBe(true);
  });

  it("considers only later queue positions and checks the nearest later match first", () => {
    const queues = [
      { id: "later-2", queue_position: 40 },
      { id: "earlier", queue_position: 10 },
      { id: "later-1", queue_position: 30 },
      { id: "active", queue_position: 20 }
    ];

    expect(orderedLaterQueueCandidates(queues, 20).map((queue) => queue.id)).toEqual(["later-1", "later-2"]);
    expect(orderedLaterQueueCandidates(queues, null)).toEqual([]);
  });

  it("does not mistake final-only or completed-set data for a later live match", () => {
    expect(hasLivePointScoringStarted({
      status: "Final",
      teamAScore: 21,
      teamBScore: 18,
      setScores: [{ setNumber: 2, teamAScore: 21, teamBScore: 18, isComplete: true }]
    })).toBe(false);
    expect(hasLivePointScoringStarted({
      status: "In Progress",
      teamAScore: 0,
      teamBScore: 0,
      setScores: [{ setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true }]
    })).toBe(false);
  });

  it("honors a custom post-final hold duration", () => {
    expect(shouldAdvanceFinalMatchOverlay({
      finalVisibleAt: "2026-07-04T15:00:00.000Z",
      now: "2026-07-04T15:00:30.000Z",
      nextLiveScoringStarted: false,
      holdMs: 30_000
    })).toBe(true);

    expect(shouldAdvanceFinalMatchOverlay({
      finalVisibleAt: "2026-07-04T15:00:00.000Z",
      now: "2026-07-04T15:00:29.999Z",
      nextLiveScoringStarted: false,
      holdMs: 30_000
    })).toBe(false);
  });

  it("falls back to the first-observed final time so the hold always expires", () => {
    expect(resolvePostFinalHoldStart({
      finalVisibleAt: "2026-07-04T15:00:00.000Z",
      firstObservedAt: "2026-07-04T15:01:00.000Z",
      now: "2026-07-04T15:02:00.000Z"
    })).toBe("2026-07-04T15:00:00.000Z");

    expect(resolvePostFinalHoldStart({
      finalVisibleAt: null,
      firstObservedAt: "2026-07-04T15:01:00.000Z",
      now: "2026-07-04T15:02:00.000Z"
    })).toBe("2026-07-04T15:01:00.000Z");

    expect(resolvePostFinalHoldStart({
      finalVisibleAt: "not-a-timestamp",
      firstObservedAt: null,
      now: "2026-07-04T15:02:00.000Z"
    })).toBe("2026-07-04T15:02:00.000Z");
  });

  it("treats nonzero bracket game points on the next match as a live-scoring signal", () => {
    expect(bracketPayloadShowsLiveScoring({
      games: [{ number: 1, home: 5, away: 3 }]
    })).toBe(true);

    expect(bracketPayloadShowsLiveScoring({
      games: [{ number: 1, home: "7", away: "0" }]
    })).toBe(true);

    expect(bracketPayloadShowsLiveScoring({
      games: [{ number: 1, home: 0, away: 0 }, { number: 2, home: 0, away: 0 }]
    })).toBe(false);

    expect(bracketPayloadShowsLiveScoring({ games: [] })).toBe(false);
    expect(bracketPayloadShowsLiveScoring({ games: [null, "bad", 4] })).toBe(false);
    expect(bracketPayloadShowsLiveScoring(null)).toBe(false);
    expect(bracketPayloadShowsLiveScoring({})).toBe(false);
  });

  it("validates the VBL_POST_FINAL_HOLD_MS override and falls back to three minutes", () => {
    expect(parseVblPostFinalHoldMs(undefined)).toBe(180_000);
    expect(parseVblPostFinalHoldMs("")).toBe(180_000);
    expect(parseVblPostFinalHoldMs("  ")).toBe(180_000);
    expect(parseVblPostFinalHoldMs("not-a-number")).toBe(180_000);
    expect(parseVblPostFinalHoldMs("-1")).toBe(180_000);
    expect(parseVblPostFinalHoldMs("3600001")).toBe(180_000);
    expect(parseVblPostFinalHoldMs("0")).toBe(0);
    expect(parseVblPostFinalHoldMs("240000")).toBe(240_000);
    expect(parseVblPostFinalHoldMs("90000.7")).toBe(90_000);
  });

  it("uses the latest played VBL game timestamp as the final-visible timestamp", () => {
    expect(vblBracketFinalVisibleAt({
      source_payload: {
        games: [
          { number: 1, home: 21, away: 14, dtModified: "1783193168915" },
          { number: 2, home: 21, away: 13, dtModified: "1783193172000" },
          { number: 3, home: 0, away: 0, dtModified: "1783199999999" }
        ]
      }
    }, "2026-07-04T19:30:00.000Z")).toBe("2026-07-04T19:26:12.000Z");
  });

  it("suppresses timestamp-only score-state writes while preserving semantic transitions", () => {
    const current = {
      court_id: "court-1",
      match_id: "match-1",
      team_a_score: 4,
      team_b_score: 3,
      team_a_sets: 0,
      team_b_sets: 0,
      current_set: 1,
      set_scores: [],
      serving_team: "A",
      status: "In Progress",
      source: "api" as const,
      source_available: true,
      source_priority: "primary" as const,
      source_pending_scores: [],
      stale: false,
      message: null,
      last_api_poll_at: "2026-07-13T15:00:00.000Z",
      last_score_change_at: "2026-07-13T15:00:00.000Z",
      updated_at: "2026-07-13T15:00:00.000Z"
    };

    expect(scoreStatePatchMatches(current, {
      match_id: "match-1",
      source: "api",
      source_available: true,
      source_priority: "primary",
      source_pending_scores: [],
      stale: false,
      message: null
    })).toBe(true);
    expect(scoreStatePatchMatches(current, { team_a_score: 5 })).toBe(false);
    expect(scoreStatePatchMatches(current, { stale: true, source_available: false })).toBe(false);
  });

  it("treats JSONB object key reordering as equal without hiding score changes", () => {
    const current = {
      court_id: "court-1",
      match_id: "match-1",
      team_a_score: 21,
      team_b_score: 14,
      team_a_sets: 2,
      team_b_sets: 0,
      current_set: 2,
      set_scores: [
        { setNumber: 1, isComplete: true, teamAScore: 21, teamBScore: 11 },
        { setNumber: 2, isComplete: true, teamAScore: 21, teamBScore: 14 }
      ],
      serving_team: null,
      status: "Final",
      source: "api" as const,
      source_available: true,
      source_priority: "primary" as const,
      source_pending_scores: [],
      stale: false,
      message: null,
      last_api_poll_at: "2026-07-13T15:00:00.000Z",
      last_score_change_at: "2026-07-13T15:00:00.000Z",
      updated_at: "2026-07-13T15:00:00.000Z"
    };

    expect(scoreStatePatchMatches(current, {
      set_scores: [
        { teamBScore: 11, teamAScore: 21, isComplete: true, setNumber: 1 },
        { teamBScore: 14, teamAScore: 21, isComplete: true, setNumber: 2 }
      ]
    })).toBe(true);
    expect(scoreStatePatchMatches(current, {
      set_scores: [
        { teamBScore: 11, teamAScore: 21, isComplete: true, setNumber: 1 },
        { teamBScore: 15, teamAScore: 21, isComplete: true, setNumber: 2 }
      ]
    })).toBe(false);
  });

  it("persists worker status transitions immediately while bounding same-state heartbeats", () => {
    const previous = { signature: "no-event:starting:", writtenAtMs: 10_000 };

    expect(shouldWriteWorkerHeartbeat(previous, "no-event:sleeping:", 10_001)).toBe(true);
    expect(shouldWriteWorkerHeartbeat(previous, "no-event:starting:", 19_999)).toBe(false);
    expect(shouldWriteWorkerHeartbeat(previous, "no-event:starting:", 20_000)).toBe(true);
    expect(shouldWriteWorkerHeartbeat(previous, "no-event:starting:", 9_999)).toBe(true);
  });
});
