import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const reusableStreamTitle = process.env.YOUTUBE_GATE_STREAM_TITLE?.trim() || "ScoreCheck Gate 1 Court 1";
const broadcastTitle = process.env.YOUTUBE_GATE_BROADCAST_TITLE?.trim() || "ScoreCheck Gate 1 - Court 1 Test";

const accessToken = await refreshAccessToken();
const stream = await findOrCreateStream(accessToken);
const broadcast = await findOrCreateBroadcast(accessToken);
await youtubeRequest(
  `/liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}&part=id,contentDetails`,
  accessToken,
  { method: "POST" }
);

const ingestion = stream.cdn?.ingestionInfo;
if (!ingestion?.streamName || !ingestion.rtmpsIngestionAddress) {
  throw new Error("YouTube did not return RTMPS ingestion details.");
}

await mkdir(outputDirectory, { recursive: true });
const secretPath = path.join(outputDirectory, "youtube-gate1.json");
await writeFile(secretPath, JSON.stringify({
  streamId: stream.id,
  streamName: ingestion.streamName,
  rtmpsIngestionAddress: ingestion.rtmpsIngestionAddress,
  broadcastId: broadcast.id,
  watchUrl: `https://www.youtube.com/watch?v=${broadcast.id}`
}, null, 2), { encoding: "utf8", mode: 0o600 });
await chmod(secretPath, 0o600);

await writeFile(path.join(outputDirectory, "youtube-gate1.redacted.json"), JSON.stringify({
  streamId: stream.id,
  rtmpsIngestionAddress: ingestion.rtmpsIngestionAddress,
  broadcastId: broadcast.id,
  watchUrl: `https://www.youtube.com/watch?v=${broadcast.id}`,
  privacyStatus: broadcast.status?.privacyStatus ?? "unlisted",
  autoStart: broadcast.contentDetails?.enableAutoStart ?? false,
  autoStop: broadcast.contentDetails?.enableAutoStop ?? false
}, null, 2));

console.log(`Gate 1 YouTube broadcast ready: https://www.youtube.com/watch?v=${broadcast.id}`);
console.log(`Secret RTMPS values stored in ${secretPath}.`);

async function refreshAccessToken() {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required("YOUTUBE_CLIENT_ID"),
      client_secret: required("YOUTUBE_CLIENT_SECRET"),
      refresh_token: required("YOUTUBE_REFRESH_TOKEN"),
      grant_type: "refresh_token"
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || typeof json.access_token !== "string") {
    throw new Error(`YouTube OAuth refresh failed with ${response.status}.`);
  }
  return json.access_token;
}

async function findOrCreateStream(token) {
  const listed = await youtubeRequest("/liveStreams?part=id,snippet,cdn,status,contentDetails&mine=true&maxResults=50", token);
  const existing = listed.items?.find((item) =>
    item.snippet?.title === reusableStreamTitle && item.contentDetails?.isReusable === true
  );
  if (existing) return existing;
  return youtubeRequest("/liveStreams?part=id,snippet,cdn,status,contentDetails", token, {
    method: "POST",
    body: JSON.stringify({
      snippet: {
        title: reusableStreamTitle,
        description: "Reusable ScoreCheck Gate 1 court stream. Do not delete while testing."
      },
      cdn: {
        ingestionType: "rtmp",
        resolution: "720p",
        frameRate: "30fps"
      },
      contentDetails: { isReusable: true }
    })
  });
}

async function findOrCreateBroadcast(token) {
  const listed = await youtubeRequest("/liveBroadcasts?part=id,snippet,status,contentDetails&mine=true&maxResults=50", token);
  const existing = listed.items?.find((item) =>
    item.snippet?.title === broadcastTitle && item.status?.lifeCycleStatus !== "complete"
  );
  if (existing) return existing;
  return youtubeRequest("/liveBroadcasts?part=id,snippet,status,contentDetails", token, {
    method: "POST",
    body: JSON.stringify({
      snippet: {
        title: broadcastTitle,
        description: "Unlisted ScoreCheck one-court reliability and commentary synchronization test.",
        scheduledStartTime: new Date(Date.now() + 10 * 60_000).toISOString()
      },
      status: {
        privacyStatus: "unlisted",
        selfDeclaredMadeForKids: false
      },
      contentDetails: {
        monitorStream: { enableMonitorStream: false },
        enableEmbed: true,
        enableDvr: true,
        recordFromStart: true,
        latencyPreference: "low",
        enableAutoStart: false,
        enableAutoStop: false
      }
    })
  });
}

async function youtubeRequest(resource, token, init = {}) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3${resource}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = json.error?.errors?.[0]?.reason || json.error?.status || "unknown";
    throw new Error(`YouTube API ${resource.split("?")[0]} failed with ${response.status} (${reason}).`);
  }
  return json;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
