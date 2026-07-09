/**
 * Quota-throttled orchestrator for the live-chat monitor. One tick
 * (pollEventChatsOnce) resolves the active event and its eligible courts, then
 * for each court with a resolved live chat pulls the next page of messages from
 * the YouTube Data API and upserts them into public.chat_messages.
 *
 * Everything that touches the network or database is injected (fetchers +
 * store), so the flow — including the hard daily-unit budget guard and dedup
 * upsert — is unit testable without hitting Google or Supabase. Cross-tick
 * state (budget total, per-court pageToken, resolved live-chat ids) lives in a
 * ChatPollerState the caller owns and feeds back in; the worker keeps one such
 * state for the process lifetime.
 */

import { getActiveEvent } from "./eventConfig";
import { getEnv } from "./env";
import { supabaseAdmin } from "./supabase";
import {
  canSpend,
  chatDailyUnitBudget,
  createBudgetState,
  fetchChatPage as realFetchChatPage,
  LIVE_CHAT_LIST_UNIT_COST,
  normalizeChatPage,
  refreshAccessToken as realRefreshAccessToken,
  resolveLiveChatId as realResolveLiveChatId,
  selectYoutubeAuthConfig,
  spend,
  VIDEOS_LIST_UNIT_COST,
  type ChatMessageRow,
  type ChatPageResult,
  type OAuthRefreshResult,
  type ResolveLiveChatResult,
  type UnitBudgetState,
  type YoutubeAuthConfig,
  type YoutubeRequestAuth
} from "./youtubeChat";

/** A court eligible for chat polling (has a YouTube video id configured). */
export type ChatCourtTarget = {
  id: string;
  court_number: number | null;
  display_name: string | null;
  youtube_video_id: string | null;
  youtube_live_chat_id: string | null;
};

/** Database seam — the default implementation is Supabase-backed. */
export type ChatStore = {
  loadActiveEvent(eventId?: string): Promise<{ id: string } | null>;
  loadCourts(eventId: string): Promise<ChatCourtTarget[]>;
  /** Upsert on-conflict(youtube_message_id) do-nothing; returns rows inserted. */
  insertMessages(rows: ChatMessageRow[]): Promise<number>;
  setCourtLiveChatId(courtId: string, liveChatId: string | null): Promise<void>;
};

/** Network seam — the default implementation calls the real YouTube API. */
export type ChatFetchers = {
  refreshAccessToken(config: { clientId: string; clientSecret: string; refreshToken: string }): Promise<OAuthRefreshResult>;
  resolveLiveChatId(videoId: string, auth: YoutubeRequestAuth): Promise<ResolveLiveChatResult>;
  fetchChatPage(liveChatId: string, pageToken: string | undefined, auth: YoutubeRequestAuth): Promise<ChatPageResult>;
};

export type ChatPollerState = {
  budget: UnitBudgetState;
  /** court.id -> last nextPageToken (fetch everything since it next tick). */
  pageTokens: Map<string, string>;
  /** youtube_video_id -> resolved activeLiveChatId (avoids re-resolving). */
  liveChatIds: Map<string, string>;
};

export function createChatPollerState(now: number | Date = Date.now()): ChatPollerState {
  return { budget: createBudgetState(now), pageTokens: new Map(), liveChatIds: new Map() };
}

export type CourtPollOutcome = {
  courtNumber: number | null;
  status: "polled" | "no-chat" | "ended" | "error" | "skipped-budget";
  inserted: number;
  detail?: string;
};

export type ChatPollResult = {
  ok: boolean;
  reason?: string;
  eventId: string | null;
  courtsConsidered: number;
  courtsPolled: number;
  messagesInserted: number;
  unitsSpent: number;
  budgetExceeded: boolean;
  courts: CourtPollOutcome[];
  state: ChatPollerState;
};

export type PollEventChatsInput = {
  /** Optional explicit event; defaults to the DB-resolved active event. */
  eventId?: string;
  /** Cross-tick state; a fresh one is created when omitted. */
  state?: ChatPollerState;
  /** Auth config; defaults to env (OAuth preferred, else API key). */
  authConfig?: YoutubeAuthConfig | null;
  /** Daily-unit budget guard; defaults to env. */
  dailyUnitBudget?: number;
  store?: ChatStore;
  fetchers?: ChatFetchers;
  now?: number;
};

export async function pollEventChatsOnce(input: PollEventChatsInput = {}): Promise<ChatPollResult> {
  const now = input.now ?? Date.now();
  const state = input.state ?? createChatPollerState(now);
  const store = input.store ?? supabaseChatStore();
  const fetchers = input.fetchers ?? defaultChatFetchers();
  const dailyUnitBudget = input.dailyUnitBudget ?? chatDailyUnitBudget();

  const empty = (reason: string): ChatPollResult => ({
    ok: false,
    reason,
    eventId: null,
    courtsConsidered: 0,
    courtsPolled: 0,
    messagesInserted: 0,
    unitsSpent: 0,
    budgetExceeded: false,
    courts: [],
    state
  });

  const authConfig = input.authConfig !== undefined ? input.authConfig : resolveEnvAuthConfig();
  if (!authConfig) return empty("youtube-not-configured");

  // Resolve a per-tick request auth (one OAuth refresh per tick, reused across
  // every court so we don't burn refreshes).
  let requestAuth: YoutubeRequestAuth;
  try {
    requestAuth = authConfig.mode === "oauth"
      ? { mode: "oauth", accessToken: (await fetchers.refreshAccessToken(authConfig)).accessToken }
      : { mode: "apiKey", apiKey: authConfig.apiKey };
  } catch (err) {
    return { ...empty("oauth-refresh-failed"), reason: err instanceof Error ? err.message : "oauth-refresh-failed" };
  }

  const event = await store.loadActiveEvent(input.eventId);
  if (!event) return empty("no-active-event");

  const courts = (await store.loadCourts(event.id)).filter((court) => (court.youtube_video_id ?? "").trim().length > 0);
  const result: ChatPollResult = {
    ok: true,
    eventId: event.id,
    courtsConsidered: courts.length,
    courtsPolled: 0,
    messagesInserted: 0,
    unitsSpent: 0,
    budgetExceeded: false,
    courts: [],
    state
  };

  const startUnits = state.budget.unitsSpent;

  for (const court of courts) {
    const videoId = (court.youtube_video_id ?? "").trim();
    const outcome: CourtPollOutcome = { courtNumber: court.court_number, status: "skipped-budget", inserted: 0 };

    // Resolve the live chat id (cached, or via videos.list at 1 unit).
    const storedLiveChatId = (court.youtube_live_chat_id ?? "").trim();
    let liveChatId = state.liveChatIds.get(videoId) ?? (storedLiveChatId || undefined);
    if (!liveChatId) {
      if (!canSpend(state.budget, dailyUnitBudget, VIDEOS_LIST_UNIT_COST, now)) {
        result.budgetExceeded = true;
        result.courts.push({ ...outcome, status: "skipped-budget" });
        break;
      }
      state.budget = spend(state.budget, VIDEOS_LIST_UNIT_COST, now);
      const resolved = await fetchers.resolveLiveChatId(videoId, requestAuth);
      if (resolved.status === "ok") {
        liveChatId = resolved.liveChatId;
        state.liveChatIds.set(videoId, liveChatId);
        if (liveChatId !== (court.youtube_live_chat_id ?? "")) {
          await store.setCourtLiveChatId(court.id, liveChatId).catch(() => undefined);
        }
      } else if (resolved.status === "no-chat" || resolved.status === "ended") {
        result.courts.push({ ...outcome, status: resolved.status === "ended" ? "ended" : "no-chat" });
        continue;
      } else {
        result.courts.push({ ...outcome, status: "error", detail: resolved.message });
        continue;
      }
    }

    // Fetch the next page of messages (5 units).
    if (!canSpend(state.budget, dailyUnitBudget, LIVE_CHAT_LIST_UNIT_COST, now)) {
      result.budgetExceeded = true;
      result.courts.push({ ...outcome, status: "skipped-budget" });
      break;
    }
    state.budget = spend(state.budget, LIVE_CHAT_LIST_UNIT_COST, now);
    const page = await fetchers.fetchChatPage(liveChatId, state.pageTokens.get(court.id), requestAuth);

    if (page.status === "ended") {
      // Stream/chat changed — drop caches so we re-resolve from scratch.
      state.pageTokens.delete(court.id);
      state.liveChatIds.delete(videoId);
      await store.setCourtLiveChatId(court.id, null).catch(() => undefined);
      result.courts.push({ ...outcome, status: "ended" });
      continue;
    }
    if (page.status === "error") {
      result.courts.push({ ...outcome, status: "error", detail: page.message });
      continue;
    }

    if (page.nextPageToken) state.pageTokens.set(court.id, page.nextPageToken);
    const rows = normalizeChatPage(page.items, {
      eventId: event.id,
      courtId: court.id,
      courtNumber: court.court_number,
      courtLabel: court.display_name
    });
    const inserted = rows.length ? await store.insertMessages(rows) : 0;
    result.courtsPolled += 1;
    result.messagesInserted += inserted;
    result.courts.push({ ...outcome, status: "polled", inserted });
  }

  result.unitsSpent = state.budget.unitsSpent - startUnits;
  return result;
}

function resolveEnvAuthConfig(): YoutubeAuthConfig | null {
  const env = getEnv();
  return selectYoutubeAuthConfig({
    apiKey: env.youtubeApiKey,
    clientId: env.youtubeClientId,
    clientSecret: env.youtubeClientSecret,
    refreshToken: env.youtubeRefreshToken
  });
}

export function defaultChatFetchers(): ChatFetchers {
  return {
    refreshAccessToken: (config) => realRefreshAccessToken(config),
    resolveLiveChatId: (videoId, auth) => realResolveLiveChatId(videoId, auth),
    fetchChatPage: (liveChatId, pageToken, auth) => realFetchChatPage(liveChatId, pageToken, auth)
  };
}

export function supabaseChatStore(): ChatStore {
  const db = supabaseAdmin();
  return {
    async loadActiveEvent(eventId?: string) {
      if (eventId) return { id: eventId };
      const event = await getActiveEvent(db);
      return event ? { id: event.id } : null;
    },
    async loadCourts(eventId: string) {
      const { data, error } = await db
        .from("courts")
        .select("id,court_number,display_name,youtube_video_id,youtube_live_chat_id")
        .eq("event_id", eventId)
        .order("court_number", { ascending: true });
      if (error) throw new Error(error.message);
      return (data as ChatCourtTarget[] | null) ?? [];
    },
    async insertMessages(rows: ChatMessageRow[]) {
      if (!rows.length) return 0;
      const { data, error } = await db
        .from("chat_messages")
        .upsert(rows, { onConflict: "youtube_message_id", ignoreDuplicates: true })
        .select("youtube_message_id");
      if (error) throw new Error(error.message);
      return (data as unknown[] | null)?.length ?? 0;
    },
    async setCourtLiveChatId(courtId: string, liveChatId: string | null) {
      const { error } = await db
        .from("courts")
        .update({ youtube_live_chat_id: liveChatId, updated_at: new Date().toISOString() })
        .eq("id", courtId);
      if (error) throw new Error(error.message);
    }
  };
}
