import { describe, expect, it } from "vitest";
import { hasLivePointScoringStarted, hasScoreClinchedMatch, shouldAdvanceFinalMatchOverlay } from "../lib/poller";

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
});
