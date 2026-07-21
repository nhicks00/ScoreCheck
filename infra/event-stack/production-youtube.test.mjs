import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeProductionBroadcast,
  normalizeProductionStream,
  prepareProductionYouTube,
  ProductionYouTubeProvider,
  readProductionDestinations,
  redactDestinations,
  validateProductionDestinations
} from "./production-youtube.mjs";

function stream(court) {
  return {
    id: `stream-${court}`,
    court,
    title: `ScoreCheck Production Camera ${court} Auto Stream`,
    isReusable: true,
    ingestionType: "rtmp",
    resolution: "variable",
    frameRate: "variable",
    streamName: `secret-stream-key-${court}`,
    rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
    streamStatus: "inactive",
    healthStatus: null,
    configurationIssues: []
  };
}

function broadcast(event, court, streamId) {
  return {
    id: `broadcast-${court}`,
    event,
    court,
    title: `ScoreCheck ${event} - Camera ${court}`,
    watchUrl: `https://www.youtube.com/watch?v=broadcast-${court}`,
    privacyStatus: "unlisted",
    autoStart: true,
    autoStop: false,
    lifeCycleStatus: "ready",
    recordingStatus: "notRecording",
    streamId
  };
}

test("prepares a protected eight-stream pool and broadcasts only for active cameras", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-youtube-"));
  const parent = join(root, "protected");
  const output = join(parent, "destinations");
  await mkdir(parent, { mode: 0o700 });
  const calls = [];
  const provider = {
    async ensureVariableStreamPool() {
      return Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, stream(index + 1)]));
    },
    async prepareBroadcast({ event, court, streamId, scheduledStartTime }) {
      calls.push({ event, court, streamId, scheduledStartTime });
      return broadcast(event, court, streamId);
    }
  };
  try {
    const result = await prepareProductionYouTube({ provider, event: "six-camera-soak", activeCameras: [1, 2, 3, 4, 5, 6], output, now: () => 1_000_000 });
    assert.equal(Object.keys(result.streams).length, 8);
    assert.equal(Object.keys(result.broadcasts).length, 6);
    assert.equal(calls.length, 6);
    assert.equal(calls[0].scheduledStartTime, new Date(1_600_000).toISOString());
    const loaded = await readProductionDestinations(join(output, "destinations.json"), { event: "six-camera-soak", activeCameras: [1, 2, 3, 4, 5, 6] });
    assert.equal(loaded.streams[6].resolution, "variable");
    const redacted = JSON.parse(await readFile(join(output, "destinations.redacted.json"), "utf8"));
    assert.equal(redacted.streams[1].streamName, "<redacted>");
    assert.equal(redactDestinations(result).streams[8].streamName, "<redacted>");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes only the reusable variable-profile stream and safe unlisted broadcast contracts", () => {
  assert.equal(normalizeProductionStream(stream(1), 1, { requireIdle: true }).streamStatus, "inactive");
  assert.equal(normalizeProductionBroadcast(broadcast("six-camera-soak", 1, "stream-1"), "six-camera-soak", 1).autoStop, false);

  assert.throws(() => normalizeProductionStream({ ...stream(1), resolution: "1080p" }, 1), /variable-profile/);
  assert.throws(() => normalizeProductionStream({ ...stream(1), streamStatus: "active" }, 1, { requireIdle: true }), /not idle/);
  assert.throws(() => normalizeProductionBroadcast({ ...broadcast("six-camera-soak", 1, "stream-1"), privacyStatus: "public" }), /safety settings/);
});

test("rejects duplicate reusable stream identities in a loaded destination contract", () => {
  const value = {
    schemaVersion: 1,
    event: "six-camera-soak",
    activeCameras: [1],
    streams: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, stream(index + 1)])),
    broadcasts: { 1: broadcast("six-camera-soak", 1, "stream-1") }
  };
  value.streams[2].id = value.streams[1].id;
  assert.throws(() => validateProductionDestinations(value), /stream identities are not unique/);
});

test("fails closed when an existing destination contract changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-youtube-"));
  const parent = join(root, "protected");
  const output = join(parent, "destinations");
  await mkdir(parent, { mode: 0o700 });
  const provider = {
    async ensureVariableStreamPool() { return Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, stream(index + 1)])); },
    async prepareBroadcast({ event, court, streamId }) { return broadcast(event, court, streamId); }
  };
  try {
    await prepareProductionYouTube({ provider, event: "six-camera-soak", activeCameras: [1, 2, 3, 4, 5, 6], output });
    await assert.rejects(
      () => prepareProductionYouTube({ provider, event: "six-camera-soak", activeCameras: [1, 2, 3], output }),
      /active camera set changed/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes the YouTube access token before it expires during a multi-hour soak", async () => {
  let now = 1_000_000;
  let tokenRequests = 0;
  const provider = new ProductionYouTubeProvider({
    clientId: "client-id",
    clientSecret: "client-secret",
    refreshToken: "refresh-token",
    now: () => now,
    fetchImpl: async (url) => {
      if (url !== "https://oauth2.googleapis.com/token") throw new Error(`unexpected URL ${url}`);
      tokenRequests += 1;
      return {
        ok: true,
        status: 200,
        async json() { return { access_token: `token-${tokenRequests}`, expires_in: 3_600 }; }
      };
    }
  });

  assert.equal(await provider.token(), "token-1");
  now += 3_000_000;
  assert.equal(await provider.token(), "token-1");
  now += 550_000;
  assert.equal(await provider.token(), "token-2");
  assert.equal(tokenRequests, 2);
});
