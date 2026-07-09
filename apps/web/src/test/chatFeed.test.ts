import { describe, expect, it } from "vitest";
import { chatMessageRowToDto, COURT_BADGE_COLORS, courtColor, relativeTime, type ChatMessageDbRow } from "../lib/chatFeed";

describe("chatMessageRowToDto", () => {
  it("maps a db row to the client DTO and never leaks the channel id", () => {
    const row: ChatMessageDbRow = {
      id: "row-1",
      youtube_message_id: "yt-1",
      court_number: 3,
      court_label: "Court 8",
      author_name: "Viewer",
      is_moderator: null,
      is_owner: true,
      message_text: "hello",
      published_at: "2026-07-08T10:00:00.000Z",
      created_at: "2026-07-08T10:00:01.000Z"
    };
    const dto = chatMessageRowToDto(row);
    expect(dto).toEqual({
      id: "row-1",
      youtubeMessageId: "yt-1",
      courtNumber: 3,
      courtLabel: "Court 8",
      authorName: "Viewer",
      isModerator: false,
      isOwner: true,
      text: "hello",
      publishedAt: "2026-07-08T10:00:00.000Z",
      createdAt: "2026-07-08T10:00:01.000Z"
    });
    expect(Object.keys(dto)).not.toContain("author_channel_id");
  });
});

describe("courtColor", () => {
  it("is stable and distinct across the eight streams", () => {
    const colors = [1, 2, 3, 4, 5, 6, 7, 8].map(courtColor);
    expect(new Set(colors).size).toBe(8);
    expect(courtColor(3)).toBe(courtColor(3));
    expect(courtColor(3)).toBe(COURT_BADGE_COLORS[2]);
  });

  it("wraps past the palette and handles missing numbers", () => {
    expect(courtColor(9)).toBe(courtColor(1));
    expect(courtColor(null)).toBe("#94a3b8");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-07-08T12:00:00.000Z");
  it("formats seconds, minutes, hours and days", () => {
    expect(relativeTime("2026-07-08T11:59:57.000Z", now)).toBe("now");
    expect(relativeTime("2026-07-08T11:59:30.000Z", now)).toBe("30s");
    expect(relativeTime("2026-07-08T11:57:00.000Z", now)).toBe("3m");
    expect(relativeTime("2026-07-08T10:00:00.000Z", now)).toBe("2h");
    expect(relativeTime("2026-07-06T12:00:00.000Z", now)).toBe("2d");
    expect(relativeTime(null, now)).toBe("");
  });
});
