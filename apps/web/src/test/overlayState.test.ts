import { describe, expect, it } from "vitest";
import {
  coerceOverlayState,
  completedSetScores,
  displayOverlayName,
  overlayPhaseText,
  overlayStateUpdatedAtMs,
  scorebugDisplayScores,
  shouldApplyOverlayUpdate
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
    expect(state.layout).toBe("top-left");
    expect(state.phase).toBe("IDLE");
    expect(state.score.teamAScore).toBe(99);
    expect(state.score.teamBScore).toBe(8);
    expect(state.score.currentSet).toBe(1);
    expect(state.score.setScores).toEqual([]);
    expect(displayOverlayName(state.match.teamA.name)).toBe("TBD");
  });

  it("uses format defaults when nullable database values are absent", () => {
    const state = coerceOverlayState({
      match: { format: { bestOf: null, setsToWin: null, pointsPerSet: null } }
    }, 1);

    expect(state.match.format).toMatchObject({
      bestOf: 3,
      setsToWin: 2,
      pointsPerSet: [21, 21, 15]
    });
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
      teamASetScores: [19, 12],
      teamBSetScores: [21, 21]
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
      teamASetScores: [23, 16, 12],
      teamBSetScores: [21, 21, 15]
    });
  });

  it("collapses a clinched live-phase score without duplicating the deciding set", () => {
    const state = coerceOverlayState({
      phase: "LIVE",
      score: {
        teamAScore: 12,
        teamBScore: 15,
        currentSet: 3,
        teamASets: 1,
        teamBSets: 2,
        setScores: [
          { setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true },
          { setNumber: 2, teamAScore: 14, teamBScore: 21, isComplete: true },
          { setNumber: 3, teamAScore: 12, teamBScore: 15, isComplete: true }
        ]
      }
    }, 6);

    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 12,
      teamBScore: 15,
      teamASetScores: [21, 14, 12],
      teamBSetScores: [18, 21, 15]
    });
    expect(overlayPhaseText(state, true)).toBe("Final");
  });

  it("deduplicates repeated completed set records before scorebug rendering", () => {
    const state = coerceOverlayState({
      phase: "POSTMATCH",
      score: {
        teamAScore: 12,
        teamBScore: 15,
        currentSet: 3,
        teamASets: 1,
        teamBSets: 2,
        setScores: [
          { setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true },
          { setNumber: 2, teamAScore: 14, teamBScore: 21, isComplete: true },
          { setNumber: 3, teamAScore: 12, teamBScore: 15, isComplete: true },
          { setNumber: 3, teamAScore: 12, teamBScore: 15, isComplete: true }
        ]
      }
    }, 6);

    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 12,
      teamBScore: 15,
      teamASetScores: [21, 14, 12],
      teamBSetScores: [18, 21, 15]
    });
  });

  it("prefers the latest data when repeated completed set records disagree", () => {
    const state = coerceOverlayState({
      phase: "LIVE",
      score: {
        teamAScore: 5,
        teamBScore: 3,
        currentSet: 2,
        teamASets: 1,
        teamBSets: 0,
        setScores: [
          { setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true },
          { setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true },
          { setNumber: 2, teamAScore: 5, teamBScore: 3, isComplete: false }
        ]
      }
    }, 2);

    expect(state.score.setScores).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true },
      { setNumber: 2, teamAScore: 5, teamBScore: 3, isComplete: false }
    ]);
    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 5,
      teamBScore: 3,
      teamASetScores: [21, 5],
      teamBSetScores: [19, 3]
    });
  });

  it("prefers the completed record when a live set collides with a completed set", () => {
    const state = coerceOverlayState({
      phase: "LIVE",
      score: {
        teamAScore: 19,
        teamBScore: 21,
        currentSet: 2,
        teamASets: 1,
        teamBSets: 1,
        setScores: [
          { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
          { setNumber: 2, teamAScore: 19, teamBScore: 20, isComplete: false },
          { setNumber: 2, teamAScore: 19, teamBScore: 21, isComplete: true }
        ]
      }
    }, 3);

    expect(state.score.setScores).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
      { setNumber: 2, teamAScore: 19, teamBScore: 21, isComplete: true }
    ]);
    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 19,
      teamBScore: 21,
      teamASetScores: [21, 19],
      teamBSetScores: [14, 21]
    });
  });

  it("stable-sorts out-of-order set records before rendering", () => {
    const state = coerceOverlayState({
      phase: "POSTMATCH",
      score: {
        teamAScore: 15,
        teamBScore: 12,
        currentSet: 3,
        teamASets: 2,
        teamBSets: 1,
        setScores: [
          { setNumber: 3, teamAScore: 15, teamBScore: 12, isComplete: true },
          { setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true },
          { setNumber: 2, teamAScore: 18, teamBScore: 21, isComplete: true }
        ]
      }
    }, 7);

    expect(state.score.setScores).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true },
      { setNumber: 2, teamAScore: 18, teamBScore: 21, isComplete: true },
      { setNumber: 3, teamAScore: 15, teamBScore: 12, isComplete: true }
    ]);
    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 15,
      teamBScore: 12,
      teamASetScores: [21, 18, 15],
      teamBSetScores: [19, 21, 12]
    });
  });

  it("drops a phantom third set that started after a straight-sets clinch", () => {
    const state = coerceOverlayState({
      phase: "POSTMATCH",
      score: {
        teamAScore: 2,
        teamBScore: 1,
        currentSet: 3,
        teamASets: 2,
        teamBSets: 0,
        setScores: [
          { setNumber: 1, teamAScore: 21, teamBScore: 15, isComplete: true },
          { setNumber: 2, teamAScore: 21, teamBScore: 19, isComplete: true },
          { setNumber: 3, teamAScore: 2, teamBScore: 1, isComplete: false }
        ]
      }
    }, 5);

    expect(state.score.currentSet).toBe(2);
    expect(state.score.teamASets).toBe(2);
    expect(state.score.teamBSets).toBe(0);
    expect(state.score.setScores).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 15, isComplete: true },
      { setNumber: 2, teamAScore: 21, teamBScore: 19, isComplete: true }
    ]);
    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 21,
      teamBScore: 19,
      teamASetScores: [21, 21],
      teamBSetScores: [15, 19]
    });
  });

  it("coerces overlay state idempotently for messy final payloads", () => {
    const payload = {
      phase: "POSTMATCH",
      score: {
        teamAScore: 12,
        teamBScore: 15,
        currentSet: 3,
        teamASets: 3,
        teamBSets: 0,
        setScores: [
          { setNumber: 2, teamAScore: 21, teamBScore: 19, isComplete: true },
          { setNumber: 1, teamAScore: 21, teamBScore: 15, isComplete: true },
          { setNumber: 2, teamAScore: 21, teamBScore: 19, isComplete: true },
          { setNumber: 3, teamAScore: 12, teamBScore: 15, isComplete: false }
        ]
      }
    };

    const once = coerceOverlayState(payload, 6);
    const twice = coerceOverlayState(once, 6);
    expect(twice).toEqual(once);
    expect(scorebugDisplayScores(twice)).toEqual(scorebugDisplayScores(once));
  });

  it("renders a live second set without creating a separate duplicate current-score column", () => {
    const state = coerceOverlayState({
      phase: "LIVE",
      score: {
        teamAScore: 20,
        teamBScore: 18,
        currentSet: 2,
        teamASets: 1,
        teamBSets: 0,
        setScores: [
          { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
          { setNumber: 2, teamAScore: 20, teamBScore: 18, isComplete: false }
        ]
      }
    }, 2);

    expect(scorebugDisplayScores(state)).toEqual({
      teamAScore: 20,
      teamBScore: 18,
      teamASetScores: [21, 20],
      teamBSetScores: [14, 18]
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

  it("rejects overlay updates that are older than the applied state", () => {
    const applied = coerceOverlayState({
      health: { lastUpdateAt: "2026-07-04T15:00:10.000Z" }
    }, 1);
    const appliedMs = overlayStateUpdatedAtMs(applied);
    expect(appliedMs).toBe(Date.parse("2026-07-04T15:00:10.000Z"));

    const stalePoll = coerceOverlayState({
      health: { lastUpdateAt: "2026-07-04T15:00:08.000Z" }
    }, 1);
    const sameUpdate = coerceOverlayState({
      health: { lastUpdateAt: "2026-07-04T15:00:10.000Z" }
    }, 1);
    const newerRealtime = coerceOverlayState({
      health: { lastUpdateAt: "2026-07-04T15:00:12.000Z" }
    }, 1);
    const missingTimestamp = coerceOverlayState({
      health: { lastUpdateAt: null }
    }, 1);

    expect(shouldApplyOverlayUpdate(stalePoll, appliedMs)).toBe(false);
    expect(shouldApplyOverlayUpdate(sameUpdate, appliedMs)).toBe(true);
    expect(shouldApplyOverlayUpdate(newerRealtime, appliedMs)).toBe(true);
    expect(shouldApplyOverlayUpdate(missingTimestamp, appliedMs)).toBe(false);
    expect(shouldApplyOverlayUpdate(missingTimestamp, null)).toBe(true);
    expect(shouldApplyOverlayUpdate(stalePoll, null)).toBe(true);
    expect(overlayStateUpdatedAtMs(missingTimestamp)).toBeNull();
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
