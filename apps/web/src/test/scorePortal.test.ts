import { describe, expect, it } from "vitest";
import { isActivelyPlayingScore, isFinalScoreStatus } from "../lib/scorePortal";

describe("score portal live-match summary", () => {
  it("does not count an assigned pre-match court as live", () => {
    expect(isActivelyPlayingScore({
      status: "Pre-Match",
      teamAScore: 0,
      teamBScore: 0,
      teamASets: 0,
      teamBSets: 0,
      setScores: []
    })).toBe(false);
  });

  it("counts in-progress play even at zero-zero", () => {
    expect(isActivelyPlayingScore({ status: "In Progress", teamAScore: 0, teamBScore: 0 })).toBe(true);
  });

  it("does not count a final result as live", () => {
    expect(isActivelyPlayingScore({ status: "Final", teamAScore: 21, teamBScore: 18 })).toBe(false);
    expect(isFinalScoreStatus("Completed")).toBe(true);
    expect(isFinalScoreStatus("Set Complete")).toBe(false);
  });

  it("falls back to visible score progress when status is unavailable", () => {
    expect(isActivelyPlayingScore({ status: "", teamAScore: 5, teamBScore: 3 })).toBe(true);
  });
});
