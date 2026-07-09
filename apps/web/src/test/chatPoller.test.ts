import { describe, expect, it } from "vitest";
import {
  createChatPollerState,
  pollEventChatsOnce,
  type ChatCourtTarget,
  type ChatFetchers,
  type ChatStore
} from "../lib/chatPoller";
import type { ChatMessageRow, YoutubeLiveChatItem } from "../lib/youtubeChat";

function makeStore(courts: ChatCourtTarget[]) {
  const inserted: ChatMessageRow[] = [];
  const seen = new Set<string>();
  const liveChatWrites: Array<{ courtId: string; liveChatId: string | null }> = [];
  const store: ChatStore = {
    async loadActiveEvent(eventId) {
      return { id: eventId ?? "event-1" };
    },
    async loadCourts() {
      return courts;
    },
    async insertMessages(rows) {
      // Emulate on-conflict(youtube_message_id) do-nothing.
      let count = 0;
      for (const row of rows) {
        if (seen.has(row.youtube_message_id)) continue;
        seen.add(row.youtube_message_id);
        inserted.push(row);
        count += 1;
      }
      return count;
    },
    async setCourtLiveChatId(courtId, liveChatId) {
      liveChatWrites.push({ courtId, liveChatId });
    }
  };
  return { store, inserted, liveChatWrites };
}

function textItem(id: string, text: string): YoutubeLiveChatItem {
  return { id, snippet: { displayMessage: text, publishedAt: "2026-07-08T10:00:00.000Z" }, authorDetails: { displayName: "V" } };
}

const oauthConfig = { mode: "oauth" as const, clientId: "c", clientSecret: "s", refreshToken: "r" };

describe("pollEventChatsOnce", () => {
  it("skips cleanly when YouTube auth is not configured", async () => {
    const { store } = makeStore([]);
    const res = await pollEventChatsOnce({ authConfig: null, store, fetchers: stubFetchers() });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("youtube-not-configured");
  });

  it("resolves the live chat, inserts new messages, and persists the chat id", async () => {
    const courts: ChatCourtTarget[] = [
      { id: "court-a", court_number: 1, display_name: "Center Court", youtube_video_id: "vid-a", youtube_live_chat_id: null }
    ];
    const { store, inserted, liveChatWrites } = makeStore(courts);
    const fetchers = stubFetchers({
      resolve: { "vid-a": { status: "ok", liveChatId: "LC-A" } },
      pages: { "LC-A": [{ status: "ok", items: [textItem("m1", "hello"), textItem("m2", "world")], nextPageToken: "PT-1", pollingIntervalMillis: null }] }
    });

    const res = await pollEventChatsOnce({ authConfig: oauthConfig, store, fetchers });
    expect(res.ok).toBe(true);
    expect(res.courtsPolled).toBe(1);
    expect(res.messagesInserted).toBe(2);
    expect(inserted.map((r) => r.youtube_message_id)).toEqual(["m1", "m2"]);
    expect(inserted[0].court_number).toBe(1);
    expect(inserted[0].court_label).toBe("Center Court");
    // videos.list (1) + liveChatMessages.list (5)
    expect(res.unitsSpent).toBe(6);
    expect(liveChatWrites).toContainEqual({ courtId: "court-a", liveChatId: "LC-A" });
  });

  it("dedups across ticks using the persisted pageToken and unique message id", async () => {
    const courts: ChatCourtTarget[] = [
      { id: "court-a", court_number: 1, display_name: "Center Court", youtube_video_id: "vid-a", youtube_live_chat_id: "LC-A" }
    ];
    const { store, inserted } = makeStore(courts);
    const fetchers = stubFetchers({
      pages: {
        "LC-A": [
          { status: "ok", items: [textItem("m1", "one")], nextPageToken: "PT-1", pollingIntervalMillis: null },
          { status: "ok", items: [textItem("m1", "one"), textItem("m2", "two")], nextPageToken: "PT-2", pollingIntervalMillis: null }
        ]
      }
    });
    const state = createChatPollerState();

    const first = await pollEventChatsOnce({ authConfig: oauthConfig, store, fetchers, state });
    expect(first.messagesInserted).toBe(1);
    // live chat id was pre-set on the court, so no videos.list — only the 5-unit list.
    expect(first.unitsSpent).toBe(5);

    const second = await pollEventChatsOnce({ authConfig: oauthConfig, store, fetchers, state: first.state });
    expect(second.messagesInserted).toBe(1); // m1 deduped, only m2 is new
    expect(inserted.map((r) => r.youtube_message_id)).toEqual(["m1", "m2"]);
    // pageToken from tick 1 was forwarded into tick 2
    expect(fetchers.pageTokenSeen).toEqual([undefined, "PT-1"]);
  });

  it("stops for the day when the unit budget is exhausted", async () => {
    const courts: ChatCourtTarget[] = [
      { id: "a", court_number: 1, display_name: "C1", youtube_video_id: "vid-a", youtube_live_chat_id: "LC-A" },
      { id: "b", court_number: 2, display_name: "C2", youtube_video_id: "vid-b", youtube_live_chat_id: "LC-B" }
    ];
    const { store } = makeStore(courts);
    const fetchers = stubFetchers({
      pages: {
        "LC-A": [{ status: "ok", items: [textItem("m1", "one")], nextPageToken: null, pollingIntervalMillis: null }],
        "LC-B": [{ status: "ok", items: [textItem("m2", "two")], nextPageToken: null, pollingIntervalMillis: null }]
      }
    });
    // Budget only affords the first court's 5-unit list call.
    const res = await pollEventChatsOnce({ authConfig: oauthConfig, store, fetchers, dailyUnitBudget: 5 });
    expect(res.courtsPolled).toBe(1);
    expect(res.budgetExceeded).toBe(true);
    expect(res.courts.find((c) => c.courtNumber === 2)?.status).toBe("skipped-budget");
  });

  it("clears caches and re-resolves when a chat has ended", async () => {
    const courts: ChatCourtTarget[] = [
      { id: "a", court_number: 1, display_name: "C1", youtube_video_id: "vid-a", youtube_live_chat_id: "LC-OLD" }
    ];
    const { store, liveChatWrites } = makeStore(courts);
    const fetchers = stubFetchers({ pages: { "LC-OLD": [{ status: "ended" }] } });
    const state = createChatPollerState();
    const res = await pollEventChatsOnce({ authConfig: oauthConfig, store, fetchers, state });
    expect(res.courts[0].status).toBe("ended");
    expect(state.pageTokens.size).toBe(0);
    expect(liveChatWrites).toContainEqual({ courtId: "a", liveChatId: null });
  });
});

type PageResult = Awaited<ReturnType<ChatFetchers["fetchChatPage"]>>;
type ResolveResult = Awaited<ReturnType<ChatFetchers["resolveLiveChatId"]>>;

function stubFetchers(opts?: {
  resolve?: Record<string, ResolveResult>;
  pages?: Record<string, PageResult[]>;
}): ChatFetchers & { pageTokenSeen: Array<string | undefined> } {
  const pageIndex: Record<string, number> = {};
  const pageTokenSeen: Array<string | undefined> = [];
  return {
    pageTokenSeen,
    async refreshAccessToken() {
      return { accessToken: "AT", expiresInSec: 3600 };
    },
    async resolveLiveChatId(videoId) {
      return opts?.resolve?.[videoId] ?? { status: "no-chat" };
    },
    async fetchChatPage(liveChatId, pageToken) {
      pageTokenSeen.push(pageToken);
      const queue = opts?.pages?.[liveChatId] ?? [];
      const idx = Math.min(pageIndex[liveChatId] ?? 0, queue.length - 1);
      pageIndex[liveChatId] = (pageIndex[liveChatId] ?? 0) + 1;
      return queue[idx] ?? { status: "ok", items: [], nextPageToken: null, pollingIntervalMillis: null };
    }
  };
}
