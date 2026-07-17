import assert from "node:assert/strict";
import test from "node:test";

import { rehearsalMarker, YouTubeRehearsalProvider } from "./youtube-provider.mjs";

function response(status, body = null) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function stream(marker, id = "stream1") {
  return {
    id,
    snippet: { description: marker },
    cdn: { ingestionType: "rtmp", resolution: "720p", frameRate: "30fps", ingestionInfo: { streamName: "do-not-print", rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2" } },
    contentDetails: { isReusable: false },
    status: { streamStatus: "ready", healthStatus: { status: "good", configurationIssues: [] } }
  };
}

function broadcast(marker, id = "broadcast1", boundStreamId = null) {
  return {
    id,
    snippet: { description: marker },
    status: { privacyStatus: "unlisted", lifeCycleStatus: "ready", recordingStatus: "notRecording" },
    contentDetails: { enableAutoStart: false, enableAutoStop: false, monitorStream: { enableMonitorStream: false }, boundStreamId }
  };
}

function provider(fetchImpl) {
  return new YouTubeRehearsalProvider({ clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetchImpl, sleep: async () => {} });
}

test("creates a disposable 720p30 stream and adopts it by exact marker on retry", async () => {
  const marker = rehearsalMarker("generation-1234", 1);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    if (init.method === "GET") return response(200, { items: requests.filter((entry) => entry.init.method === "POST" && entry.url.includes("liveStreams")).length ? [stream(marker)] : [] });
    return response(200, stream(marker));
  };
  const client = provider(fetchImpl);
  const first = await client.ensureStream({ court: 1, marker });
  const second = await client.ensureStream({ court: 1, marker });
  assert.equal(first.id, "stream1");
  assert.equal(second.id, "stream1");
  const create = requests.find((entry) => entry.init.method === "POST" && entry.url.includes("liveStreams"));
  const body = JSON.parse(create.init.body);
  assert.equal(body.contentDetails.isReusable, false);
  assert.equal(body.cdn.resolution, "720p");
  assert.equal(requests.filter((entry) => entry.init.method === "POST" && entry.url.includes("liveStreams")).length, 1);
});

test("creates unlisted manual broadcasts and verifies exact binding", async () => {
  const marker = rehearsalMarker("generation-1234", 2);
  let bound = false;
  const fetchImpl = async (url, init) => {
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    if (url.includes("liveBroadcasts/bind")) { bound = true; return response(200, broadcast(marker, "broadcast2", "stream2")); }
    if (url.includes("liveBroadcasts?") && init.method === "GET" && url.includes("&id=")) return response(200, { items: [broadcast(marker, "broadcast2", bound ? "stream2" : null)] });
    if (url.includes("liveBroadcasts?") && init.method === "GET") return response(200, { items: [] });
    return response(200, broadcast(marker, "broadcast2"));
  };
  const client = provider(fetchImpl);
  const created = await client.ensureBroadcast({ court: 2, marker });
  assert.equal(created.privacyStatus, "unlisted");
  const result = await client.bind({ broadcastId: "broadcast2", streamId: "stream2" });
  assert.equal(result.boundStreamId, "stream2");
});

test("bounds post-create visibility lag while preserving the exact binding", async () => {
  const marker = rehearsalMarker("generation-1234", 2);
  let boundReads = 0;
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    if (url.includes("liveBroadcasts/bind")) return response(200, broadcast(marker, "broadcast2", "stream2"));
    if (url.includes("liveBroadcasts?") && init.method === "GET" && url.includes("&id=")) {
      boundReads += 1;
      if (boundReads <= 2) return response(200, { items: [] });
      if (boundReads === 3) return response(200, { items: [broadcast(marker, "broadcast2", null)] });
      return response(200, { items: [broadcast(marker, "broadcast2", "stream2")] });
    }
    return response(200, { items: [] });
  };
  const client = new YouTubeRehearsalProvider({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    fetchImpl,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); }
  });
  const result = await client.bind({ broadcastId: "broadcast2", streamId: "stream2" });
  assert.equal(result.boundStreamId, "stream2");
  assert.equal(boundReads, 4);
  assert.deepEqual(sleeps, [1_000, 1_000, 1_000]);
});

test("does not retry a non-visibility provider failure during binding", async () => {
  let reads = 0;
  const client = provider(async (url, init) => {
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    if (url.includes("liveBroadcasts/bind")) return response(200, {});
    reads += 1;
    return response(403, { error: { errors: [{ reason: "quotaExceeded" }] } });
  });
  await assert.rejects(() => client.bind({ broadcastId: "broadcast2", streamId: "stream2" }), /HTTP 403 \(quotaExceeded\)/u);
  assert.equal(reads, 1);
});

test("retries only explicit transient YouTube rate limits with a bounded backoff", async () => {
  const marker = rehearsalMarker("generation-1234", 8);
  const sleeps = [];
  let creates = 0;
  const client = new YouTubeRehearsalProvider({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    fetchImpl: async (url, init) => {
      if (url.includes("oauth2")) return response(200, { access_token: "access" });
      if (init.method === "GET") return response(200, { items: [] });
      creates += 1;
      if (creates === 1) return response(403, { error: { errors: [{ reason: "userRequestsExceedRateLimit" }] } });
      if (creates === 2) return response(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } });
      return response(200, broadcast(marker, "broadcast8"));
    }
  });
  const created = await client.ensureBroadcast({ court: 8, marker });
  assert.equal(created.id, "broadcast8");
  assert.equal(creates, 3);
  assert.deepEqual(sleeps, [5_000, 10_000]);
});

test("bounds rate-limit retries and never retries quota exhaustion", async () => {
  const marker = rehearsalMarker("generation-1234", 8);
  const sleeps = [];
  let requests = 0;
  const limited = new YouTubeRehearsalProvider({
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    fetchImpl: async (url, init) => {
      if (url.includes("oauth2")) return response(200, { access_token: "access" });
      if (init.method === "GET") return response(200, { items: [] });
      requests += 1;
      return response(403, { error: { errors: [{ reason: "userRequestsExceedRateLimit" }] } });
    }
  });
  await assert.rejects(() => limited.ensureBroadcast({ court: 8, marker }), /userRequestsExceedRateLimit/u);
  assert.equal(requests, 8);
  assert.deepEqual(sleeps, [5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);

  let quotaRequests = 0;
  const exhausted = provider(async (url, init) => {
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    if (init.method === "GET") return response(200, { items: [] });
    quotaRequests += 1;
    return response(403, { error: { errors: [{ reason: "quotaExceeded" }] } });
  });
  await assert.rejects(() => exhausted.ensureBroadcast({ court: 8, marker }), /quotaExceeded/u);
  assert.equal(quotaRequests, 1);
});

test("fails closed on duplicate markers and unsafe broadcast settings", async () => {
  const marker = rehearsalMarker("generation-1234", 3);
  const duplicate = provider(async (url) => url.includes("oauth2")
    ? response(200, { access_token: "access" })
    : response(200, { items: [stream(marker, "one"), stream(marker, "two")] }));
  await assert.rejects(() => duplicate.ensureStream({ court: 3, marker }), /multiple rehearsal streams/);
  const unsafe = broadcast(marker);
  unsafe.status.privacyStatus = "public";
  const client = provider(async (url, init) => {
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    if (init.method === "GET") return response(200, { items: [] });
    return response(200, unsafe);
  });
  await assert.rejects(() => client.ensureBroadcast({ court: 3, marker }), /safety settings/);
});

test("deletes only exact ids and treats confirmed absence as success", async () => {
  const urls = [];
  const client = provider(async (url, init) => {
    urls.push(`${init.method} ${url}`);
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    return response(404, { error: { status: "NOT_FOUND" } });
  });
  assert.deepEqual(await client.deleteStream("stream-123"), { absent: true });
  assert.match(urls.at(-1), /DELETE .*liveStreams\?id=stream-123$/);
});
