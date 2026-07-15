import { describe, expect, it } from "vitest";
import {
  normalizedYoutubeVideoId,
  storedVideoPreference,
  youtubeEmbedUrl,
  youtubeWatchUrl
} from "../app/score/session/communityWatchMode";

describe("community watch mode", () => {
  it("accepts only bounded YouTube video IDs", () => {
    expect(normalizedYoutubeVideoId(" abc123_PUBLIC ")).toBe("abc123_PUBLIC");
    expect(normalizedYoutubeVideoId("short")).toBeNull();
    expect(normalizedYoutubeVideoId("abc123?<script>")) .toBeNull();
    expect(normalizedYoutubeVideoId("x".repeat(65))).toBeNull();
  });

  it("builds privacy-enhanced, inline embeds with provider fullscreen disabled", () => {
    const url = new URL(youtubeEmbedUrl("abc123_PUBLIC")!);
    expect(url.origin).toBe("https://www.youtube-nocookie.com");
    expect(url.pathname).toBe("/embed/abc123_PUBLIC");
    expect(url.searchParams.get("playsinline")).toBe("1");
    expect(url.searchParams.get("fs")).toBe("0");
    expect(youtubeWatchUrl("abc123_PUBLIC")).toBe("https://www.youtube.com/watch?v=abc123_PUBLIC");
  });

  it("defaults to watch mode only when video exists and honors score-only preference", () => {
    expect(storedVideoPreference(null, true)).toBe(true);
    expect(storedVideoPreference("watch", true)).toBe(true);
    expect(storedVideoPreference("score-only", true)).toBe(false);
    expect(storedVideoPreference("watch", false)).toBe(false);
  });
});
