import test from "node:test";
import assert from "node:assert/strict";

import { HevcNormalizerRuntime, parseNormalizerInspect } from "./hevc-normalizer-runtime.mjs";

const paths = { sshKey: "/tmp/key", knownHosts: "/tmp/known-hosts" };

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

  const result = await runtime.ensure({ host: "198.51.100.2", court: 2, required: true });
  assert.equal(result.running, true);
  assert.equal(result.camera, 2);
  assert.equal(commands.filter((command) => command.includes("start-normalizer.sh")).length, 1);
});

test("adopts a matching normalizer and rejects any container on a direct-H264 camera", async () => {
  const runtime = new HevcNormalizerRuntime({
    ...paths,
    runner: async () => ({ code: 0, stdout: `${JSON.stringify(inspectFixture(3))}\n`, stderr: "" }),
    sleep: async () => {}
  });
  assert.equal((await runtime.ensure({ host: "198.51.100.3", court: 3, required: true })).restartCount, 0);
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
  await assert.rejects(() => runtime.ensure({ host: "198.51.100.4", court: 4, required: true }), /restarted 1 time/u);

  const drifted = inspectFixture(4);
  drifted.Config.Env = drifted.Config.Env.map((entry) => entry === "CAMERA_NUMBER=4" ? "CAMERA_NUMBER=5" : entry);
  await assert.rejects(() => parseAndValidate(drifted, 4), /CAMERA_NUMBER/u);
  assert.throws(() => parseNormalizerInspect("not-json"), /invalid JSON/u);
});

function parseAndValidate(value, court) {
  const runtime = new HevcNormalizerRuntime({
    ...paths,
    runner: async () => ({ code: 0, stdout: JSON.stringify(value), stderr: "" }),
    sleep: async () => {}
  });
  return runtime.ensure({ host: "198.51.100.4", court, required: true });
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
      `CAMERA_NORMALIZER_INPUT_PATH=court${court}_raw`,
      `CAMERA_NORMALIZER_OUTPUT_PATH=court${court}_normalized`
    ] }
  };
}
