import { getEnv } from "./env";
import { recordHeartbeat } from "./poller";
import { verifyClaimFromYoutubeMessage } from "./scorerSessions";
import { supabaseAdmin } from "./supabase";

const pageTokens = new Map<string, string>();
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

export async function pollYoutubeChatsOnce(workerId: string) {
  const db = supabaseAdmin();
  const { data: courts, error } = await db
    .from("courts")
    .select("id,event_id,court_number,youtube_live_chat_id,events!inner(id,status,is_active)")
    .not("youtube_live_chat_id", "is", null)
    .or("status.eq.active,is_active.eq.true", { foreignTable: "events" });
  if (error) throw error;
  let messages = 0;
  let matched = 0;
  const failures: Array<{ courtNumber: number; status: number; reason: string; message: string }> = [];
  for (const court of courts ?? []) {
    const liveChatId = court.youtube_live_chat_id as string;
    const result = await fetchChatMessages(liveChatId).catch((err: unknown) => {
      const failure = chatFetchFailure(err);
      failures.push({ courtNumber: court.court_number as number, ...failure });
      return null;
    });
    if (!result) {
      if (failures.at(-1)?.reason === "quotaExceeded") break;
      continue;
    }
    if (result.nextPageToken) pageTokens.set(liveChatId, result.nextPageToken);
    for (const item of result.items) {
      const text = item.snippet?.displayMessage ?? item.snippet?.textMessageDetails?.messageText ?? "";
      if (!text) continue;
      messages += 1;
      const verification = await verifyClaimFromYoutubeMessage({
        liveChatId,
        messageId: item.id,
        messageText: text,
        author: {
          channelId: item.authorDetails?.channelId,
          displayName: item.authorDetails?.displayName,
          profileImageUrl: item.authorDetails?.profileImageUrl,
          isChatOwner: item.authorDetails?.isChatOwner,
          isChatModerator: item.authorDetails?.isChatModerator,
          isChatSponsor: item.authorDetails?.isChatSponsor,
          isVerified: item.authorDetails?.isVerified
        },
        publishedAt: item.snippet?.publishedAt
      });
      if (verification.ok && verification.matched) matched += 1;
    }
  }
  const quotaExceeded = failures.some((failure) => failure.reason === "quotaExceeded");
  const status = quotaExceeded ? "youtube-quota-exceeded" : failures.length ? "youtube-partial-error" : "youtube-idle";
  await recordHeartbeat(workerId, status, undefined, {
    courts: courts?.length ?? 0,
    messages,
    matched,
    failures: failures.map((failure) => ({
      courtNumber: failure.courtNumber,
      status: failure.status,
      reason: failure.reason,
      message: failure.message.slice(0, 240)
    }))
  });
  return { courts: courts?.length ?? 0, messages, matched, failures };
}

async function fetchChatMessages(liveChatId: string): Promise<{
  nextPageToken?: string;
  items: Array<{
    id: string;
    snippet?: {
      displayMessage?: string;
      publishedAt?: string;
      textMessageDetails?: { messageText?: string };
    };
    authorDetails?: {
      channelId?: string;
      displayName?: string;
      profileImageUrl?: string;
      isChatOwner?: boolean;
      isChatModerator?: boolean;
      isChatSponsor?: boolean;
      isVerified?: boolean;
    };
  }>;
}> {
  const env = getEnv();
  const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
  url.searchParams.set("liveChatId", liveChatId);
  url.searchParams.set("part", "snippet,authorDetails");
  url.searchParams.set("maxResults", "200");
  const pageToken = pageTokens.get(liveChatId);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const headers: Record<string, string> = {};
  const accessToken = await getAccessToken();
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  } else if (env.youtubeApiKey) {
    url.searchParams.set("key", env.youtubeApiKey);
  } else {
    return { items: [] };
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const reason = typeof body?.error?.errors?.[0]?.reason === "string" ? body.error.errors[0].reason : "unknown";
    const message = typeof body?.error?.message === "string" ? body.error.message : `YouTube chat fetch failed: ${res.status}`;
    throw new YoutubeChatFetchError(res.status, reason, message);
  }
  return await res.json();
}

class YoutubeChatFetchError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = "YoutubeChatFetchError";
  }
}

function chatFetchFailure(err: unknown) {
  if (err instanceof YoutubeChatFetchError) {
    return { status: err.status, reason: err.reason, message: err.message };
  }
  return {
    status: 0,
    reason: "unknown",
    message: err instanceof Error ? err.message : "Unknown YouTube chat fetch failure"
  };
}

async function getAccessToken(): Promise<string | null> {
  const env = getEnv();
  if (!env.youtubeClientId || !env.youtubeClientSecret || !env.youtubeRefreshToken) return null;
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.token;
  }
  const body = new URLSearchParams({
    client_id: env.youtubeClientId,
    client_secret: env.youtubeClientSecret,
    refresh_token: env.youtubeRefreshToken,
    grant_type: "refresh_token"
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!res.ok) return null;
  const json = await res.json();
  cachedAccessToken = {
    token: json.access_token,
    expiresAt: Date.now() + Number(json.expires_in ?? 3000) * 1000
  };
  return cachedAccessToken.token;
}
