import { describe, expect, it } from "vitest";
import { applyManualAction, defaultManualState, formatFromMatch } from "../lib/manualScoring";

describe("manual scoring reducer", () => {
  it("completes a best-of-three beach volleyball match", () => {
    const format = formatFromMatch({ format: { bestOf: 3, pointsPerSet: [21, 21, 15], winByTwo: true, setsToWin: 2 } });
    let state = defaultManualState();
    for (let i = 0; i < 21; i += 1) state = applyManualAction(state, "point-a", format);
    for (let i = 0; i < 19; i += 1) state = applyManualAction(state, "point-b", format);
    expect(state.current_set).toBe(2);
    expect(state.team_a_sets).toBe(1);
    expect(state.team_a_score).toBe(0);

    for (let i = 0; i < 21; i += 1) state = applyManualAction(state, "point-a", format);
    for (let i = 0; i < 12; i += 1) state = applyManualAction(state, "point-b", format);
    expect(state.status).toBe("Final");
    expect(state.team_a_sets).toBe(2);
  });

  it("requires win by two when no cap is configured", () => {
    const format = formatFromMatch({ format: { bestOf: 1, pointsPerSet: [21], winByTwo: true, setsToWin: 1 } });
    let state = defaultManualState();
    for (let i = 0; i < 20; i += 1) {
      state = applyManualAction(state, "point-a", format);
      state = applyManualAction(state, "point-b", format);
    }
    state = applyManualAction(state, "point-a", format);
    expect(state.status).toBe("In Progress");
    state = applyManualAction(state, "point-a", format);
    expect(state.status).toBe("Final");
  });

  it("honors a configured one-set target instead of forcing the deciding set to 15", () => {
    const format = formatFromMatch({ format: { bestOf: 1, pointsPerSet: [28], winByTwo: true, setsToWin: 1 } });
    let state = defaultManualState();
    for (let i = 0; i < 13; i += 1) {
      state = applyManualAction(state, "point-a", format);
      state = applyManualAction(state, "point-b", format);
    }
    state = applyManualAction(state, "point-a", format);
    state = applyManualAction(state, "point-a", format);

    expect(state).toMatchObject({ status: "In Progress", team_a_score: 15, team_b_score: 13 });

    for (let i = 0; i < 13; i += 1) state = applyManualAction(state, "point-a", format);
    expect(state).toMatchObject({ status: "Final", team_a_sets: 1 });
    expect(state.set_scores).toEqual([
      { setNumber: 1, teamAScore: 28, teamBScore: 13, isComplete: true }
    ]);
  });

  it("treats null format values as absent rather than numeric zero", () => {
    expect(formatFromMatch({ format: { bestOf: null, cap: null } })).toMatchObject({
      bestOf: 3,
      setsToWin: 2,
      cap: null
    });
  });
});
