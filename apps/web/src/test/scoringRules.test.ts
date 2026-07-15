import { describe, expect, it } from "vitest";
import { completeSet, defaultBeachFormat, emptyScoreState, forceCompleteMatch, forceCompleteSet, formatFromUnknown, removePoint, scorePoint, setTargetForFormat, validateManualCorrection } from "../lib/scoringRules";

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

  it("removes a point explicitly without crossing below zero", () => {
    const live = { ...emptyScoreState(), status: "In Progress" as const, teamAScore: 3, teamBScore: 1 };

    expect(removePoint(live, "A")).toMatchObject({ teamAScore: 2, teamBScore: 1, status: "In Progress" });
    expect(removePoint({ ...live, teamBScore: 0 }, "B")).toMatchObject({ teamAScore: 3, teamBScore: 0 });
  });

  it("rejects corrections whose completed set history and aggregate wins disagree", () => {
    expect(() => validateManualCorrection({
      teamASets: 0,
      teamBSets: 0,
      currentSet: 2,
      status: "In Progress",
      setScores: [{ setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true }]
    })).toThrow("Set counts must match completed set history");
  });

  it("rejects tied completed sets and final states without a match winner", () => {
    expect(() => validateManualCorrection({
      currentSet: 1,
      setScores: [{ setNumber: 1, teamAScore: 10, teamBScore: 10, isComplete: true }]
    })).toThrow("Completed sets need a winner");

    expect(() => validateManualCorrection({ status: "Final", teamAScore: 0, teamBScore: 0 })).toThrow("Final score needs a match winner");
  });

  it("rejects duplicate or out-of-format set history", () => {
    expect(() => validateManualCorrection({
      currentSet: 2,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true },
        { setNumber: 1, teamAScore: 18, teamBScore: 21, isComplete: true }
      ]
    })).toThrow("Set numbers must be unique");

    expect(() => validateManualCorrection({
      currentSet: 1,
      setScores: [{ setNumber: 4, teamAScore: 21, teamBScore: 18, isComplete: true }]
    })).toThrow("Set history is outside the match format");
  });

  it("uses 21 through set four and 15 only for a best-of-five decider", () => {
    const format = formatFromUnknown({ bestOf: 5 });

    expect(format.pointsPerSet).toEqual([21, 21, 21, 21, 15]);
    expect(setTargetForFormat(3, format)).toBe(21);
    expect(setTargetForFormat(5, format)).toBe(15);
  });
});
