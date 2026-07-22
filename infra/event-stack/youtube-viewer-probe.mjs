#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { chromium } from "playwright";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BROADCAST_ID = /^[A-Za-z0-9_-]{6,32}$/u;
const PROBE_REFERER = "https://monitor.beachvolleyballmedia.com/";
const CONTINUITY_SAMPLE_INTERVAL_MS = 250;
const CONTINUITY_MAX_SAMPLES = 2_400;
const CONTINUITY_MINIMUM_DURATION_MS = 15_000;
const CONTINUITY_MAXIMUM_SAMPLE_GAP_MS = 1_000;
const CONTINUITY_MAXIMUM_STALL_MS = 2_000;
const CONTINUITY_TIMESTAMP_SKEW_MS = 2_000;
const CONTINUITY_MARKERS = [
  "baseline-start",
  "baseline-ready",
  "primary-stop-requested",
  "primary-stopped",
  "backup-only-verified",
  "primary-start-requested",
  "primary-restored",
  "dual-restored-verified",
  "backup-stop-requested",
  "backup-stopped",
  "primary-only-verified",
  "complete"
];

export class YouTubeViewerProbe {
  constructor({ browserType = chromium, sleep = delay, sampleDelayMs = 8_000 } = {}) {
    this.browserType = browserType;
    this.sleep = sleep;
    this.sampleDelayMs = sampleDelayMs;
  }

  async probe({ camera, broadcastId }) {
    validateCamera(camera);
    if (!BROADCAST_ID.test(broadcastId ?? "")) throw new Error("YouTube broadcast id is invalid");
    const observedAt = new Date().toISOString();
    let viewer;
    try {
      viewer = await openViewer({ browserType: this.browserType, broadcastId });
      await this.sleep(2_000);
      const first = await sampleVideo(viewer.video);
      const firstFrame = await viewer.video.screenshot({ type: "png" });
      await this.sleep(this.sampleDelayMs);
      const second = await sampleVideo(viewer.video);
      const secondFrame = await viewer.video.screenshot({ type: "png" });
      return evaluateViewerProbe({ camera, broadcastId, observedAt, first, second, firstFrame, secondFrame, elapsedMs: this.sampleDelayMs });
    } catch (error) {
      return {
        schemaVersion: 1,
        camera,
        broadcastId,
        observedAt,
        passed: false,
        problems: [`viewer probe failed: ${safeError(error)}`]
      };
    } finally {
      await viewer?.browser.close().catch(() => {});
    }
  }

  async startContinuity({ camera, broadcastId }) {
    validateCamera(camera);
    if (!BROADCAST_ID.test(broadcastId ?? "")) throw new Error("YouTube broadcast id is invalid");
    let viewer;
    try {
      viewer = await openViewer({ browserType: this.browserType, broadcastId });
      await installContinuityCollector(viewer.page);
      const session = new YouTubeViewerContinuitySession({
        ...viewer,
        camera,
        broadcastId,
        traceId: `youtube-continuity-${randomUUID()}`,
        sleep: this.sleep
      });
      await session.mark("baseline-start");
      await this.sleep(2_000);
      await session.mark("baseline-ready");
      return session;
    } catch (error) {
      await viewer?.browser.close().catch(() => {});
      throw new Error(`continuous viewer could not start: ${safeError(error)}`);
    }
  }
}

export class YouTubeViewerContinuitySession {
  constructor({ browser, page, video, camera, broadcastId, traceId, sleep = delay, now = Date.now }) {
    this.browser = browser;
    this.page = page;
    this.video = video;
    this.camera = camera;
    this.broadcastId = broadcastId;
    this.traceId = traceId;
    this.sleep = sleep;
    this.now = now;
    this.startedAt = new Date(this.now()).toISOString();
    this.markers = [];
    this.closed = false;
  }

  status() {
    return { schemaVersion: 1, label: "continuity", traceId: this.traceId, camera: this.camera, broadcastId: this.broadcastId, startedAt: this.startedAt, status: "RUNNING", passed: false, problems: ["continuous viewer trace is still running"] };
  }

  async mark(label) {
    if (this.closed) throw new Error("continuous viewer session is closed");
    if (!CONTINUITY_MARKERS.includes(label) || this.markers.some((entry) => entry.label === label)) throw new Error(`continuous viewer marker ${label} is invalid or duplicated`);
    const frame = analyzePng(await this.video.screenshot({ type: "png" }));
    const sample = await sampleVideo(this.video);
    const marker = { label, observedAt: new Date(this.now()).toISOString(), sample, frame };
    this.markers.push(marker);
    return marker;
  }

  async finish() {
    if (this.closed) throw new Error("continuous viewer session is closed");
    try {
      await this.mark("complete");
      await this.sleep(CONTINUITY_SAMPLE_INTERVAL_MS);
      const collected = await this.page.evaluate(() => {
        const trace = window.__scorecheckYoutubeContinuity;
        if (!trace || typeof trace.stop !== "function") return null;
        return trace.stop();
      });
      return evaluateViewerContinuityTrace({
        camera: this.camera,
        broadcastId: this.broadcastId,
        traceId: this.traceId,
        startedAt: this.startedAt,
        completedAt: new Date(this.now()).toISOString(),
        samples: collected?.samples,
        droppedSamples: collected?.droppedSamples,
        markers: this.markers
      });
    } catch (error) {
      return failedContinuityTrace({ camera: this.camera, broadcastId: this.broadcastId, traceId: this.traceId, startedAt: this.startedAt, problem: `continuous viewer trace failed: ${safeError(error)}` });
    } finally {
      await this.close();
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.page.evaluate(() => window.__scorecheckYoutubeContinuity?.stop?.()).catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

export function evaluateViewerContinuityTrace({ camera, broadcastId, traceId, startedAt, completedAt, samples, droppedSamples, markers }) {
  validateCamera(camera);
  if (!BROADCAST_ID.test(broadcastId ?? "") || !/^youtube-continuity-[a-f0-9-]{36}$/u.test(traceId ?? "")) throw new Error("continuous viewer identity is invalid");
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) throw new Error("continuous viewer timestamps are invalid");
  const problems = [];
  if (completedAtMs <= startedAtMs) problems.push("continuous viewer completion timestamp is not after its start");
  if (!Array.isArray(samples) || samples.length < 20) problems.push("continuous viewer trace has too few samples");
  if (!Array.isArray(markers)) problems.push("continuous viewer trace markers are missing");
  if (!Number.isInteger(droppedSamples) || droppedSamples < 0) problems.push("continuous viewer dropped-sample count is invalid");
  else if (droppedSamples > 0) problems.push("continuous viewer trace exceeded its bounded sample capacity");
  const normalizedSamples = Array.isArray(samples) ? samples.map(normalizeContinuitySample) : [];
  const normalizedMarkers = Array.isArray(markers) ? markers.map(normalizeContinuityMarker) : [];
  if (normalizedSamples.some((entry) => entry === null)) problems.push("continuous viewer trace contains an invalid sample");
  if (normalizedMarkers.some((entry) => entry === null)) problems.push("continuous viewer trace contains an invalid marker");
  const validSamples = normalizedSamples.filter(Boolean);
  const validMarkers = normalizedMarkers.filter(Boolean);
  const markerLabels = validMarkers.map((entry) => entry.label);
  if (JSON.stringify(markerLabels) !== JSON.stringify(CONTINUITY_MARKERS)) problems.push("continuous viewer transition markers are missing, duplicated, or out of order");
  const sampleTimes = validSamples.map((entry) => Date.parse(entry.observedAt));
  const markerTimes = validMarkers.map((entry) => Date.parse(entry.observedAt));
  if (!nondecreasing(markerTimes)) problems.push("continuous viewer marker timestamps moved backward");
  if ([...sampleTimes, ...markerTimes].some((value) => value < startedAtMs - CONTINUITY_TIMESTAMP_SKEW_MS || value > completedAtMs + CONTINUITY_TIMESTAMP_SKEW_MS)) {
    problems.push("continuous viewer evidence falls outside the trace time bounds");
  }
  const durationMs = sampleTimes.length > 1 ? sampleTimes.at(-1) - sampleTimes[0] : 0;
  if (durationMs < CONTINUITY_MINIMUM_DURATION_MS) problems.push("continuous viewer trace is shorter than 15 seconds");
  let maximumSampleGapMs = 0;
  let maximumStallMs = 0;
  let playheadRegression = false;
  let lastAdvanceAt = sampleTimes[0] ?? 0;
  let audioDecodedBytes = 0;
  let audioCounterResets = 0;
  for (let index = 1; index < validSamples.length; index += 1) {
    const elapsed = sampleTimes[index] - sampleTimes[index - 1];
    if (!Number.isFinite(elapsed) || elapsed <= 0) problems.push("continuous viewer sample timestamps are not strictly increasing");
    else maximumSampleGapMs = Math.max(maximumSampleGapMs, elapsed);
    const previous = validSamples[index - 1];
    const current = validSamples[index];
    if (current.currentTime + 0.25 < previous.currentTime) playheadRegression = true;
    if (current.currentTime > previous.currentTime + 0.01) {
      maximumStallMs = Math.max(maximumStallMs, sampleTimes[index] - lastAdvanceAt);
      lastAdvanceAt = sampleTimes[index];
    }
    if (current.audioDecodedBytes >= previous.audioDecodedBytes) audioDecodedBytes += current.audioDecodedBytes - previous.audioDecodedBytes;
    else {
      audioCounterResets += 1;
      audioDecodedBytes += current.audioDecodedBytes;
    }
  }
  if (sampleTimes.length) maximumStallMs = Math.max(maximumStallMs, sampleTimes.at(-1) - lastAdvanceAt);
  if (maximumSampleGapMs > CONTINUITY_MAXIMUM_SAMPLE_GAP_MS) problems.push("continuous viewer sampling had a gap over one second");
  if (maximumStallMs > CONTINUITY_MAXIMUM_STALL_MS) problems.push("continuous viewer playhead stalled for more than two seconds");
  if (playheadRegression) problems.push("continuous viewer playhead moved backward");
  const playheadDeltaSeconds = validSamples.length > 1 ? validSamples.at(-1).currentTime - validSamples[0].currentTime : 0;
  if (durationMs > 0 && playheadDeltaSeconds < durationMs / 1_000 * 0.85) problems.push("continuous viewer playhead did not advance for at least 85 percent of the transition");
  if (audioDecodedBytes <= 0) problems.push("continuous viewer decoded no audio during the transition");
  if (validSamples.some((entry) => entry.readyState < 3 || entry.paused)) problems.push("continuous viewer was paused or not playback-ready during the transition");
  const dimensions = [...new Set(validSamples.map((entry) => `${entry.videoWidth}x${entry.videoHeight}`))];
  if (validSamples.some((entry) => entry.videoWidth < 640 || entry.videoHeight < 360)) problems.push("continuous viewer dimensions were unavailable or below the accepted floor");
  const visuals = validMarkers.map((entry) => entry.frame);
  if (visuals.some((entry) => entry.darkPixelRatio > 0.98 || entry.lumaVariance < 2)) problems.push("continuous viewer phase frame was black or visually blank");
  if (new Set(visuals.map((entry) => entry.sha256)).size < 2) problems.push("continuous viewer phase frames did not change");
  return {
    schemaVersion: 1,
    label: "continuity",
    camera,
    broadcastId,
    traceId,
    startedAt,
    completedAt,
    sampledForMs: durationMs,
    sampleCount: validSamples.length,
    droppedSamples,
    maximumSampleGapMs,
    maximumStallMs,
    playheadDeltaSeconds,
    audioDecodedBytes,
    audioCounterResets,
    videoDimensions: dimensions,
    markers: validMarkers,
    samples: validSamples,
    problems: [...new Set(problems)],
    status: problems.length ? "FAILED" : "COMPLETE",
    passed: problems.length === 0
  };
}

async function openViewer({ browserType, broadcastId }) {
  const browser = await browserType.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      locale: "en-US",
      extraHTTPHeaders: { referer: PROBE_REFERER }
    });
    const page = await context.newPage();
    await page.goto(`https://www.youtube-nocookie.com/embed/${broadcastId}?autoplay=1&mute=1&playsinline=1&controls=0`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    const video = page.locator("video").first();
    await video.waitFor({ state: "attached", timeout: 30_000 });
    await video.evaluate(async (element) => {
      if (!element.paused) return;
      try {
        await element.play();
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== "AbortError") throw error;
      }
    });
    await page.waitForFunction(() => {
      const element = document.querySelector("video");
      return element instanceof HTMLVideoElement && element.readyState >= 3 && !element.paused && element.currentTime > 0;
    }, null, { timeout: 30_000 });
    return { browser, context, page, video };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function installContinuityCollector(page) {
  await page.evaluate(({ intervalMs, maximumSamples }) => {
    const read = () => {
      const element = document.querySelector("video");
      if (!(element instanceof HTMLVideoElement)) return { observedAt: new Date().toISOString(), missing: true };
      return {
        observedAt: new Date().toISOString(),
        currentTime: element.currentTime,
        readyState: element.readyState,
        paused: element.paused,
        videoWidth: element.videoWidth,
        videoHeight: element.videoHeight,
        audioDecodedBytes: Number(element.webkitAudioDecodedByteCount)
      };
    };
    const trace = {
      samples: [],
      droppedSamples: 0,
      stopped: false,
      timer: 0,
      push() {
        this.samples.push(read());
        if (this.samples.length > maximumSamples) {
          this.samples.shift();
          this.droppedSamples += 1;
        }
      },
      stop() {
        if (!this.stopped) {
          this.stopped = true;
          window.clearInterval(this.timer);
          this.push();
        }
        return { samples: this.samples, droppedSamples: this.droppedSamples };
      }
    };
    trace.push();
    trace.timer = window.setInterval(() => trace.push(), intervalMs);
    window.__scorecheckYoutubeContinuity = trace;
  }, { intervalMs: CONTINUITY_SAMPLE_INTERVAL_MS, maximumSamples: CONTINUITY_MAX_SAMPLES });
}

function normalizeContinuitySample(value) {
  if (!value || value.missing === true || !Number.isFinite(Date.parse(value.observedAt ?? ""))) return null;
  for (const field of ["currentTime", "readyState", "videoWidth", "videoHeight", "audioDecodedBytes"]) if (!Number.isFinite(value[field])) return null;
  if (value.currentTime < 0 || !Number.isInteger(value.readyState) || value.readyState < 0 || value.readyState > 4
    || !Number.isInteger(value.videoWidth) || value.videoWidth < 0 || !Number.isInteger(value.videoHeight) || value.videoHeight < 0
    || !Number.isInteger(value.audioDecodedBytes) || value.audioDecodedBytes < 0 || typeof value.paused !== "boolean") return null;
  return {
    observedAt: value.observedAt,
    currentTime: value.currentTime,
    readyState: value.readyState,
    paused: value.paused,
    videoWidth: value.videoWidth,
    videoHeight: value.videoHeight,
    audioDecodedBytes: value.audioDecodedBytes
  };
}

function normalizeContinuityMarker(value) {
  const sample = normalizeContinuitySample({ ...value?.sample, observedAt: value?.observedAt });
  const frame = value?.frame;
  if (!CONTINUITY_MARKERS.includes(value?.label) || !sample || !frame || !/^[a-f0-9]{64}$/u.test(frame.sha256 ?? "")
    || !Number.isFinite(frame.meanLuma) || frame.meanLuma < 0 || frame.meanLuma > 255
    || !Number.isFinite(frame.lumaVariance) || frame.lumaVariance < 0
    || !Number.isFinite(frame.darkPixelRatio) || frame.darkPixelRatio < 0 || frame.darkPixelRatio > 1) return null;
  return { label: value.label, observedAt: value.observedAt, sample, frame };
}

function nondecreasing(values) {
  return values.every((value, index) => index === 0 || value >= values[index - 1]);
}

function failedContinuityTrace({ camera, broadcastId, traceId, startedAt, problem }) {
  return {
    schemaVersion: 1,
    label: "continuity",
    camera,
    broadcastId,
    traceId,
    startedAt,
    completedAt: new Date().toISOString(),
    status: "FAILED",
    passed: false,
    problems: [problem]
  };
}

export function evaluateViewerProbe({ camera, broadcastId, observedAt, first, second, firstFrame, secondFrame, elapsedMs }) {
  validateCamera(camera);
  if (!BROADCAST_ID.test(broadcastId ?? "")) throw new Error("YouTube broadcast id is invalid");
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("viewer probe timestamp is invalid");
  if (!Buffer.isBuffer(firstFrame) || !Buffer.isBuffer(secondFrame)) throw new Error("viewer probe frames are invalid");
  if (!Number.isFinite(elapsedMs) || elapsedMs < 5_000 || elapsedMs > 30_000) throw new Error("viewer probe interval is invalid");
  const firstVisual = analyzePng(firstFrame);
  const secondVisual = analyzePng(secondFrame);
  const playheadDeltaSeconds = number(second?.currentTime) - number(first?.currentTime);
  const audioBytesDelta = number(second?.audioDecodedBytes) - number(first?.audioDecodedBytes);
  const problems = [];
  if (first?.readyState < 3 || second?.readyState < 3 || first?.paused || second?.paused) problems.push("viewer playback was not continuously ready and playing");
  if (first?.videoWidth < 640 || first?.videoHeight < 360 || second?.videoWidth !== first?.videoWidth || second?.videoHeight !== first?.videoHeight) problems.push("viewer video dimensions were unavailable or changed");
  if (playheadDeltaSeconds < elapsedMs / 1_000 * 0.8) problems.push("viewer playhead did not advance in real time");
  if (firstVisual.sha256 === secondVisual.sha256) problems.push("viewer frames did not change");
  if (firstVisual.darkPixelRatio > 0.98 || secondVisual.darkPixelRatio > 0.98 || firstVisual.lumaVariance < 2 || secondVisual.lumaVariance < 2) problems.push("viewer frame was black or visually blank");
  if (!Number.isFinite(audioBytesDelta) || audioBytesDelta <= 0) problems.push("viewer audio did not decode");
  return {
    schemaVersion: 1,
    camera,
    broadcastId,
    observedAt,
    sampledForMs: elapsedMs,
    playheadDeltaSeconds,
    audioBytesDelta,
    video: { width: second.videoWidth, height: second.videoHeight },
    frames: [firstVisual, secondVisual],
    problems,
    passed: problems.length === 0
  };
}

export function analyzePng(buffer) {
  const png = PNG.sync.read(buffer, { skipRescale: true });
  if (!png.width || !png.height || png.data.length !== png.width * png.height * 4) throw new Error("viewer frame PNG is invalid");
  let sum = 0;
  let squared = 0;
  let dark = 0;
  const pixels = png.width * png.height;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const luma = (png.data[offset] * 0.2126) + (png.data[offset + 1] * 0.7152) + (png.data[offset + 2] * 0.0722);
    sum += luma;
    squared += luma * luma;
    if (luma < 12) dark += 1;
  }
  const meanLuma = sum / pixels;
  return {
    sha256: createHash("sha256").update(buffer).digest("hex"),
    meanLuma,
    lumaVariance: Math.max(0, (squared / pixels) - (meanLuma * meanLuma)),
    darkPixelRatio: dark / pixels
  };
}

async function sampleVideo(locator) {
  return locator.evaluate((element) => ({
    currentTime: element.currentTime,
    readyState: element.readyState,
    paused: element.paused,
    videoWidth: element.videoWidth,
    videoHeight: element.videoHeight,
    audioDecodedBytes: Number(element.webkitAudioDecodedByteCount)
  }));
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]+/gu, " ").slice(0, 240);
}

function validateCamera(camera) {
  if (!Number.isInteger(camera) || camera < 1 || camera > 8) throw new Error("viewer probe camera must be 1-8");
}

if (process.argv[1] === SCRIPT_PATH) {
  const camera = Number(process.argv[2]);
  const broadcastId = process.argv[3];
  new YouTubeViewerProbe().probe({ camera, broadcastId }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`error: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
