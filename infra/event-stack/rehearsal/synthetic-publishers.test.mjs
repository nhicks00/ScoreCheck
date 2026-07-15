import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSyntheticPublisherConfig, publisherMarker, publisherProtocol, SyntheticPublisherManager } from "./synthetic-publishers.mjs";

test("maps Cameras 1-2 to RTMP and Cameras 3-8 to SRT", () => {
  assert.equal(publisherProtocol(1), "RTMP");
  assert.equal(publisherProtocol(2), "RTMP");
  for (let court = 3; court <= 8; court += 1) assert.equal(publisherProtocol(court), "SRT");
});

test("builds visibly distinct 720p30 publishers with a resumable process marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-publisher-"));
  const config = buildSyntheticPublisherConfig({ court: 8, generationId: "generation-1234", host: "preview-test.example.com", user: "publisher-user-8", password: "publisher-password-8-long", evidenceDirectory: directory });
  assert.equal(config.marker, publisherMarker("generation-1234", 8));
  assert.equal(config.protocol, "SRT");
  assert.ok(config.args.includes("comment=scorecheck-rehearsal-generation-1234-camera-8"));
  assert.ok(config.args.some((value) => value.includes("CAMERA 8 REHEARSAL")));
  assert.equal(JSON.stringify(config.redacted).includes("publisher-password"), false);
  assert.equal(JSON.stringify(config.redacted).includes("streamid="), false);
});

test("adopts one exact marked process and fails closed on duplicates", async () => {
  const marker = publisherMarker("generation-1234", 1);
  let processLines = `123 ffmpeg -metadata comment=${marker}`;
  const manager = new SyntheticPublisherManager({ runner: async () => ({ stdout: processLines, stderr: "" }) });
  assert.equal((await manager.inspect(marker)).pid, 123);
  processLines += `\n124 ffmpeg -metadata comment=${marker}`;
  await assert.rejects(() => manager.inspect(marker), /multiple synthetic publishers/);
});

test("starts and stops an exact detached publisher without killing peers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-publisher-runtime-"));
  const config = buildSyntheticPublisherConfig({ court: 1, generationId: "generation-1234", host: "preview-test.example.com", user: "publisher-user-1", password: "publisher-password-1-long", evidenceDirectory: directory });
  let processLines = "901 unrelated-service";
  const signals = [];
  const manager = new SyntheticPublisherManager({
    sleep: async () => {},
    spawnImpl: (_command, args) => {
      processLines += `\n500 ffmpeg ${args.join(" ")}`;
      return { pid: 500 };
    },
    runner: async () => ({ stdout: processLines, stderr: "" }),
    killImpl: (pid, signal) => {
      signals.push({ pid, signal });
      processLines = processLines.split("\n").filter((line) => !line.startsWith("500 ")).join("\n");
    }
  });
  const started = await manager.ensure(config);
  assert.equal(started.pid, 500);
  assert.equal(started.adopted, false);
  await manager.stop({ marker: config.marker });
  assert.deepEqual(signals, [{ pid: -500, signal: "SIGTERM" }]);
  assert.match(processLines, /unrelated-service/);
});

test("preflight requires both protocols, encoders, and visual generators", async () => {
  const outputs = {
    "-protocols": "rtmp srt",
    "-encoders": "libx264 aac",
    "-filters": "drawtext drawbox testsrc2 sine"
  };
  const manager = new SyntheticPublisherManager({ runner: async (_command, args) => ({ stdout: outputs[args.at(-1)] ?? "", stderr: "" }) });
  assert.deepEqual(await manager.preflight("ffmpeg"), { healthy: true });
  outputs["-filters"] = "drawbox testsrc2 sine";
  await assert.rejects(() => manager.preflight("ffmpeg"), /missing drawtext/);
});
