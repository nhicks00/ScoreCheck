import { describe, expect, it } from "vitest";
import {
  COMMUNITY_SCORE_CONTROLS_POSITION_KEY,
  DEFAULT_COMMUNITY_SCORE_CONTROLS_POSITION,
  oppositeCommunityScoreControlsPosition,
  parseCommunityScoreControlsPosition
} from "../app/score/session/communityScoreOverlayPreference";

describe("community score overlay preferences", () => {
  it("uses one stable viewer preference for both team control docks", () => {
    expect(COMMUNITY_SCORE_CONTROLS_POSITION_KEY).toBe("scorecheck:community-score-controls-position");
    expect(DEFAULT_COMMUNITY_SCORE_CONTROLS_POSITION).toBe("bottom");
  });

  it("accepts only top or bottom and safely defaults malformed storage", () => {
    expect(parseCommunityScoreControlsPosition("top")).toBe("top");
    expect(parseCommunityScoreControlsPosition("bottom")).toBe("bottom");
    expect(parseCommunityScoreControlsPosition("left")).toBe("bottom");
    expect(parseCommunityScoreControlsPosition(null)).toBe("bottom");
  });

  it("moves the paired controls between opposite corners", () => {
    expect(oppositeCommunityScoreControlsPosition("bottom")).toBe("top");
    expect(oppositeCommunityScoreControlsPosition("top")).toBe("bottom");
  });
});
