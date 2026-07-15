export type CommunityScoreControlsPosition = "top" | "bottom";

export const COMMUNITY_SCORE_CONTROLS_POSITION_KEY = "scorecheck:community-score-controls-position";
export const DEFAULT_COMMUNITY_SCORE_CONTROLS_POSITION: CommunityScoreControlsPosition = "bottom";

export function parseCommunityScoreControlsPosition(value: string | null): CommunityScoreControlsPosition {
  return value === "top" || value === "bottom"
    ? value
    : DEFAULT_COMMUNITY_SCORE_CONTROLS_POSITION;
}

export function oppositeCommunityScoreControlsPosition(
  position: CommunityScoreControlsPosition
): CommunityScoreControlsPosition {
  return position === "top" ? "bottom" : "top";
}
