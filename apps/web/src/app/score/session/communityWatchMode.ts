const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{6,64}$/;

export const COMMUNITY_WATCH_PREFERENCE_KEY = "scorecheck:community-watch-mode";

export function normalizedYoutubeVideoId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return YOUTUBE_VIDEO_ID.test(normalized) ? normalized : null;
}

export function youtubeEmbedUrl(value: string | null | undefined): string | null {
  const videoId = normalizedYoutubeVideoId(value);
  if (!videoId) return null;
  const query = new URLSearchParams({
    autoplay: "1",
    controls: "1",
    fs: "0",
    playsinline: "1",
    rel: "0"
  });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${query.toString()}`;
}

export function youtubeWatchUrl(value: string | null | undefined): string | null {
  const videoId = normalizedYoutubeVideoId(value);
  return videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
}

export function storedVideoPreference(raw: string | null, hasVideo: boolean): boolean {
  if (!hasVideo) return false;
  return raw !== "score-only";
}
