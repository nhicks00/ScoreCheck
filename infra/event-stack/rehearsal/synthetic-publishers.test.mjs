import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSyntheticPublisherConfig, publisherMarker, publisherProtocol, SyntheticPublisherManager } from "./synthetic-publishers.mjs";

test("maps Cameras 1-2 to RTMP and Cameras 3-8 to SRT", () => {
  assert.equal(publisherProtocol(1), "RTMP");
  assert.equal(publisherProtocol(2), "RTMP");
  for (let court = 3; court <= 8; court += 1) assert.equal(publisherProtocol(court), "SRT");
});

test("builds visibly distinct 1080p30 publishers with a resumable process marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-publisher-"));
  const config = buildSyntheticPublisherConfig({ court: 8, generationId: "generation-1234", host: "preview-test.example.com", user: "publisher-user-8", password: "publisher-password-8-long", evidenceDirectory: directory, runtimeDirectory: join(directory, "runtime") });
  assert.equal(config.marker, publisherMarker("generation-1234", 8));
  assert.equal(config.protocol, "SRT");
  assert.ok(config.args.includes("comment=scorecheck-rehearsal-generation-1234-camera-8"));
  assert.ok(config.fixtureArgs.some((value) => value.includes("CAMERA 8 REHEARSAL")));
  assert.ok(config.fixtureArgs.some((value) => value.includes("size=1920x1080:rate=30")));
  assert.equal(config.fixtureArgs[config.fixtureArgs.indexOf("-profile:v") + 1], "main");
  assert.match(config.fixtureArgs[config.fixtureArgs.indexOf("-x264-params") + 1], /(?:^|:)cabac=1(?:$|:)/);
  assert.equal(config.fixtureArgs[config.fixtureArgs.indexOf("-b:v") + 1], "1250k");
  assert.equal(config.fixtureArgs[config.fixtureArgs.indexOf("-minrate") + 1], "1250k");
  assert.equal(config.fixtureArgs[config.fixtureArgs.indexOf("-maxrate") + 1], "1250k");
  assert.equal(config.fixtureArgs[config.fixtureArgs.indexOf("-bufsize") + 1], "2500k");
  assert.equal(config.args[config.args.indexOf("-c") + 1], "copy");
  assert.equal(config.args[config.args.indexOf("-stream_loop") + 1], "-1");
  assert.equal(config.args[config.args.indexOf("-rw_timeout") + 1], "10000000");
  assert.match(config.outputUrl, /timeout=10000000/u);
  assert.match(config.outputUrl, /transtype=live/u);
  assert.match(config.outputUrl, /tlpktdrop=1/u);
  assert.match(config.outputUrl, /latency=500000/u);
  assert.match(config.outputUrl, /maxbw=0/u);
  assert.match(config.outputUrl, /inputbw=200000/u);
  assert.match(config.outputUrl, /oheadbw=50/u);
  assert.match(config.workerPath, /synthetic-publisher-worker\.cjs$/u);
  assert.equal(config.protectedSupervisorConfiguration.ffmpegArgs, config.args);
  assert.match(config.supervisorConfigPath, /\/runtime\/camera-8\.supervisor\.json$/u);
  assert.doesNotMatch(config.supervisorStatusPath, /\/runtime\//u);
  assert.equal(JSON.stringify(config.redacted).includes("publisher-password"), false);
  assert.equal(JSON.stringify(config.redacted).includes("streamid="), false);
});

test("adopts one exact marked process and fails closed on duplicates", async () => {
  const marker = publisherMarker("generation-1234", 1);
  let processLines = `123 node synthetic-publisher-worker.cjs --marker ${marker} --config /tmp/camera.json`;
  const manager = new SyntheticPublisherManager({ runner: async () => ({ stdout: processLines, stderr: "" }) });
  assert.equal((await manager.inspect(marker)).pid, 123);
  processLines += `\n124 node synthetic-publisher-worker.cjs --marker ${marker} --config /tmp/camera-2.json`;
  await assert.rejects(() => manager.inspect(marker), /multiple synthetic publishers/);
});

test("starts and stops an exact detached publisher without killing peers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-publisher-runtime-"));
  const config = buildSyntheticPublisherConfig({ court: 1, generationId: "generation-1234", host: "preview-test.example.com", user: "publisher-user-1", password: "publisher-password-1-long", evidenceDirectory: directory, runtimeDirectory: join(directory, "runtime") });
  let processLines = "901 unrelated-service";
  const signals = [];
  let unrefCount = 0;
  let fixtureBuilds = 0;
  const manager = new SyntheticPublisherManager({
    sleep: async () => {},
    fixtureBuilder: async () => { fixtureBuilds += 1; },
    spawnImpl: (command, args) => {
      assert.equal(command, config.nodePath);
      assert.deepEqual(args, [config.workerPath, "--marker", config.marker, "--config", config.supervisorConfigPath]);
      processLines += `\n500 node ${args.join(" ")}`;
      return { pid: 500, unref: () => { unrefCount += 1; } };
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
  assert.equal(unrefCount, 1);
  assert.equal(fixtureBuilds, 1);
  await manager.stop({ marker: config.marker });
  assert.deepEqual(signals, [{ pid: -500, signal: "SIGTERM" }]);
  assert.match(processLines, /unrelated-service/);
});

test("prepares each encoded fixture once and adopts it on repeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-publisher-prepare-"));
  const config = buildSyntheticPublisherConfig({ court: 1, generationId: "generation-1234", host: "preview-test.example.com", user: "publisher-user-1", password: "publisher-password-1-long", evidenceDirectory: directory, runtimeDirectory: join(directory, "runtime") });
  let fixtureBuilds = 0;
  const manager = new SyntheticPublisherManager({
    runner: async (_command, args) => {
      assert.equal(args, config.fixtureArgs);
      fixtureBuilds += 1;
      await writeFile(config.fixtureTempPath, Buffer.alloc(100_001));
      return { stdout: "", stderr: "" };
    }
  });

  assert.equal((await manager.prepare(config)).adopted, false);
  assert.equal((await manager.prepare(config)).adopted, true);
  assert.equal(fixtureBuilds, 1);
});

test("preflight requires both protocols, encoders, and visual generators", async () => {
  const outputs = {
    "-protocols": "rtmp srt",
    "-encoders": "libx264 aac",
    "-filters": "drawtext drawbox testsrc2 sine",
    "-formats": "matroska"
  };
  const manager = new SyntheticPublisherManager({ runner: async (_command, args) => ({ stdout: outputs[args.at(-1)] ?? "", stderr: "" }) });
  assert.deepEqual(await manager.preflight("ffmpeg"), { healthy: true });
  outputs["-filters"] = "drawbox testsrc2 sine";
  await assert.rejects(() => manager.preflight("ffmpeg"), /missing drawtext/);
});

test("requires all eight stream-copy publishers to remain fresh at realtime cadence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-publisher-health-"));
  let now = 0;
  const entries = [];
  const processLines = [];
  for (let court = 1; court <= 8; court += 1) {
    const marker = publisherMarker("generation-1234", court);
    const progressPath = join(directory, `camera-${court}.progress`);
    const supervisorStatusPath = join(directory, `camera-${court}.supervisor-status.json`);
    await writeFile(progressPath, "frame=900\nfps=30.00\ndup_frames=0\ndrop_frames=0\nspeed=1.00x\nprogress=continue\n");
    await writeFile(supervisorStatusPath, `${JSON.stringify({ schemaVersion: 1, court, marker, state: "running", ffmpegPid: 700 + court, restartCount: 0 })}\n`);
    entries.push({ court, marker, progressPath, supervisorStatusPath });
    processLines.push(`${500 + court} node synthetic-publisher-worker.cjs --marker ${marker} --config /tmp/camera-${court}.json`);
  }
  now = Date.now();
  const manager = new SyntheticPublisherManager({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    runner: async () => ({ stdout: processLines.join("\n"), stderr: "" })
  });
  const healthy = await manager.observeHealth(entries);
  assert.equal(healthy.passed, true);
  assert.equal(healthy.samples.length, 8);

  await writeFile(entries[0].progressPath, "frame=510\nfps=17.50\ndup_frames=0\ndrop_frames=0\nspeed=0.58x\nprogress=continue\n");
  const degraded = await manager.observeHealth(entries);
  assert.equal(degraded.passed, false);
  assert.match(degraded.problems.join("; "), /Camera 1 synthetic publisher is outside 30fps/);
  await writeFile(entries[1].supervisorStatusPath, `${JSON.stringify({ schemaVersion: 1, court: 2, marker: entries[1].marker, state: "running", ffmpegPid: 702, restartCount: 1, lastRestartAt: new Date(now).toISOString() })}\n`);
  const restarted = await manager.observeHealth(entries);
  assert.equal(restarted.passed, false);
  assert.match(restarted.problems.join("; "), /Camera 2 synthetic publisher restarted 1 time/u);
  await writeFile(entries[2].supervisorStatusPath, `${JSON.stringify({ schemaVersion: 1, court: 4, marker: entries[3].marker, state: "running", ffmpegPid: 703, restartCount: 0 })}\n`);
  const crossedIdentity = await manager.observeHealth(entries);
  assert.equal(crossedIdentity.passed, false);
  assert.match(crossedIdentity.problems.join("; "), /Camera 3 synthetic publisher supervisor status is missing/u);
  await assert.rejects(() => manager.waitForHealthy(entries, { stableSamples: 1, timeoutMs: 0, intervalMs: 1 }), (error) => {
    assert.equal(error.name, "SyntheticPublisherHealthError");
    assert.equal(error.evidence.passed, false);
    return true;
  });
});
