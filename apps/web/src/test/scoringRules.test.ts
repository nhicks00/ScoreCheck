import { describe, expect, it } from "vitest";
import { completeSet, defaultBeachFormat, emptyScoreState, scorePoint, validateManualCorrection } from "../lib/scoringRules";

describe("scoringRules", () => {
  it("scores points without auto-completing a set", () => {
    let state = emptyScoreState();
    for (let index = 0; index < 21; index += 1) {
      state = scorePoint(state, "A");
    }
    expect(state.teamAScore).toBe(21);
    expect(state.status).toBe("Set Complete");
    expect(state.teamASets).toBe(0);
  });

  it("completes a set only when the format is satisfied", () => {
    const state = { ...emptyScoreState(), teamAScore: 21, teamBScore: 19, status: "Set Complete" as const };
    const next = completeSet(state, defaultBeachFormat());
    expect(next.teamASets).toBe(1);
    expect(next.currentSet).toBe(2);
    expect(next.teamAScore).toBe(0);
  });

  it("rejects impossible manual corrections", () => {
    expect(() => validateManualCorrection({ teamASets: 2, teamBSets: 2 })).toThrow();
  });
});
