import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SOURCE_IMAGE,
  SpareHostSyntheticPublisherManager,
  buildSpareHostSyntheticPublisherConfig,
  sparePublisherHost
} from "./spare-host-synthetic-publishers.mjs";

const SOURCE_HOST = "203.0.113.9";

function sourceBinding() {
  return {
    manifest: {
      droplets: [
        { name: "bvm-compositor-a", providerName: "event-compositor-a", role: "compositor" },
        { name: "bvm-compositor-spare", providerName: "event-compositor-spare", role: "compositor-spare" }
      ]
    },
    lifecycleState: {
      droplets: {
        "bvm-compositor-spare": { publicIpv4: SOURCE_HOST }
      }
    }
  };
}

async function configFor(court, directory) {
  return buildSpareHostSyntheticPublisherConfig({
    court,
    generationId: "generation-1234",
    host: "rehearsal-ingest.example.com",
    sourceHost: SOURCE_HOST,
    sourceProviderName: "event-compositor-spare",
    user: `publisher-user-${court}`,
    password: `publisher-password-${court}-long`,
    evidenceDirectory: directory,
    runtimeDirectory: join(directory, "runtime")
  });
}

test("binds rehearsal publishers to exactly one manifest-owned warm spare", () => {
  const { manifest, lifecycleState } = sourceBinding();
  assert.deepEqual(sparePublisherHost(manifest, lifecycleState), {
    host: SOURCE_HOST,
    providerName: "event-compositor-spare",
    role: "compositor-spare"
  });
  assert.throws(() => sparePublisherHost({ droplets: [] }, lifecycleState), /exactly one/u);
  assert.throws(() => sparePublisherHost(manifest, { droplets: {} }), /public IPv4/u);
});

test("builds a pinned spare-host publisher without exposing its output credential in runtime identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-spare-source-"));
  const config = await configFor(6, directory);
  assert.equal(config.executionMode, "compositor-spare");
  assert.equal(config.sourceImage, SOURCE_IMAGE);
  assert.equal(config.sourceUnit, `${config.marker}.service`);
  assert.equal(config.sourceContainer, config.marker);
  assert.equal(config.remoteRoot, "/opt/scorecheck-rehearsal/generation-1234");
  assert.match(config.runnerContent, /exec ffmpeg/u);
  assert.match(config.runnerContent, /\$OUTPUT_URL/u);
  assert.doesNotMatch(config.runnerContent, /publisher-password/u);
  assert.match(config.environmentContent, /publisher-password/u);
  assert.equal(JSON.stringify(config.redacted).includes("publisher-password"), false);
});

test("stages, launches, observes, and stops only exact spare-host publisher ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-spare-runtime-"));
  const configs = await Promise.all(Array.from({ length: 8 }, (_, index) => configFor(index + 1, directory)));
  let active = false;
  const remoteCommands = [];
  const copied = [];
  const localManager = {
    preflight: async () => ({ healthy: true }),
    prepare: async (config) => ({ path: config.fixturePath, size: 123_456, adopted: false })
  };
  const now = Date.now();
  const snapshot = {
    schemaVersion: 1,
    observedAt: new Date(now).toISOString(),
    samples: configs.map((config) => ({
      court: config.court,
      marker: config.marker,
      progress: { status: "continue", frame: 900, framesPerSecond: 30, droppedFrames: 0, duplicatedFrames: 0, speedRatio: 1, ageMs: 20 },
      supervisor: { state: "running", supervisorPid: 500 + config.court, ffmpegPid: 700 + config.court, restartCount: 0, lastRestartAt: null, lastFailure: null, ageMs: 0 }
    }))
  };
  const runner = async (command, args) => {
    if (command === "scp") {
      copied.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }
    assert.equal(command, "ssh");
    const remote = args.at(-1);
    remoteCommands.push(remote);
    if (remote.includes("publisher-snapshot.py")) return { code: 0, stdout: JSON.stringify(snapshot), stderr: "" };
    if (remote.includes("printf '%s|%s|%s|%s|%s|%s")) {
      return active
        ? { code: 0, stdout: `active|501|0|true|${configs[0].marker}|701\n`, stderr: "" }
        : { code: 0, stdout: "|||||\n", stderr: "" };
    }
    if (remote.startsWith("/usr/bin/systemd-run")) active = true;
    if (remote.includes("systemctl stop")) active = false;
    if (remote.includes("journalctl")) return { code: 0, stdout: "publisher log\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const manager = new SpareHostSyntheticPublisherManager({
    sourceHost: SOURCE_HOST,
    sshKey: "/tmp/scorecheck-key",
    knownHosts: "/tmp/scorecheck-known-hosts",
    runner,
    localManager,
    sleep: async () => {},
    now: () => now
  });

  assert.equal((await manager.preflight("ffmpeg")).executionMode, "compositor-spare");
  const started = await manager.ensure(configs[0]);
  assert.equal(started.adopted, false);
  assert.equal(started.sourceHost, SOURCE_HOST);
  const launch = remoteCommands.find((command) => command.startsWith("/usr/bin/systemd-run"));
  assert.ok(launch);
  assert.match(launch, new RegExp(SOURCE_IMAGE.replaceAll("/", "\\/"), "u"));
  assert.doesNotMatch(launch, /publisher-password/u);
  assert.ok(copied.some((args) => args.includes(configs[0].localEnvironmentPath)));

  const health = await manager.observeHealth(configs.map((config) => ({ ...config.redacted, supervisorStatusPath: config.supervisorStatusPath })));
  assert.equal(health.passed, true);
  assert.equal(health.samples.length, 8);
  const status = JSON.parse(await readFile(configs[7].supervisorStatusPath, "utf8"));
  assert.equal(status.state, "running");
  assert.equal(status.ffmpegPid, 708);

  await manager.stop(started);
  assert.equal(active, false);
  assert.ok(remoteCommands.some((command) => command.includes("systemctl stop")));
  assert.equal(await readFile(configs[0].logPath, "utf8"), "publisher log\n");
});

test("fails closed on spare-host cadence loss or any systemd restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-spare-health-"));
  const configs = await Promise.all(Array.from({ length: 8 }, (_, index) => configFor(index + 1, directory)));
  const entries = configs.map((config) => ({ ...config.redacted, supervisorStatusPath: config.supervisorStatusPath }));
  const snapshot = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    samples: configs.map((config) => ({
      court: config.court,
      marker: config.marker,
      progress: { status: "continue", frame: 900, framesPerSecond: config.court === 4 ? 18 : 30, droppedFrames: 0, duplicatedFrames: 0, speedRatio: config.court === 4 ? 0.6 : 1, ageMs: 0 },
      supervisor: { state: "running", supervisorPid: 500 + config.court, ffmpegPid: 700 + config.court, restartCount: config.court === 6 ? 1 : 0, ageMs: 0 }
    }))
  };
  const manager = new SpareHostSyntheticPublisherManager({
    sourceHost: SOURCE_HOST,
    sshKey: "/tmp/scorecheck-key",
    knownHosts: "/tmp/scorecheck-known-hosts",
    localManager: {},
    runner: async () => ({ code: 0, stdout: JSON.stringify(snapshot), stderr: "" })
  });
  const health = await manager.observeHealth(entries);
  assert.equal(health.passed, false);
  assert.match(health.problems.join("; "), /Camera 4 synthetic publisher is outside 30fps/u);
  assert.match(health.problems.join("; "), /Camera 6 synthetic publisher restarted 1 time/u);
});
