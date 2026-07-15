export const COMMUNITY_WATCH_PREFERENCE_KEY = "scorecheck:community-watch-mode";

export function storedVideoPreference(raw: string | null, hasVideo: boolean): boolean {
  if (!hasVideo) return false;
  return raw !== "score-only";
}
