import test from "node:test";
import assert from "node:assert/strict";

import { PNG } from "pngjs";

import { analyzePng, evaluateViewerProbe, YouTubeViewerProbe } from "./youtube-viewer-probe.mjs";

const observedAt = "2026-07-21T12:00:00.000Z";

test("qualifies advancing nonblack YouTube playback with decoded audio", () => {
  const result = evaluateViewerProbe({
    camera: 1,
    broadcastId: "broadcast_1",
    observedAt,
    first: sample({ currentTime: 10, audioDecodedBytes: 1_000 }),
    second: sample({ currentTime: 18, audioDecodedBytes: 5_000 }),
    firstFrame: frame([20, 80, 140]),
    secondFrame: frame([140, 80, 20]),
    elapsedMs: 8_000
  });
  assert.equal(result.passed, true);
  assert.equal(result.playheadDeltaSeconds, 8);
  assert.equal(result.audioBytesDelta, 4_000);
  assert.notEqual(result.frames[0].sha256, result.frames[1].sha256);
});

test("rejects frozen, black, stalled, silent, or dimension-changing playback", () => {
  const black = frame([0, 0, 0], 0);
  const result = evaluateViewerProbe({
    camera: 2,
    broadcastId: "broadcast_2",
    observedAt,
    first: sample({ currentTime: 10, audioDecodedBytes: 1_000 }),
    second: sample({ currentTime: 10.1, audioDecodedBytes: 1_000, videoWidth: 1280 }),
    firstFrame: black,
    secondFrame: black,
    elapsedMs: 8_000
  });
  assert.equal(result.passed, false);
  assert.ok(result.problems.includes("viewer playhead did not advance in real time"));
  assert.ok(result.problems.includes("viewer frames did not change"));
  assert.ok(result.problems.includes("viewer frame was black or visually blank"));
  assert.ok(result.problems.includes("viewer audio did not decode"));
  assert.ok(result.problems.includes("viewer video dimensions were unavailable or changed"));
});

test("closes the temporary browser and returns a bounded failure instead of throwing", async () => {
  let closed = false;
  let contextOptions;
  const probe = new YouTubeViewerProbe({
    browserType: { launch: async () => ({
      newContext: async (options) => {
        contextOptions = options;
        return { newPage: async () => ({ goto: async () => { throw new Error("provider unavailable with secret=hidden"); } }) };
      },
      close: async () => { closed = true; }
    }) },
    sleep: async () => {}
  });
  const result = await probe.probe({ camera: 3, broadcastId: "broadcast_3" });
  assert.equal(result.passed, false);
  assert.equal(closed, true);
  assert.equal(contextOptions.extraHTTPHeaders.referer, "https://monitor.beachvolleyballmedia.com/");
  assert.match(result.problems[0], /viewer probe failed/u);
});

test("calculates bounded frame luma without retaining pixels", () => {
  const result = analyzePng(frame([100, 120, 140]));
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(result.meanLuma > 0);
  assert.ok(result.darkPixelRatio < 1);
  assert.deepEqual(Object.keys(result).sort(), ["darkPixelRatio", "lumaVariance", "meanLuma", "sha256"]);
});

function sample(overrides = {}) {
  return { currentTime: 0, readyState: 4, paused: false, videoWidth: 1920, videoHeight: 1080, audioDecodedBytes: 0, ...overrides };
}

function frame(rgb, variation = 8) {
  const png = new PNG({ width: 16, height: 16 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const varied = ((offset / 4) % 16) * variation;
    png.data[offset] = Math.min(255, rgb[0] + varied);
    png.data[offset + 1] = rgb[1];
    png.data[offset + 2] = rgb[2];
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}
