import assert from "node:assert/strict";
import test from "node:test";

import { persistentStreamTitle, rehearsalMarker, YouTubeRehearsalProvider } from "./youtube-provider.mjs";

function response(status, body = null) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function stream(court, overrides = {}) {
  return {
    id: `stream${court}`,
    snippet: { title: persistentStreamTitle(court) },
    cdn: {
      ingestionType: "rtmp",
      resolution: "variable",
      frameRate: "variable",
      ingestionInfo: { streamName: `protected-key-${court}`, rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2" }
    },
    contentDetails: { isReusable: true },
    status: { streamStatus: "inactive", healthStatus: { status: "noData", configurationIssues: [] } },
    ...overrides
  };
}

function provider(fetchImpl, sleep = async () => {}) {
  return new YouTubeRehearsalProvider({ clientId: "client", clientSecret: "secret", refreshToken: "refresh", fetchImpl, sleep });
}

test("adopts the exact persistent reusable eight-stream pool without provider mutations", async () => {
  const requests = [];
  const client = provider(async (url, init) => {
    requests.push({ url, method: init.method });
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    return response(200, { items: Array.from({ length: 8 }, (_, index) => stream(index + 1)) });
  });

  const pool = await client.resolvePersistentStreamPool();

  assert.deepEqual(Object.keys(pool), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(pool[1].title, "ScoreCheck Production Camera 1 Auto Stream");
  assert.equal(pool[8].isReusable, true);
  assert.equal(pool[8].streamStatus, "inactive");
  assert.equal(requests.filter((entry) => entry.url.includes("youtube/v3")).every((entry) => entry.method === "GET"), true);
  assert.equal(typeof client.deleteStream, "undefined");
  assert.equal(typeof client.ensureBroadcast, "undefined");
});

test("fails closed on missing, duplicate, active, unsafe, or nonunique persistent streams", async () => {
  const listProvider = (items) => provider(async (url) => url.includes("oauth2")
    ? response(200, { access_token: "access" })
    : response(200, { items }));
  const complete = Array.from({ length: 8 }, (_, index) => stream(index + 1));

  await assert.rejects(() => listProvider(complete.slice(0, 7)).resolvePersistentStreamPool(), /exactly one persistent rehearsal stream titled ScoreCheck Production Camera 8 Auto Stream; observed 0/u);
  await assert.rejects(() => listProvider([...complete, stream(4, { id: "duplicate4" })]).resolvePersistentStreamPool(), /observed 2/u);

  const active = structuredClone(complete);
  active[0].status.streamStatus = "active";
  await assert.rejects(() => listProvider(active).resolvePersistentStreamPool(), /not idle/u);

  const disposable = structuredClone(complete);
  disposable[1].contentDetails.isReusable = false;
  await assert.rejects(() => listProvider(disposable).resolvePersistentStreamPool(), /profile is invalid/u);

  const duplicateKey = structuredClone(complete);
  duplicateKey[7].cdn.ingestionInfo.streamName = duplicateKey[6].cdn.ingestionInfo.streamName;
  await assert.rejects(() => listProvider(duplicateKey).resolvePersistentStreamPool(), /identities are not unique/u);
});

test("waits for one exact persistent stream to become active", async () => {
  let reads = 0;
  const sleeps = [];
  const client = provider(async (url) => {
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    reads += 1;
    const value = stream(3);
    value.status.streamStatus = reads < 3 ? "inactive" : "active";
    value.status.healthStatus.status = reads < 3 ? "noData" : "good";
    return response(200, { items: [value] });
  }, async (milliseconds) => { sleeps.push(milliseconds); });

  const active = await client.waitForStream({ streamId: "stream3", streamStatus: "active", timeoutMs: 10_000, intervalMs: 250 });

  assert.equal(active.streamStatus, "active");
  assert.equal(active.healthStatus, "good");
  assert.equal(reads, 3);
  assert.deepEqual(sleeps, [250, 250]);
});

test("retries only explicit transient YouTube rate limits on reads", async () => {
  const sleeps = [];
  let reads = 0;
  const client = provider(async (url) => {
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    reads += 1;
    if (reads === 1) return response(403, { error: { errors: [{ reason: "userRequestsExceedRateLimit" }] } });
    if (reads === 2) return response(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } });
    return response(200, { items: Array.from({ length: 8 }, (_, index) => stream(index + 1)) });
  }, async (milliseconds) => { sleeps.push(milliseconds); });

  assert.equal(Object.keys(await client.resolvePersistentStreamPool()).length, 8);
  assert.equal(reads, 3);
  assert.deepEqual(sleeps, [5_000, 10_000]);

  let quotaReads = 0;
  const quota = provider(async (url) => {
    if (url.includes("oauth2")) return response(200, { access_token: "access" });
    quotaReads += 1;
    return response(403, { error: { errors: [{ reason: "quotaExceeded" }] } });
  });
  await assert.rejects(() => quota.resolvePersistentStreamPool(), /quotaExceeded/u);
  assert.equal(quotaReads, 1);
});

test("retains rehearsal markers for non-provider workload ownership", () => {
  assert.equal(rehearsalMarker("generation-1234", 7), "[scorecheck-rehearsal:generation-1234:court-7]");
  assert.throws(() => persistentStreamTitle(9), /court is invalid/u);
});
