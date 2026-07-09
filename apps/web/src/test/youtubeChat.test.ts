import { describe, expect, it } from "vitest";
import {
  authorizeYoutubeRequest,
  canSpend,
  chatMessageText,
  createBudgetState,
  dedupKey,
  fetchChatPage,
  LIVE_CHAT_LIST_UNIT_COST,
  normalizeChatMessage,
  normalizeChatPage,
  refreshAccessToken,
  resolveChatPollIntervalMs,
  resolveDailyUnitBudget,
  resolveLiveChatId,
  rollBudget,
  selectYoutubeAuthConfig,
  spend,
  utcDayKey,
  VIDEOS_LIST_UNIT_COST,
  type FetchLike,
  type YoutubeLiveChatItem,
  type YoutubeRequestAuth
} from "../lib/youtubeChat";

describe("quota interval math", () => {
  it("defaults to 180s when unset or blank", () => {
    expect(resolveChatPollIntervalMs(undefined)).toBe(180_000);
    expect(resolveChatPollIntervalMs("")).toBe(180_000);
  });

  it("floors at 15s and caps at one hour", () => {
    expect(resolveChatPollIntervalMs("1000")).toBe(15_000);
    expect(resolveChatPollIntervalMs("9999999")).toBe(3_600_000);
  });

  it("passes through valid values and falls back on junk", () => {
    expect(resolveChatPollIntervalMs("45000")).toBe(45_000);
    expect(resolveChatPollIntervalMs("not-a-number")).toBe(180_000);
    expect(resolveChatPollIntervalMs("-5")).toBe(180_000);
  });
});

describe("daily unit budget math", () => {
  it("defaults to 9000 and clamps to sane bounds", () => {
    expect(resolveDailyUnitBudget(undefined)).toBe(9_000);
    expect(resolveDailyUnitBudget("10")).toBe(100);
    expect(resolveDailyUnitBudget("99999999")).toBe(1_000_000);
    expect(resolveDailyUnitBudget("5000")).toBe(5_000);
    expect(resolveDailyUnitBudget("junk")).toBe(9_000);
  });
});

describe("budget day-rollover", () => {
  const day1 = Date.parse("2026-07-08T10:00:00.000Z");
  const day1Late = Date.parse("2026-07-08T23:59:00.000Z");
  const day2 = Date.parse("2026-07-09T00:01:00.000Z");

  it("keys the running total by UTC day", () => {
    expect(utcDayKey(day1)).toBe("2026-07-08");
    expect(utcDayKey(day2)).toBe("2026-07-09");
  });

  it("accumulates within a day and resets when the UTC day changes", () => {
    let state = createBudgetState(day1);
    state = spend(state, LIVE_CHAT_LIST_UNIT_COST, day1);
    state = spend(state, VIDEOS_LIST_UNIT_COST, day1Late);
    expect(state.unitsSpent).toBe(6);
    expect(state.utcDay).toBe("2026-07-08");

    const rolled = rollBudget(state, day2);
    expect(rolled.unitsSpent).toBe(0);
    expect(rolled.utcDay).toBe("2026-07-09");

    // spend after rollover starts fresh
    const afterRollover = spend(state, 5, day2);
    expect(afterRollover.unitsSpent).toBe(5);
    expect(afterRollover.utcDay).toBe("2026-07-09");
  });

  it("guards spend against the budget ceiling", () => {
    const state = { utcDay: "2026-07-08", unitsSpent: 8_996 };
    expect(canSpend(state, 9_000, LIVE_CHAT_LIST_UNIT_COST, day1)).toBe(false);
    expect(canSpend(state, 9_000, VIDEOS_LIST_UNIT_COST, day1)).toBe(true);
    // rollover frees the budget again
    expect(canSpend(state, 9_000, LIVE_CHAT_LIST_UNIT_COST, day2)).toBe(true);
  });
});

describe("auth selection", () => {
  it("prefers OAuth when the full trio is present", () => {
    expect(selectYoutubeAuthConfig({
      apiKey: "KEY",
      clientId: "cid",
      clientSecret: "secret",
      refreshToken: "refresh"
    })).toEqual({ mode: "oauth", clientId: "cid", clientSecret: "secret", refreshToken: "refresh" });
  });

  it("falls back to the API key when OAuth is incomplete", () => {
    expect(selectYoutubeAuthConfig({ apiKey: "KEY", clientId: "cid", clientSecret: "", refreshToken: "refresh" }))
      .toEqual({ mode: "apiKey", apiKey: "KEY" });
  });

  it("returns null when nothing usable is configured (whitespace doesn't count)", () => {
    expect(selectYoutubeAuthConfig({ apiKey: "  ", clientId: " ", clientSecret: "", refreshToken: "" })).toBeNull();
    expect(selectYoutubeAuthConfig({})).toBeNull();
  });

  it("puts the API key on the query and OAuth on the header", () => {
    const keyed = authorizeYoutubeRequest("videos", { part: "liveStreamingDetails", id: "vid" }, { mode: "apiKey", apiKey: "KEY" });
    expect(keyed.url).toContain("key=KEY");
    expect(keyed.url).toContain("id=vid");
    expect(keyed.headers.authorization).toBeUndefined();

    const oauth = authorizeYoutubeRequest("liveChat/messages", { liveChatId: "lc" }, { mode: "oauth", accessToken: "AT" });
    expect(oauth.headers.authorization).toBe("Bearer AT");
    expect(oauth.url).not.toContain("key=");
  });
});

describe("message normalization + dedup", () => {
  const court = { eventId: "e1", courtId: "c1", courtNumber: 3, courtLabel: "Court 8" };
  const baseItem: YoutubeLiveChatItem = {
    id: "msg-1",
    snippet: { type: "textMessageEvent", publishedAt: "2026-07-08T10:00:00.000Z", displayMessage: "fix court 3 camera" },
    authorDetails: { channelId: "chan-1", displayName: "Viewer One", isChatModerator: false, isChatOwner: false }
  };

  it("uses the YouTube id as the dedup key", () => {
    expect(dedupKey(baseItem)).toBe("msg-1");
    expect(dedupKey({ id: "  " })).toBeNull();
    expect(dedupKey({})).toBeNull();
  });

  it("prefers displayMessage then textMessageDetails for the body", () => {
    expect(chatMessageText(baseItem)).toBe("fix court 3 camera");
    expect(chatMessageText({ snippet: { textMessageDetails: { messageText: "detail body" } } })).toBe("detail body");
    expect(chatMessageText({ snippet: {} })).toBe("");
  });

  it("normalizes a message into a chat_messages row with court context", () => {
    expect(normalizeChatMessage(baseItem, court)).toEqual({
      event_id: "e1",
      court_id: "c1",
      court_number: 3,
      court_label: "Court 8",
      youtube_message_id: "msg-1",
      author_name: "Viewer One",
      author_channel_id: "chan-1",
      is_moderator: false,
      is_owner: false,
      message_text: "fix court 3 camera",
      published_at: "2026-07-08T10:00:00.000Z"
    });
  });

  it("carries moderator and owner flags through", () => {
    const modItem = { ...baseItem, authorDetails: { ...baseItem.authorDetails, isChatModerator: true, isChatOwner: true } };
    const row = normalizeChatMessage(modItem, court);
    expect(row?.is_moderator).toBe(true);
    expect(row?.is_owner).toBe(true);
  });

  it("drops items with no id or no visible text", () => {
    expect(normalizeChatMessage({ snippet: { displayMessage: "no id" } }, court)).toBeNull();
    expect(normalizeChatMessage({ id: "x", snippet: {} }, court)).toBeNull();
  });

  it("normalizes a page, dropping the unusable ones", () => {
    const rows = normalizeChatPage([baseItem, { id: "no-text", snippet: {} }, { snippet: { displayMessage: "no id" } }], court);
    expect(rows).toHaveLength(1);
    expect(rows[0].youtube_message_id).toBe("msg-1");
  });
});

/* --- IO helpers with an injected fetch (never touches the network) --- */

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; ok?: boolean; json?: unknown; text?: string }): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url, init);
    const status = r.status ?? (r.ok === false ? 500 : 200);
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => r.json ?? {},
      text: async () => r.text ?? (r.json ? JSON.stringify(r.json) : "")
    } as Response;
  }) as FetchLike;
}

const apiKeyAuth: YoutubeRequestAuth = { mode: "apiKey", apiKey: "KEY" };

describe("refreshAccessToken (IO, injected fetch)", () => {
  it("returns the access token on success", async () => {
    const fetchImpl = fakeFetch(() => ({ json: { access_token: "AT-123", expires_in: 3600 } }));
    const res = await refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r" }, fetchImpl);
    expect(res.accessToken).toBe("AT-123");
    expect(res.expiresInSec).toBe(3600);
  });

  it("throws on an error response", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 400, ok: false, text: "invalid_grant" }));
    await expect(refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "r" }, fetchImpl)).rejects.toThrow(/invalid_grant/);
  });
});

describe("resolveLiveChatId (IO, injected fetch)", () => {
  it("returns the active live chat id", async () => {
    const fetchImpl = fakeFetch(() => ({ json: { items: [{ liveStreamingDetails: { activeLiveChatId: "LC-1" } }] } }));
    await expect(resolveLiveChatId("vid", apiKeyAuth, fetchImpl)).resolves.toEqual({ status: "ok", liveChatId: "LC-1" });
  });

  it("reports no-chat when the video has no active chat, and ended when the video is gone", async () => {
    const noChat = fakeFetch(() => ({ json: { items: [{ liveStreamingDetails: {} }] } }));
    await expect(resolveLiveChatId("vid", apiKeyAuth, noChat)).resolves.toEqual({ status: "no-chat" });
    const gone = fakeFetch(() => ({ json: { items: [] } }));
    await expect(resolveLiveChatId("vid", apiKeyAuth, gone)).resolves.toEqual({ status: "ended" });
  });

  it("reports an error on a non-OK response", async () => {
    const fetchImpl = fakeFetch(() => ({ status: 403, ok: false, text: "quotaExceeded" }));
    const res = await resolveLiveChatId("vid", apiKeyAuth, fetchImpl);
    expect(res.status).toBe("error");
  });
});

describe("fetchChatPage (IO, injected fetch)", () => {
  it("returns items and the next page token", async () => {
    const fetchImpl = fakeFetch(() => ({
      json: { items: [{ id: "m1", snippet: { displayMessage: "hi" } }], nextPageToken: "PT-2", pollingIntervalMillis: 5000 }
    }));
    const res = await fetchChatPage("LC-1", undefined, apiKeyAuth, fetchImpl);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.items).toHaveLength(1);
      expect(res.nextPageToken).toBe("PT-2");
      expect(res.pollingIntervalMillis).toBe(5000);
    }
  });

  it("maps a liveChatEnded 403 and a 404 to ended", async () => {
    const ended403 = fakeFetch(() => ({ status: 403, ok: false, text: JSON.stringify({ error: { errors: [{ reason: "liveChatEnded" }] } }) }));
    await expect(fetchChatPage("LC-1", undefined, apiKeyAuth, ended403)).resolves.toEqual({ status: "ended" });
    const gone = fakeFetch(() => ({ status: 404, ok: false, text: "not found" }));
    await expect(fetchChatPage("LC-1", undefined, apiKeyAuth, gone)).resolves.toEqual({ status: "ended" });
  });

  it("treats an offlineAt payload as ended", async () => {
    const fetchImpl = fakeFetch(() => ({ json: { items: [], offlineAt: "2026-07-08T11:00:00Z" } }));
    await expect(fetchChatPage("LC-1", undefined, apiKeyAuth, fetchImpl)).resolves.toEqual({ status: "ended" });
  });

  it("forwards the pageToken on the request", async () => {
    let seen: string | null = null;
    const fetchImpl = fakeFetch((url) => {
      seen = new URL(url).searchParams.get("pageToken");
      return { json: { items: [], nextPageToken: null } };
    });
    await fetchChatPage("LC-1", "PT-9", apiKeyAuth, fetchImpl);
    expect(seen).toBe("PT-9");
  });
});
