import test from "node:test";
import assert from "node:assert/strict";

import { HevcNormalizerRuntime, parseNormalizerInspect } from "./hevc-normalizer-runtime.mjs";

const paths = { sshKey: "/tmp/key", knownHosts: "/tmp/known-hosts" };
const assignment = { sourceProfile: "STANDARD_1080P30", frameRateMode: "30/1", mediamtxPrivateHost: "10.20.0.3" };

test("starts and verifies only the HEVC camera's isolated normalizer", async () => {
  const commands = [];
  let started = false;
  const runtime = new HevcNormalizerRuntime({
    ...paths,
    runner: async (_command, args) => {
      const remote = args.at(-1);
      commands.push(remote);
      if (remote.includes("start-normalizer.sh")) {
        started = true;
        return { code: 0, stdout: "Camera 2 HEVC normalizer is healthy.\n", stderr: "" };
      }
      return { code: 0, stdout: started ? `${JSON.stringify(inspectFixture(2))}\n` : "null\n", stderr: "" };
    },
    sleep: async () => {}
  });

  const result = await runtime.ensure({ host: "198.51.100.2", court: 2, required: true, ...assignment });
  assert.equal(result.running, true);
  assert.equal(result.camera, 2);
  assert.equal(result.sourceProfile, assignment.sourceProfile);
  assert.equal(result.frameRateMode, assignment.frameRateMode);
  assert.equal(result.mediamtxPrivateHost, assignment.mediamtxPrivateHost);
  assert.equal(commands.filter((command) => command.includes("start-normalizer.sh")).length, 1);
});

test("adopts a matching normalizer and rejects any container on a direct-H264 camera", async () => {
  const runtime = new HevcNormalizerRuntime({
    ...paths,
    runner: async () => ({ code: 0, stdout: `${JSON.stringify(inspectFixture(3))}\n`, stderr: "" }),
    sleep: async () => {}
  });
  assert.equal((await runtime.ensure({ host: "198.51.100.3", court: 3, required: true, ...assignment })).restartCount, 0);
  await assert.rejects(() => runtime.ensure({ host: "198.51.100.3", court: 3, required: false }), /retains a normalizer container/u);
});

test("fails closed on restart history, assignment drift, and malformed inspect output", async () => {
  const restarted = inspectFixture(4);
  restarted.RestartCount = 1;
  const runtime = new HevcNormalizerRuntime({
    ...paths,
    runner: async () => ({ code: 0, stdout: JSON.stringify(restarted), stderr: "" }),
    sleep: async () => {}
  });
  await assert.rejects(() => runtime.ensure({ host: "198.51.100.4", court: 4, required: true, ...assignment }), /restarted 1 time/u);

  const drifted = inspectFixture(4);
  drifted.Config.Env = drifted.Config.Env.map((entry) => entry === "CAMERA_NUMBER=4" ? "CAMERA_NUMBER=5" : entry);
  await assert.rejects(() => parseAndValidate(drifted, 4), /CAMERA_NUMBER/u);
  assert.throws(() => parseNormalizerInspect("not-json"), /invalid JSON/u);
});

test("fails closed when an adopted normalizer does not match the event profile, frame rate, or private ingest", async () => {
  for (const [key, value] of [
    ["CAMERA_SOURCE_PROFILE", "CONSTRAINED_1080P30"],
    ["CAMERA_FRAME_RATE_MODE", "30000/1001"],
    ["MEDIAMTX_PRIVATE_HOST", "10.20.0.4"]
  ]) {
    const drifted = inspectFixture(5);
    drifted.Config.Env = drifted.Config.Env.map((entry) => entry.startsWith(`${key}=`) ? `${key}=${value}` : entry);
    await assert.rejects(() => parseAndValidate(drifted, 5), new RegExp(key, "u"));
  }
  await assert.rejects(
    () => parseAndValidate(inspectFixture(5), 5, { sourceProfile: "PRIORITY_1080P60", frameRateMode: "30/1" }),
    /frame-rate mode does not match/u
  );
  await assert.rejects(
    () => parseAndValidate(inspectFixture(5), 5, { mediamtxPrivateHost: "198.51.100.5" }),
    /private IPv4/u
  );
});

function parseAndValidate(value, court, overrides = {}) {
  const runtime = new HevcNormalizerRuntime({
    ...paths,
    runner: async () => ({ code: 0, stdout: JSON.stringify(value), stderr: "" }),
    sleep: async () => {}
  });
  return runtime.ensure({ host: "198.51.100.4", court, required: true, ...assignment, ...overrides });
}

function inspectFixture(court) {
  return {
    Id: "a".repeat(64),
    State: { Running: true, StartedAt: "2026-07-21T12:00:00.000Z" },
    RestartCount: 0,
    Config: { Env: [
      `CAMERA_NUMBER=${court}`,
      "CAMERA_NORMALIZER_ENABLED=true",
      "CAMERA_SOURCE_PATH_MODE=isolated-hevc-normalizer",
      "CAMERA_SOURCE_CODEC=H265",
      `CAMERA_SOURCE_PROFILE=${assignment.sourceProfile}`,
      `CAMERA_FRAME_RATE_MODE=${assignment.frameRateMode}`,
      `CAMERA_NORMALIZER_INPUT_PATH=court${court}_raw`,
      `CAMERA_NORMALIZER_OUTPUT_PATH=court${court}_normalized`,
      `MEDIAMTX_PRIVATE_HOST=${assignment.mediamtxPrivateHost}`
    ] }
  };
}
