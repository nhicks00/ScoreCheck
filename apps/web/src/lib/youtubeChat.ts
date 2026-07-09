/**
 * YouTube Data API v3 live-chat reader — auth, quota math, and message
 * normalization for the unified chat monitor.
 *
 * Verified against the official docs before implementation:
 *   - liveChatMessages.list accepts an API key for PUBLIC live chats, or an
 *     OAuth 2.0 access token; cost ~5 units/call.
 *     https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list
 *   - videos.list(part=liveStreamingDetails) resolves activeLiveChatId from a
 *     video id; cost 1 unit/call.
 *     https://developers.google.com/youtube/v3/docs/videos/list
 *   - Default project quota is 10,000 units/day.
 *     https://developers.google.com/youtube/v3/determine_quota_cost
 *
 * The file is split into PURE helpers (quota interval/budget math, auth
 * selection, message normalization, dedup key, UTC day rollover — all unit
 * tested with injected fakes) and IO helpers (resolveLiveChatId, fetchChatPage,
 * refreshAccessToken) that talk to Google over global fetch. The IO helpers
 * take an injectable fetch so tests never touch the network.
 */

// --- Quota costs (units). Budget conservatively at the higher documented cost
// so the daily guard can never exceed quota even if Google bills less. ---
export const VIDEOS_LIST_UNIT_COST = 1;
export const LIVE_CHAT_LIST_UNIT_COST = 5;

const DEFAULT_POLL_INTERVAL_MS = 180_000;
const MIN_POLL_INTERVAL_MS = 15_000;
const MAX_POLL_INTERVAL_MS = 60 * 60_000;
const DEFAULT_DAILY_UNIT_BUDGET = 9_000;
const MIN_DAILY_UNIT_BUDGET = 100;
const MAX_DAILY_UNIT_BUDGET = 1_000_000;

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

/* ===========================================================================
   Quota interval / budget math (pure)
   ======================================================================== */

/**
 * Resolve the per-stream poll interval from a raw env string. Defaults to 180s
 * and is floored at 15s so a fat-fingered value can't hammer the API.
 */
export function resolveChatPollIntervalMs(raw: string | undefined): number {
  if (raw == null || raw === "") return DEFAULT_POLL_INTERVAL_MS;
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, value));
}

/** Resolve the hard daily-unit budget from a raw env string. */
export function resolveDailyUnitBudget(raw: string | undefined): number {
  if (raw == null || raw === "") return DEFAULT_DAILY_UNIT_BUDGET;
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DAILY_UNIT_BUDGET;
  return Math.min(MAX_DAILY_UNIT_BUDGET, Math.max(MIN_DAILY_UNIT_BUDGET, value));
}

/** Reads the interval from process.env (thin wrapper over the pure resolver). */
export function chatPollIntervalMs(): number {
  return resolveChatPollIntervalMs(process.env.YOUTUBE_CHAT_POLL_INTERVAL_MS);
}

/** Reads the daily budget from process.env (thin wrapper over the resolver). */
export function chatDailyUnitBudget(): number {
  return resolveDailyUnitBudget(process.env.YOUTUBE_CHAT_DAILY_UNIT_BUDGET);
}

export type UnitBudgetState = {
  /** UTC day the running total belongs to (YYYY-MM-DD). */
  utcDay: string;
  /** Units spent so far on utcDay. */
  unitsSpent: number;
};

/** YYYY-MM-DD in UTC — the boundary the daily quota resets on. */
export function utcDayKey(now: number | Date = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function createBudgetState(now: number | Date = Date.now()): UnitBudgetState {
  return { utcDay: utcDayKey(now), unitsSpent: 0 };
}

/** Reset the running total when the UTC day has rolled over; else unchanged. */
export function rollBudget(state: UnitBudgetState, now: number | Date = Date.now()): UnitBudgetState {
  const day = utcDayKey(now);
  if (day !== state.utcDay) return { utcDay: day, unitsSpent: 0 };
  return state;
}

/** Would spending `units` stay within `budget` (after a day rollover)? */
export function canSpend(state: UnitBudgetState, budget: number, units: number, now: number | Date = Date.now()): boolean {
  const rolled = rollBudget(state, now);
  return rolled.unitsSpent + units <= budget;
}

/** Charge `units` against the budget, applying a day rollover first. */
export function spend(state: UnitBudgetState, units: number, now: number | Date = Date.now()): UnitBudgetState {
  const rolled = rollBudget(state, now);
  return { utcDay: rolled.utcDay, unitsSpent: rolled.unitsSpent + units };
}

/* ===========================================================================
   Auth selection (pure)
   ======================================================================== */

export type YoutubeAuthConfig =
  | { mode: "oauth"; clientId: string; clientSecret: string; refreshToken: string }
  | { mode: "apiKey"; apiKey: string };

/** Resolved, ready-to-use auth for a single request. */
export type YoutubeRequestAuth =
  | { mode: "oauth"; accessToken: string }
  | { mode: "apiKey"; apiKey: string };

/**
 * Prefer OAuth (reliable) when the full trio is present, else fall back to an
 * API key, else null (feature disabled). Whitespace-only values don't count.
 */
export function selectYoutubeAuthConfig(src: {
  apiKey?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  refreshToken?: string | null;
}): YoutubeAuthConfig | null {
  const clientId = src.clientId?.trim();
  const clientSecret = src.clientSecret?.trim();
  const refreshToken = src.refreshToken?.trim();
  if (clientId && clientSecret && refreshToken) {
    return { mode: "oauth", clientId, clientSecret, refreshToken };
  }
  const apiKey = src.apiKey?.trim();
  if (apiKey) return { mode: "apiKey", apiKey };
  return null;
}

/**
 * Build the authorized URL + headers for a YouTube GET. API keys ride as a
 * `key` query param; OAuth rides as a Bearer header. Pure so both branches are
 * unit tested without a network.
 */
export function authorizeYoutubeRequest(
  path: string,
  params: Record<string, string>,
  auth: YoutubeRequestAuth
): { url: string; headers: Record<string, string> } {
  const url = new URL(`${YOUTUBE_API_BASE}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth.mode === "apiKey") {
    url.searchParams.set("key", auth.apiKey);
  } else {
    headers.authorization = `Bearer ${auth.accessToken}`;
  }
  return { url: url.toString(), headers };
}

/* ===========================================================================
   Message normalization (pure)
   ======================================================================== */

/** Minimal shape of a YouTube liveChatMessage resource we care about. */
export type YoutubeLiveChatItem = {
  id?: string | null;
  snippet?: {
    type?: string | null;
    publishedAt?: string | null;
    displayMessage?: string | null;
    textMessageDetails?: { messageText?: string | null } | null;
  } | null;
  authorDetails?: {
    channelId?: string | null;
    displayName?: string | null;
    isChatModerator?: boolean | null;
    isChatOwner?: boolean | null;
  } | null;
};

export type CourtChatContext = {
  eventId: string | null;
  courtId: string | null;
  courtNumber: number | null;
  courtLabel: string | null;
};

/** A row ready to upsert into public.chat_messages. */
export type ChatMessageRow = {
  event_id: string | null;
  court_id: string | null;
  court_number: number | null;
  court_label: string | null;
  youtube_message_id: string;
  author_name: string | null;
  author_channel_id: string | null;
  is_moderator: boolean;
  is_owner: boolean;
  message_text: string;
  published_at: string | null;
};

/** The dedup key for a message (its stable YouTube id), or null if absent. */
export function dedupKey(item: YoutubeLiveChatItem): string | null {
  const id = item?.id?.trim();
  return id ? id : null;
}

/** Best-effort visible text for a message (displayMessage, then details). */
export function chatMessageText(item: YoutubeLiveChatItem): string {
  const display = item?.snippet?.displayMessage?.trim();
  if (display) return display;
  const detail = item?.snippet?.textMessageDetails?.messageText?.trim();
  return detail ? detail : "";
}

/**
 * Normalize a YouTube liveChatMessage into a chat_messages row, merging the
 * originating court context. Returns null for items with no id or no visible
 * text (membership/super-sticker events with no readable body are noise for a
 * chat monitor).
 */
export function normalizeChatMessage(item: YoutubeLiveChatItem, court: CourtChatContext): ChatMessageRow | null {
  const id = dedupKey(item);
  if (!id) return null;
  const text = chatMessageText(item);
  if (!text) return null;
  const author = item.authorDetails ?? {};
  return {
    event_id: court.eventId,
    court_id: court.courtId,
    court_number: court.courtNumber,
    court_label: court.courtLabel,
    youtube_message_id: id,
    author_name: author.displayName?.trim() || null,
    author_channel_id: author.channelId?.trim() || null,
    is_moderator: author.isChatModerator === true,
    is_owner: author.isChatOwner === true,
    message_text: text,
    published_at: item.snippet?.publishedAt ?? null
  };
}

/** Normalize a page of items, dropping the ones that don't survive. */
export function normalizeChatPage(items: YoutubeLiveChatItem[] | null | undefined, court: CourtChatContext): ChatMessageRow[] {
  if (!Array.isArray(items)) return [];
  const rows: ChatMessageRow[] = [];
  for (const item of items) {
    const row = normalizeChatMessage(item, court);
    if (row) rows.push(row);
  }
  return rows;
}

/* ===========================================================================
   IO — talks to Google over an injectable fetch (defaults to global fetch)
   ======================================================================== */

export type FetchLike = typeof fetch;

export type OAuthRefreshResult = { accessToken: string; expiresInSec: number };

export type ResolveLiveChatResult =
  | { status: "ok"; liveChatId: string }
  | { status: "no-chat" }
  | { status: "ended" }
  | { status: "error"; message: string };

export type ChatPageResult =
  | { status: "ok"; items: YoutubeLiveChatItem[]; nextPageToken: string | null; pollingIntervalMillis: number | null }
  | { status: "ended" }
  | { status: "error"; message: string };

/** Exchange an OAuth refresh token for a short-lived access token. */
export async function refreshAccessToken(
  config: { clientId: string; clientSecret: string; refreshToken: string },
  fetchImpl: FetchLike = fetch
): Promise<OAuthRefreshResult> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: "refresh_token"
  });
  const res = await fetchImpl(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`YouTube OAuth token refresh failed (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("YouTube OAuth token refresh returned no access_token");
  return { accessToken: json.access_token, expiresInSec: Number(json.expires_in) || 3600 };
}

/** Resolve activeLiveChatId for a public video id via videos.list. */
export async function resolveLiveChatId(
  videoId: string,
  auth: YoutubeRequestAuth,
  fetchImpl: FetchLike = fetch
): Promise<ResolveLiveChatResult> {
  const { url, headers } = authorizeYoutubeRequest("videos", { part: "liveStreamingDetails", id: videoId }, auth);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "videos.list request failed" };
  }
  if (!res.ok) {
    return { status: "error", message: `videos.list failed (${res.status}): ${await safeText(res)}` };
  }
  const json = (await res.json()) as {
    items?: Array<{ liveStreamingDetails?: { activeLiveChatId?: string | null } | null }>;
  };
  const item = json.items?.[0];
  if (!item) return { status: "ended" };
  const liveChatId = item.liveStreamingDetails?.activeLiveChatId?.trim();
  if (!liveChatId) return { status: "no-chat" };
  return { status: "ok", liveChatId };
}

/** Fetch one page of live-chat messages since pageToken. */
export async function fetchChatPage(
  liveChatId: string,
  pageToken: string | undefined,
  auth: YoutubeRequestAuth,
  fetchImpl: FetchLike = fetch
): Promise<ChatPageResult> {
  const params: Record<string, string> = {
    liveChatId,
    part: "snippet,authorDetails",
    maxResults: "2000"
  };
  if (pageToken) params.pageToken = pageToken;
  const { url, headers } = authorizeYoutubeRequest("liveChat/messages", params, auth);
  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "liveChatMessages.list request failed" };
  }
  if (res.status === 403 || res.status === 404) {
    const detail = await safeText(res);
    if (/liveChatEnded|liveChatNotFound|notFound/i.test(detail) || res.status === 404) {
      return { status: "ended" };
    }
    return { status: "error", message: `liveChatMessages.list failed (${res.status}): ${detail}` };
  }
  if (!res.ok) {
    return { status: "error", message: `liveChatMessages.list failed (${res.status}): ${await safeText(res)}` };
  }
  const json = (await res.json()) as {
    items?: YoutubeLiveChatItem[];
    nextPageToken?: string | null;
    pollingIntervalMillis?: number | null;
    offlineAt?: string | null;
  };
  if (json.offlineAt) return { status: "ended" };
  return {
    status: "ok",
    items: json.items ?? [],
    nextPageToken: json.nextPageToken ?? null,
    pollingIntervalMillis: typeof json.pollingIntervalMillis === "number" ? json.pollingIntervalMillis : null
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
