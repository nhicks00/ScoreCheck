import { describe, expect, it } from "vitest";
import { completeSet, defaultBeachFormat, emptyScoreState, forceCompleteMatch, forceCompleteSet, scorePoint, validateManualCorrection } from "../lib/scoringRules";

describe("scoring rules explicit set controls", () => {
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

  it("saves an arbitrary non-tied set and advances to the next set", () => {
    const state = {
      ...emptyScoreState(),
      status: "In Progress" as const,
      teamAScore: 8,
      teamBScore: 6
    };

    const next = forceCompleteSet(state, defaultBeachFormat());

    expect(next.status).toBe("In Progress");
    expect(next.currentSet).toBe(2);
    expect(next.teamAScore).toBe(0);
    expect(next.teamBScore).toBe(0);
    expect(next.teamASets).toBe(1);
    expect(next.setScores).toEqual([{ setNumber: 1, teamAScore: 8, teamBScore: 6, isComplete: true }]);
  });

  it("can finish a one-set match even when the default format is best of three", () => {
    const state = {
      ...emptyScoreState(),
      status: "In Progress" as const,
      teamAScore: 28,
      teamBScore: 0
    };

    const next = forceCompleteMatch(state, defaultBeachFormat());

    expect(next.status).toBe("Final");
    expect(next.currentSet).toBe(1);
    expect(next.teamAScore).toBe(28);
    expect(next.teamBScore).toBe(0);
    expect(next.teamASets).toBe(1);
    expect(next.teamBSets).toBe(0);
    expect(next.setScores).toEqual([{ setNumber: 1, teamAScore: 28, teamBScore: 0, isComplete: true }]);
  });

  it("does not save a tied set as complete", () => {
    const state = {
      ...emptyScoreState(),
      status: "In Progress" as const,
      teamAScore: 10,
      teamBScore: 10
    };

    expect(() => forceCompleteSet(state, defaultBeachFormat())).toThrow("non-tied score");
  });

  it("rejects impossible manual corrections", () => {
    expect(() => validateManualCorrection({ teamASets: 2, teamBSets: 2 })).toThrow();
  });
});
