#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { chromium } from "playwright";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const BROADCAST_ID = /^[A-Za-z0-9_-]{6,32}$/u;
const PROBE_REFERER = "https://monitor.beachvolleyballmedia.com/";

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
    let browser;
    try {
      browser = await this.browserType.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
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
      await this.sleep(2_000);
      const first = await sampleVideo(video);
      const firstFrame = await video.screenshot({ type: "png" });
      await this.sleep(this.sampleDelayMs);
      const second = await sampleVideo(video);
      const secondFrame = await video.screenshot({ type: "png" });
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
      await browser?.close().catch(() => {});
    }
  }
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
