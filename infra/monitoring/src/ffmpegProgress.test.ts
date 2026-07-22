import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FfmpegBranchSnapshot } from "./contracts.js";
import { collectFfmpegProgress, FfmpegSpeedDeriver, parseKeyValues } from "./ffmpegProgress.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("FFmpeg progress parser", () => {
  it("accepts only bounded numeric progress fields", () => {
    const values = parseKeyValues([
      "frame=1800",
      "fps=29.97",
      "bitrate_kbps=2510.4",
      "stream_url=rtmps://secret.example/key",
      "bad-key=1",
      "speed=1.00"
    ].join("\n"));
    expect(Object.fromEntries(values)).toEqual({
      frame: "1800",
      fps: "29.97",
      bitrate_kbps: "2510.4",
      speed: "1.00"
    });
  });

  it("distinguishes a missing telemetry directory from a configured-disabled collector", async () => {
    await expect(collectFfmpegProgress(null)).resolves.toEqual([]);
    await expect(collectFfmpegProgress(path.join(tmpdir(), `missing-scorecheck-${Date.now()}`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads a current bounded progress file from the shared telemetry directory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scorecheck-progress-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "court1_preview.progress"), [
      "frame=1800",
      "fps=30.01",
      "bitrate_kbps=2510.4",
      "out_time_us=60000000",
      "dup_frames=0",
      "drop_frames=0",
      "speed=1.00"
    ].join("\n"));

    await expect(collectFfmpegProgress(directory)).resolves.toMatchObject([{
      name: "court1_preview",
      courtNumber: 1,
      branch: "preview",
      framesPerSecond: 30.01,
      droppedFrames: 0,
      duplicatedFrames: 0,
      speedRatio: 1
    }]);
  });

  it("reads compositor-local HEVC normalizer cadence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scorecheck-normalizer-progress-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "court2_normalizer.progress"), [
      "frame=3600",
      "fps=59.94",
      "bitrate_kbps=12000.0",
      "out_time_us=60000000",
      "dup_frames=0",
      "drop_frames=0",
      "speed=1.00"
    ].join("\n"));

    await expect(collectFfmpegProgress(directory)).resolves.toMatchObject([{
      name: "court2_normalizer",
      courtNumber: 2,
      branch: "normalizer",
      framesPerSecond: 59.94,
      bitrateBps: 12_000_000,
      droppedFrames: 0,
      duplicatedFrames: 0,
      speedRatio: 1
    }]);
  });
});

describe("FFmpeg speed derivation", () => {
  it("publishes reset-safe windowed cadence and real-time ratio into the agent snapshot contract", () => {
    const deriver = new FfmpegSpeedDeriver();
    expect(deriver.update([branch("2026-07-17T00:00:00Z", 10_000, 300)])[0]).toMatchObject({ framesPerSecond: null, speedRatio: null });
    expect(deriver.update([branch("2026-07-17T00:00:05Z", 15_500, 462)])[0]).toMatchObject({ framesPerSecond: null, speedRatio: null });
    expect(deriver.update([branch("2026-07-17T00:00:15Z", 25_000, 750)])[0]).toMatchObject({ framesPerSecond: 30, speedRatio: 1 });
    expect(deriver.update([branch("2026-07-17T00:00:15Z", 25_000, 750)])[0]).toMatchObject({ framesPerSecond: 30, speedRatio: 1 });
    expect(deriver.update([branch("2026-07-17T00:00:20Z", 1_000, 30)])[0]).toMatchObject({ framesPerSecond: null, speedRatio: null });
    expect(deriver.update([])).toEqual([]);
    expect(deriver.update([branch("2026-07-17T00:00:25Z", 6_000, 180)])[0]).toMatchObject({ framesPerSecond: null, speedRatio: null });
  });

  it("smooths progress-file quantization instead of exposing a noisy one-sample cadence", () => {
    const deriver = new FfmpegSpeedDeriver();
    const first = branch("2026-07-17T00:00:00Z", 6_000, 120);
    first.speedRatio = 0.8;
    deriver.update([first]);
    expect(deriver.update([branch("2026-07-17T00:00:05Z", 10_600, 282)])[0]).toMatchObject({ framesPerSecond: null, speedRatio: null });
    expect(deriver.update([branch("2026-07-17T00:00:10Z", 15_400, 426)])[0]).toMatchObject({ framesPerSecond: null, speedRatio: null });
    expect(deriver.update([branch("2026-07-17T00:00:15Z", 21_000, 570)])[0]).toMatchObject({
      framesPerSecond: 30,
      speedRatio: 1
    });
  });
});

function branch(sampledAt: string, outputTimeMs: number, frame: number): FfmpegBranchSnapshot {
  return {
    name: "court1_preview",
    courtNumber: 1,
    branch: "preview",
    sampledAt,
    frame,
    framesPerSecond: 23,
    bitrateBps: 2_500_000,
    outputTimeMs,
    duplicatedFrames: 0,
    droppedFrames: 0,
    speedRatio: null
  };
}
