import test from "node:test";
import assert from "node:assert/strict";

import { PNG } from "pngjs";

import { analyzePng, evaluateViewerContinuityTrace, evaluateViewerProbe, YouTubeViewerContinuitySession, YouTubeViewerProbe } from "./youtube-viewer-probe.mjs";

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

test("qualifies one continuously sampled viewer across ordered backup transitions", () => {
  const input = continuityInput();
  const result = evaluateViewerContinuityTrace(input);
  assert.equal(result.passed, true, result.problems.join("; "));
  assert.equal(result.maximumStallMs, 250);
  assert.equal(result.droppedSamples, 0);
  assert.ok(result.audioDecodedBytes > 0);
});

test("rejects a hidden transition stall, sample loss, and reordered phase evidence", () => {
  const input = continuityInput();
  for (let index = 20; index <= 40; index += 1) input.samples[index].currentTime = input.samples[19].currentTime;
  input.droppedSamples = 1;
  [input.markers[2], input.markers[3]] = [input.markers[3], input.markers[2]];
  const result = evaluateViewerContinuityTrace(input);
  assert.equal(result.passed, false);
  assert.match(result.problems.join("\n"), /stalled for more than two seconds/u);
  assert.match(result.problems.join("\n"), /bounded sample capacity/u);
  assert.match(result.problems.join("\n"), /out of order/u);
});

test("rejects malformed counters and evidence outside ordered trace timestamps", () => {
  const input = continuityInput();
  input.samples[10].audioDecodedBytes = -1;
  input.markers[4].observedAt = new Date(Date.parse(input.markers[3].observedAt) - 1).toISOString();
  input.markers[8].frame.darkPixelRatio = 2;
  input.completedAt = new Date(Date.parse(input.startedAt) - 1_000).toISOString();
  const result = evaluateViewerContinuityTrace(input);
  assert.equal(result.passed, false);
  assert.match(result.problems.join("\n"), /invalid sample/u);
  assert.match(result.problems.join("\n"), /invalid marker/u);
  assert.match(result.problems.join("\n"), /marker timestamps moved backward/u);
  assert.match(result.problems.join("\n"), /completion timestamp is not after/u);
  assert.match(result.problems.join("\n"), /outside the trace time bounds/u);
});

test("allows adaptive viewer resolution changes above the delivery floor", () => {
  const input = continuityInput();
  for (let index = 40; index < input.samples.length; index += 1) {
    input.samples[index].videoWidth = 1280;
    input.samples[index].videoHeight = 720;
  }
  const result = evaluateViewerContinuityTrace(input);
  assert.equal(result.passed, true, result.problems.join("; "));
  assert.deepEqual(result.videoDimensions, ["1920x1080", "1280x720"]);
});

test("continuity session emits a bounded report and closes its browser", async () => {
  let closed = false;
  let screenshotCount = 0;
  const input = continuityInput();
  const session = new YouTubeViewerContinuitySession({
    browser: { close: async () => { closed = true; } },
    page: { evaluate: async () => ({ samples: input.samples, droppedSamples: 0 }) },
    video: {
      evaluate: async () => sample({ currentTime: 10, audioDecodedBytes: 5_000 }),
      screenshot: async () => frame(screenshotCount++ % 2 ? [140, 80, 20] : [20, 80, 140])
    },
    camera: 1,
    broadcastId: "broadcast_1",
    traceId: `youtube-continuity-${"a".repeat(36)}`,
    sleep: async () => {},
    now: clock(Date.parse(observedAt), 1_500)
  });
  for (const label of continuityLabels().slice(0, -1)) await session.mark(label);
  const result = await session.finish();
  assert.equal(result.passed, true, result.problems.join("; "));
  assert.equal(closed, true);
  await session.close();
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

function continuityInput() {
  const start = Date.parse(observedAt);
  const samples = Array.from({ length: 81 }, (_, index) => ({
    observedAt: new Date(start + index * 250).toISOString(),
    currentTime: 10 + index * 0.25,
    readyState: 4,
    paused: false,
    videoWidth: 1920,
    videoHeight: 1080,
    audioDecodedBytes: 1_000 + index * 100
  }));
  const markers = continuityLabels().map((label, index) => ({
    label,
    observedAt: new Date(start + index * 1_500).toISOString(),
    sample: sample({ currentTime: 10 + index * 1.5, audioDecodedBytes: 1_000 + index * 600 }),
    frame: analyzePng(frame(index % 2 ? [140, 80, 20] : [20, 80, 140]))
  }));
  return {
    camera: 1,
    broadcastId: "broadcast_1",
    traceId: `youtube-continuity-${"a".repeat(36)}`,
    startedAt: observedAt,
    completedAt: new Date(start + 20_000).toISOString(),
    samples,
    droppedSamples: 0,
    markers
  };
}

function continuityLabels() {
  return [
    "baseline-start", "baseline-ready", "primary-stop-requested", "primary-stopped",
    "backup-only-verified", "primary-start-requested", "primary-restored",
    "dual-restored-verified", "backup-stop-requested", "backup-stopped",
    "primary-only-verified", "complete"
  ];
}

function clock(start, step) {
  let value = start - step;
  return () => { value += step; return value; };
}
