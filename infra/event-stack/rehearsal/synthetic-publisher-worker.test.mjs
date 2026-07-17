import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseArgs, publisherFailure, validateConfig } = require("./synthetic-publisher-worker.cjs");

test("parses an exact worker identity and protected configuration path", () => {
  assert.deepEqual(parseArgs(["--marker", "scorecheck-rehearsal-generation-1234-camera-3", "--config", "/tmp/camera-3.json"]), {
    marker: "scorecheck-rehearsal-generation-1234-camera-3",
    config: "/tmp/camera-3.json"
  });
  assert.throws(() => parseArgs(["--marker", "bad"]), /arguments are incomplete/u);
  assert.throws(() => parseArgs(["--unknown", "value"]), /unsupported/u);
  assert.throws(() => parseArgs(["--marker", "scorecheck-rehearsal-generation-1234-camera-3", "--config", "/tmp/../camera-3.json"]), /configuration path is invalid/u);
});

test("fails closed unless the worker owns exact FFmpeg and evidence paths", () => {
  const marker = "scorecheck-rehearsal-generation-1234-camera-3";
  const config = {
    schemaVersion: 1,
    court: 3,
    marker,
    ffmpegPath: "/opt/ffmpeg",
    ffmpegArgs: ["-metadata", `comment=${marker}`],
    progressPath: "/tmp/camera-3.progress",
    logPath: "/tmp/camera-3.log",
    statusPath: "/tmp/camera-3.status.json"
  };
  assert.doesNotThrow(() => validateConfig(config, marker));
  assert.throws(() => validateConfig({ ...config, ffmpegArgs: ["-metadata", "comment=peer"] }, marker), /configuration is invalid/u);
  assert.throws(() => validateConfig({ ...config, statusPath: "relative.json" }, marker), /configuration is invalid/u);
  assert.throws(() => validateConfig({ ...config, statusPath: "/tmp/../camera-3.status.json" }, marker), /configuration is invalid/u);
  assert.throws(() => validateConfig({ ...config, court: 4 }, marker), /configuration is invalid/u);
});

test("classifies exits, missing progress, and a twelve-second output stall after startup grace", () => {
  const base = { nowMs: 20_000, launchedAtMs: 10_000, childExit: null, progressMtimeMs: null, progressMissing: false };
  assert.equal(publisherFailure(base), null);
  assert.match(publisherFailure({ ...base, childExit: { code: 1, signal: null } }), /exited code=1/u);
  assert.match(publisherFailure({ ...base, nowMs: 30_000, progressMissing: true }), /progress missing/u);
  assert.equal(publisherFailure({ ...base, nowMs: 30_000, progressMtimeMs: 25_000 }), null);
  assert.match(publisherFailure({ ...base, nowMs: 30_001, progressMtimeMs: 18_000 }), /progress stale for 12001ms/u);
});
