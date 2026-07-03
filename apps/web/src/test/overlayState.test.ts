import { describe, expect, it } from "vitest";
import {
  coerceOverlayState,
  completedSetScores,
  displayOverlayName,
  overlayPhaseText
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
