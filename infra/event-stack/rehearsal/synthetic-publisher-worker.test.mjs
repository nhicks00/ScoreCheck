import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("does not relaunch its FFmpeg child when the detached process group is stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-publisher-shutdown-"));
  const starts = join(directory, "starts.log");
  const fakeFfmpeg = join(directory, "fake-ffmpeg.sh");
  const progress = join(directory, "camera-1.progress");
  const status = join(directory, "camera-1.status.json");
  const log = join(directory, "camera-1.log");
  const configPath = join(directory, "camera-1.json");
  const marker = "scorecheck-rehearsal-generation-1234-camera-1";
  await writeFile(fakeFfmpeg, `#!/bin/sh\nprintf 'start\\n' >> ${starts}\ntrap 'exit 0' TERM INT\nwhile :; do\n  printf 'frame=30\\nfps=30.00\\ndup_frames=0\\ndrop_frames=0\\nspeed=1.00x\\nprogress=continue\\n' > ${progress}\n  sleep 1\ndone\n`);
  await chmod(fakeFfmpeg, 0o700);
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    court: 1,
    marker,
    ffmpegPath: fakeFfmpeg,
    ffmpegArgs: ["-metadata", `comment=${marker}`],
    progressPath: progress,
    logPath: log,
    statusPath: status
  })}\n`);
  const worker = spawn(process.execPath, [new URL("./synthetic-publisher-worker.cjs", import.meta.url).pathname, "--marker", marker, "--config", configPath], {
    detached: true,
    stdio: "ignore"
  });
  worker.unref();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const value = JSON.parse(await readFile(status, "utf8"));
      if (value.state === "running") break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill(-worker.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(worker.pid, 0); }
    catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal((await readFile(starts, "utf8")).trim().split("\n").length, 1);
  const finalStatus = JSON.parse(await readFile(status, "utf8"));
  assert.equal(finalStatus.state, "stopped");
  assert.equal(finalStatus.restartCount, 0);
});
