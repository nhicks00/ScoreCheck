import { describe, expect, it } from "vitest";
import {
  coerceOverlayState,
  completedSetScores,
  displayOverlayName,
  overlayPhaseText,
  scorebugDisplayScores
} from "../lib/overlayState";

describe("overlayState", () => {
  it("normalizes viewer-facing placeholder team names", () => {
    expect(displayOverlayName("Team A")).toBe("TBD");
    expect(displayOverlayName("Team on left")).toBe("TBD");
    expect(displayOverlayName("  ")).toBe("TBD");
  });

  it("shortens long pair names for a fixed broadcast scorebug", () => {
    expect(displayOverlayName("Maximilian Alexander Montgomery / Bartholomew Theodore Kensington"))
      .toBe("M. A. Montgomery / B. T. Kensington");
    expect(displayOverlayName("Winner of Match 24 / Alexandria Montgomery")).toBe("M24 Winner / A. Montgomery");
  });

  it("coerces malformed payloads into a renderable overlay state", () => {
    const state = coerceOverlayState({
      courtNumber: "0",
      layout: "sideways",
      phase: "BROKEN",
      match: { teamA: { name: "Team on right" }, teamB: { name: "Noah Franklin / Tj Huson" } },
      score: { teamAScore: "102", teamBScore: "8", currentSet: "0", setScores: "bad" },
      health: { stale: true }
    }, 1);

    expect(state.courtNumber).toBe(1);
    expect(state.layout).toBe("bottom-left");
    expect(state.phase).toBe("IDLE");
    expect(state.score.teamAScore).toBe(99);
    expect(state.score.teamBScore).toBe(8);
    expect(state.score.currentSet).toBe(1);
    expect(state.score.setScores).toEqual([]);
    expect(displayOverlayName(state.match.teamA.name)).toBe("TBD");
  });

  it("orders and caps completed set scores for the compact scorebug", () => {
    expect(completedSetScores([
      { setNumber: 3, teamAScore: 15, teamBScore: 12, isComplete: true },
      { setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true },
      { setNumber: 2, teamAScore: 18, teamBScore: 21, isComplete: true },
      { setNumber: 4, teamAScore: 0, teamBScore: 0, isComplete: false }
    ])).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true },
      { setNumber: 2, teamAScore: 18, teamBScore: 21, isComplete: true },
      { setNumber: 3, teamAScore: 15, teamBScore: 12, isComplete: true }
    ]);
  });

  it("hides unused final-set zeroes after a straight-sets final", () => {
    const state = coerceOverlayState({
      phase: "POSTMATCH",
      score: {
        teamAScore: 0,
        teamBScore: 0,
        currentSet: 3,
        teamASets: 0,
        teamBSets: 2,
        setScores: [
          { setNumber: 1, teamAScore: 12, teamBScore: 21, isComplete: true },
          { setNumber: 2, teamAScore: 15, teamBScore: 21, isComplete: true },
          { setNumber: 3, teamAScore: 0, teamBScore: 0, isComplete: true }
        ]
      }
    }, 8);

    expect(state.score.teamAScore).toBe(15);
    expect(state.score.teamBScore).toBe(21);
    expect(state.score.currentSet).toBe(2);
    expect(completedSetScores(state.score.setScores)).toEqual([
      { setNumber: 1, teamAScore: 12, teamBScore: 21, isComplete: true },
      { setNumber: 2, teamAScore: 15, teamBScore: 21, isComplete: true }
    ]);
  });

  it("hides duplicated post-clinch set scores after a straight-sets final", () => {
    const state = coerceOverlayState({
      phase: "POSTMATCH",
      match: {
        format: { bestOf: 3, pointsPerSet: [21, 21, 15], winByTwo: true }
      },
      score: {
        teamAScore: 21,
        teamBScore: 19,
        currentSet: 3,
        teamASets: 3,
        teamBSets: 0,
        setScores: [
          { setNumber: 1, teamAScore: 21, teamBScore: 15, isComplete: true },
          { setNumber: 2, teamAScore: 21, teamBScore: 19, isComplete: true },
          { setNumber: 3, teamAScore: 21, teamBScore: 19, isComplete: true }
        ]
      }
    }, 5);

    expect(state.score.teamAScore).toBe(21);
    expect(state.score.teamBScore).toBe(19);
    expect(state.score.teamASets).toBe(2);
    expect(state.score.teamBSets).toBe(0);
    expect(state.score.currentSet).toBe(2);
    expect(completedSetScores(state.score.setScores)).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 15, isComplete: true },
      { setNumber: 2, teamAScore: 21, teamBScore: 19, isComplete: true }
    ]);
  });

  it("renders a straight-sets final without duplicating the clinching set column", () => {
    const state = coerceOverlayState({
      phase: "POSTMATCH",
      score: {
        teamAScore: 12,
        teamBScore: 21,
        currentSet: 2,
        teamASets: 0,
        teamBSets: 2,
        setScores: [
          { setNumber: 1, teamAScore: 19, teamBScore: 21, isComplete: true },
          { setNumber: 2, teamAScore: 12, teamBScore: 21, isComplete: true }
        ]
      }
    }, 4);

    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 12,
      teamBScore: 21,
      teamASetScores: [19],
      teamBSetScores: [21]
    });
  });

  it("renders a three-set final without adding a fourth duplicate score column", () => {
    const state = coerceOverlayState({
      phase: "POSTMATCH",
      score: {
        teamAScore: 12,
        teamBScore: 15,
        currentSet: 3,
        teamASets: 1,
        teamBSets: 2,
        setScores: [
          { setNumber: 1, teamAScore: 23, teamBScore: 21, isComplete: true },
          { setNumber: 2, teamAScore: 16, teamBScore: 21, isComplete: true },
          { setNumber: 3, teamAScore: 12, teamBScore: 15, isComplete: true }
        ]
      }
    }, 1);

    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 12,
      teamBScore: 15,
      teamASetScores: [23, 16],
      teamBSetScores: [21, 21]
    });
  });

  it("keeps a live deciding set at zero-zero visible as the current score", () => {
    const state = coerceOverlayState({
      phase: "LIVE",
      score: {
        teamAScore: 0,
        teamBScore: 0,
        currentSet: 3,
        teamASets: 1,
        teamBSets: 1,
        setScores: [
          { setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true },
          { setNumber: 2, teamAScore: 19, teamBScore: 21, isComplete: true },
          { setNumber: 3, teamAScore: 0, teamBScore: 0, isComplete: false }
        ]
      }
    }, 8);

    expect(state.score.currentSet).toBe(3);
    expect(state.score.teamAScore).toBe(0);
    expect(state.score.teamBScore).toBe(0);
    expect(state.score.setScores).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true },
      { setNumber: 2, teamAScore: 19, teamBScore: 21, isComplete: true },
      { setNumber: 3, teamAScore: 0, teamBScore: 0, isComplete: false }
    ]);
  });

  it("uses current set status for live broadcast labels", () => {
    const state = coerceOverlayState({
      phase: "LIVE",
      score: { currentSet: 2 },
      health: { stale: false }
    }, 4);

    expect(overlayPhaseText(state, true)).toBe("Set 2");
    expect(overlayPhaseText(state, false)).toBe("Stale");
  });
});
