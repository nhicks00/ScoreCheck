import { describe, expect, it } from "vitest";
import type { CompetitionCourtSnapshot, CompetitionMatchSnapshot, CompetitionScoreSnapshot } from "./contracts.js";
import { scoreAlignmentIssueCodes } from "./controlPlane.js";

const match: CompetitionMatchSnapshot = {
  id: "10000000-0000-4000-8000-000000000001",
  matchNumber: "24",
  roundName: "Final",
  scheduledDate: "2026-07-12",
  scheduledTime: "18:00",
  teamA: "Alpha / Bravo",
  teamB: "Charlie / Delta"
};

const score: CompetitionScoreSnapshot = {
  matchId: match.id,
  teamAScore: 12,
  teamBScore: 10,
  teamASets: 0,
  teamBSets: 0,
  currentSet: 1,
  setScores: [],
  status: "live",
  source: "api",
  sourceAvailable: true,
  sourcePriority: "primary",
  stale: false,
  lastApiPollAt: "2026-07-12T18:00:00Z",
  updatedAt: "2026-07-12T18:00:00Z"
};

const overlay: NonNullable<CompetitionCourtSnapshot["overlay"]> = {
  matchId: match.id,
  teamA: match.teamA,
  teamB: match.teamB,
  teamAScore: 12,
  teamBScore: 10,
  teamASets: 0,
  teamBSets: 0,
  currentSet: 1,
  phase: "LIVE",
  stale: false,
  updatedAt: "2026-07-12T18:00:00Z"
};

describe("control-plane score alignment", () => {
  it("accepts aligned live source and overlay state", () => {
    expect(scoreAlignmentIssueCodes({ currentMatchId: match.id, currentMatch: match, score, overlay, scoringExpectation: "LIVE", sourceAgeMs: 1_000 })).toEqual([]);
  });

  it("detects wrong match, team, score, stale source, and 67-67 independently", () => {
    const issues = scoreAlignmentIssueCodes({
      currentMatchId: match.id,
      currentMatch: match,
      score: { ...score, teamAScore: 67, teamBScore: 67, sourceAvailable: false },
      overlay: { ...overlay, matchId: "wrong", teamA: "Wrong Team", teamAScore: 67, teamBScore: 66 },
      scoringExpectation: "LIVE",
      sourceAgeMs: 30_000
    });
    expect(issues).toEqual(expect.arrayContaining([
      "OVERLAY_MATCH_MISMATCH",
      "OVERLAY_TEAM_MISMATCH",
      "OVERLAY_SCORE_MISMATCH",
      "IMPLAUSIBLE_67_67",
      "LIVE_SCORE_SOURCE_UNAVAILABLE",
      "LIVE_SCORE_SOURCE_STALE"
    ]));
  });
});
