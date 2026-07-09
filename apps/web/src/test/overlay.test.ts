import { describe, expect, it } from "vitest";
import { buildOverlayState } from "../lib/overlay";

function overlayInput(status: string, format: Record<string, unknown> = {}) {
  return {
    event: { id: "event", settings: { overlayLayout: "top-left" } },
    court: {
      id: "court",
      event_id: "event",
      court_number: 1,
      display_name: "Stadium",
      mode: "api" as const,
      frozen: false,
      status: "live",
      last_update_at: null
    },
    match: {
      id: "match",
      match_number: "1",
      round_name: "Main Draw",
      scheduled_time: "9:00 AM",
      team_a: "Alpha",
      team_b: "Bravo",
      team_a_seed: "1",
      team_b_seed: "2",
      team_a_players: ["Alpha"],
      team_b_players: ["Bravo"],
      format
    },
    score: {
      team_a_score: 21,
      team_b_score: 18,
      team_a_sets: 1,
      team_b_sets: 0,
      current_set: 1,
      set_scores: [{ setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true }],
      serving_team: null,
      status,
      stale: false,
      message: null,
      last_api_poll_at: null,
      updated_at: null
    }
  };
}

describe("overlay state builder", () => {
  it("preserves an uncapped match as null instead of converting it to cap zero", () => {
    const state = buildOverlayState(overlayInput("In Progress", { bestOf: 3, cap: null }));
    expect(state.match.format.cap).toBeNull();
  });

  it("recognizes completed match statuses without treating Set Complete as postmatch", () => {
    expect(buildOverlayState(overlayInput("Completed")).phase).toBe("POSTMATCH");
    expect(buildOverlayState(overlayInput("Set Complete")).phase).toBe("LIVE");
  });
});
