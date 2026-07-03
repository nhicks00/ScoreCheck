import { describe, expect, it } from "vitest";
import { scoreForCurrentMatch } from "../lib/scoreState";

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
});
