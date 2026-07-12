import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const courtNumbers = Array.from({ length: 8 }, (_, index) => index + 1);

const accessToken = await refreshAccessToken();
const existingStreams = await listYouTubeItems(
  "/liveStreams?part=id,snippet,cdn,status,contentDetails&mine=true&maxResults=50",
  accessToken
);
const existingBroadcasts = await listYouTubeItems(
  "/liveBroadcasts?part=id,snippet,status,contentDetails&mine=true&maxResults=50",
  accessToken
);

const destinations = [];
for (const courtNumber of courtNumbers) {
  const streamTitle = `ScoreCheck Court ${courtNumber} Test Stream`;
  const broadcastTitle = `ScoreCheck Eight-Camera Test - Court ${courtNumber}`;
  const stream = await findOrCreateStream(accessToken, existingStreams, streamTitle, courtNumber);
  const broadcast = await findOrCreateBroadcast(
    accessToken,
    existingBroadcasts,
    broadcastTitle,
    courtNumber
  );

  await youtubeRequest(
    `/liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}&part=id,contentDetails`,
    accessToken,
    { method: "POST" }
  );

  const ingestion = stream.cdn?.ingestionInfo;
  if (!ingestion?.streamName || !ingestion.rtmpsIngestionAddress) {
    throw new Error(`YouTube did not return RTMPS ingestion details for court ${courtNumber}.`);
  }

  destinations.push({
    courtNumber,
    streamId: stream.id,
    streamName: ingestion.streamName,
    rtmpsIngestionAddress: ingestion.rtmpsIngestionAddress,
    broadcastId: broadcast.id,
    watchUrl: `https://www.youtube.com/watch?v=${broadcast.id}`,
    privacyStatus: broadcast.status?.privacyStatus ?? "unlisted",
    autoStart: broadcast.contentDetails?.enableAutoStart ?? false,
    autoStop: broadcast.contentDetails?.enableAutoStop ?? false
  });
}

await mkdir(outputDirectory, { recursive: true });
const secretPath = path.join(outputDirectory, "youtube-gate8.json");
await writeFile(secretPath, JSON.stringify({ destinations }, null, 2), {
  encoding: "utf8",
  mode: 0o600
});
await chmod(secretPath, 0o600);

const redactedPath = path.join(outputDirectory, "youtube-gate8.redacted.json");
await writeFile(redactedPath, JSON.stringify({
  destinations: destinations.map(({ streamName: _streamName, ...destination }) => destination)
}, null, 2));

console.log("Eight-court YouTube destinations are ready:");
for (const destination of destinations) {
  console.log(`  Court ${destination.courtNumber}: ${destination.watchUrl}`);
}
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

async function listYouTubeItems(resource, token) {
  const items = [];
  let pageToken;
  do {
    const separator = resource.includes("?") ? "&" : "?";
    const page = await youtubeRequest(
      `${resource}${pageToken ? `${separator}pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      token
    );
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function findOrCreateStream(token, existingStreams, title, courtNumber) {
  const existing = existingStreams.find((item) =>
    item.snippet?.title === title && item.contentDetails?.isReusable === true
  );
  if (existing) return existing;

  const created = await youtubeRequest(
    "/liveStreams?part=id,snippet,cdn,status,contentDetails",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        snippet: {
          title,
          description: `Reusable ScoreCheck Court ${courtNumber} test stream. Do not delete while testing.`
        },
        cdn: {
          ingestionType: "rtmp",
          resolution: "720p",
          frameRate: "30fps"
        },
        contentDetails: { isReusable: true }
      })
    }
  );
  existingStreams.push(created);
  return created;
}

async function findOrCreateBroadcast(token, existingBroadcasts, title, courtNumber) {
  const existing = existingBroadcasts.find((item) =>
    item.snippet?.title === title && item.status?.lifeCycleStatus !== "complete"
  );
  if (existing) return existing;

  const created = await youtubeRequest(
    "/liveBroadcasts?part=id,snippet,status,contentDetails",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        snippet: {
          title,
          description: `Unlisted ScoreCheck eight-camera reliability test for Court ${courtNumber}.`,
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
    }
  );
  existingBroadcasts.push(created);
  return created;
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
