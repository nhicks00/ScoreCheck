import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEnv } from "../../lib/env";
import { loadLocalEnv } from "../envLoader";

type DenverSummary = {
  active_day_stream_key_state?: { active_day?: string | null };
  created_broadcasts?: Array<{
    day?: string;
    court?: number;
    title?: string;
    broadcast_id?: string;
    scheduled_start?: string;
    venue_court_label?: string;
  }>;
};

type YoutubeBroadcast = {
  id: string;
  snippet?: {
    liveChatId?: string;
    scheduledStartTime?: string;
    title?: string;
  };
  status?: {
    lifeCycleStatus?: string;
    privacyStatus?: string;
  };
  contentDetails?: {
    boundStreamId?: string;
  };
};

loadLocalEnv();

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function main() {
  const summary = readSummary();
  const broadcasts = (summary.created_broadcasts ?? [])
    .filter((broadcast) => broadcast.broadcast_id && broadcast.day && Number.isInteger(broadcast.court));
  if (broadcasts.length === 0) throw new Error("No Denver broadcasts found in summary JSON");

  const activeDay = selectedActiveDay(summary, broadcasts);
  const selected = broadcasts
    .filter((broadcast) => broadcast.day === activeDay)
    .sort((a, b) => (a.court ?? 0) - (b.court ?? 0));
  if (selected.length === 0) throw new Error(`No Denver broadcasts found for active day '${activeDay}'`);

  const accessToken = await getYoutubeAccessToken();
  const broadcastDetails = await fetchBroadcasts(selected.map((broadcast) => broadcast.broadcast_id as string), accessToken);
  const byId = Object.fromEntries(broadcastDetails.map((broadcast) => [broadcast.id, broadcast]));
  const courts = selected.map((broadcast) => {
    const detail = byId[broadcast.broadcast_id as string];
    return {
      courtNumber: broadcast.court as number,
      day: broadcast.day as string,
      displayName: broadcast.venue_court_label || `Court ${broadcast.court}`,
      youtubeVideoId: broadcast.broadcast_id as string,
      youtubeLiveChatId: detail?.snippet?.liveChatId ?? null,
      title: detail?.snippet?.title || broadcast.title || null,
      scheduledStart: detail?.snippet?.scheduledStartTime || broadcast.scheduled_start || null,
      privacyStatus: detail?.status?.privacyStatus ?? null,
      lifeCycleStatus: detail?.status?.lifeCycleStatus ?? null,
      boundStreamId: detail?.contentDetails?.boundStreamId ?? null
    };
  });

  const missingLiveChat = courts.filter((court) => !court.youtubeLiveChatId);
  if (missingLiveChat.length > 0) {
    throw new Error(`Missing YouTube live chat IDs for ${missingLiveChat.length} Denver ${activeDay} courts`);
  }

  const outputDir = path.join(process.cwd(), ".local");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "youtube-denver.generated.json");
  fs.writeFileSync(outputPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    sourceSummaryPath: summaryPath(),
    activeDay,
    courts
  }, null, 2));
  console.log(`Wrote ${outputPath}`);
  console.log(`Denver YouTube metadata ready for ${activeDay}: ${courts.length} courts`);
}

function summaryPath() {
  return process.env.YOUTUBE_DENVER_SUMMARY_PATH
    || path.join(os.homedir(), ".hermes/tools/youtube_api/denver_open_2026_created.json");
}

function readSummary(): DenverSummary {
  const file = summaryPath();
  if (!fs.existsSync(file)) throw new Error(`Denver YouTube summary not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as DenverSummary;
}

function selectedActiveDay(summary: DenverSummary, broadcasts: NonNullable<DenverSummary["created_broadcasts"]>) {
  const configured = process.env.YOUTUBE_DENVER_ACTIVE_DAY || summary.active_day_stream_key_state?.active_day || "";
  if (configured) return configured.toLowerCase();

  const now = Date.now();
  const upcoming = broadcasts
    .filter((broadcast) => broadcast.scheduled_start && Date.parse(broadcast.scheduled_start) >= now)
    .sort((a, b) => Date.parse(a.scheduled_start as string) - Date.parse(b.scheduled_start as string));
  if (upcoming[0]?.day) return upcoming[0].day.toLowerCase();
  if (broadcasts[0]?.day) return broadcasts[0].day.toLowerCase();
  throw new Error("Could not determine Denver active day");
}

async function getYoutubeAccessToken() {
  const env = getEnv();
  if (!env.youtubeClientId || !env.youtubeClientSecret || !env.youtubeRefreshToken) {
    throw new Error("YouTube OAuth env is required: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN");
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
  if (!res.ok) throw new Error(`YouTube OAuth refresh failed with ${res.status}`);
  const json = await res.json() as { access_token?: string };
  if (!json.access_token) throw new Error("YouTube OAuth refresh did not return an access token");
  return json.access_token;
}

async function fetchBroadcasts(ids: string[], accessToken: string) {
  const results: YoutubeBroadcast[] = [];
  for (let index = 0; index < ids.length; index += 50) {
    const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
    url.searchParams.set("part", "id,snippet,status,contentDetails");
    url.searchParams.set("id", ids.slice(index, index + 50).join(","));
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`YouTube liveBroadcasts lookup failed with ${res.status}`);
    const json = await res.json() as { items?: YoutubeBroadcast[] };
    results.push(...(json.items ?? []));
  }
  return results;
}
