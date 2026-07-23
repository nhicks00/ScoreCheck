import assert from "node:assert/strict";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ProductionMediaPrequalificationRuntime, prequalificationCleanupProblems } from "./production-media-prequalification.mjs";

test("runs resumable local-only HEVC source and 1080 output qualification", async () => {
  const evidence = await protectedDirectory();
  const calls = { normalizer: [], source: 0, output: [] };
  let nowMs = Date.parse("2026-07-23T15:00:00.000Z");
  const runtime = new ProductionMediaPrequalificationRuntime({
    options: { evidence },
    manifest: manifest(),
    lifecycle: lifecycle(),
    renderer: renderer(),
    venue: venue(),
    normalizer: { ensure: async (value) => { calls.normalizer.push(value); return { required: true, running: true, camera: 1 }; } },
    sourceProbe: { probe: async () => {
      calls.source += 1;
      if (calls.source === 1) throw new Error("source warming");
      return sourceProfile();
    } },
    outputConformance: { qualify: async (value) => { calls.output.push(value); return { status: "QUALIFIED", profile: value.profile, sample: { sha256: "a".repeat(64) } }; } },
    fetchSnapshot: async () => snapshot(nowMs),
    rawProblems: () => [],
    cleanupProblems: () => [],
    sleep: async (milliseconds) => { nowMs += milliseconds; },
    now: () => nowMs
  });

  const report = await runtime.run();
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.activeCameras, [1]);
  assert.equal(report.cameras[1].status, "PASS");
  assert.equal(calls.source, 2);
  assert.equal(calls.output.length, 1);
  assert.equal(calls.output[0].profile, "1080p30");
  assert.equal(calls.normalizer[0].mediamtxPrivateHost, "10.10.0.10");

  const repeated = await runtime.run();
  assert.equal(repeated.runId, report.runId);
  assert.equal(calls.output.length, 1);
});

test("fails closed when a stable raw baseline never arrives", async () => {
  const evidence = await protectedDirectory();
  let nowMs = 0;
  const runtime = new ProductionMediaPrequalificationRuntime({
    options: { evidence }, manifest: manifest(), lifecycle: lifecycle(), renderer: renderer(), venue: venue(),
    normalizer: { ensure: async () => ({ required: true, running: true }) },
    sourceProbe: { probe: async () => sourceProfile() },
    outputConformance: { qualify: async () => { throw new Error("output must not start"); } },
    fetchSnapshot: async () => snapshot(nowMs),
    rawProblems: () => ["Camera 1 raw video is not ready"],
    cleanupProblems: () => [],
    sleep: async () => { nowMs += 300_001; },
    now: () => nowMs
  });
  await assert.rejects(() => runtime.run(), /raw paths did not stabilize.*Camera 1 raw video is not ready/u);
});

test("exposes only the explicit local-only run command", () => {
  const script = fileURLToPath(new URL("./production-media-prequalification.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /production-media-prequalification\.mjs run/u);
});

test("requires browser, branch, and Egress cleanup after local output capture", () => {
  const monitored = snapshot(0);
  monitored.courts[0] = {
    courtNumber: 1,
    browser: { state: "playing" },
    paths: {
      preview: { ready: true, readerCount: 1 },
      program: { ready: false, readerCount: 1 }
    }
  };
  monitored.agents = [{
    agentId: "bvm-compositor-a",
    role: "compositor",
    nativeServices: { egress: { idle: false, activeWebRequests: 1, maximumWebRequests: 1, canAcceptRequest: false } }
  }];

  assert.deepEqual(prequalificationCleanupProblems(monitored, venue()), [
    "Camera 1 retains a program browser after local-only output capture",
    "Camera 1 preview did not retire after local-only output capture",
    "Camera 1 program did not retire after local-only output capture",
    "bvm-compositor-a is not idle after local-only output capture"
  ]);
});

test("accepts fully drained branches and idle one-request Egress agents", () => {
  const monitored = snapshot(0);
  monitored.courts[0] = {
    courtNumber: 1,
    browser: null,
    paths: {
      preview: { ready: false, readerCount: 0 },
      program: { ready: false, readerCount: 0 }
    }
  };
  monitored.agents = [{
    agentId: "bvm-compositor-a",
    role: "compositor",
    nativeServices: { egress: { idle: true, activeWebRequests: 0, maximumWebRequests: 1, canAcceptRequest: true } }
  }];

  assert.deepEqual(prequalificationCleanupProblems(monitored, venue()), []);
});

function venue() {
  return {
    sha256: "f".repeat(64), passed: true, activeCameras: [1], inactiveCameras: [2, 3, 4, 5, 6, 7, 8],
    assignments: {
      1: {
        cameraNumber: 1,
        cameraIdentity: "camera-1",
        publishPath: "court1_raw",
        sourceCodec: "H265",
        sourcePathMode: "isolated-hevc-normalizer",
        sourceProfile: "CONSTRAINED_1080P30",
        outputProfile: "1080p30",
        frameRateMode: "30/1"
      }
    }
  };
}

function sourceProfile() {
  return {
    profile: "1080p30",
    sourcePathMode: "isolated-hevc-normalizer",
    source: { codec: "H265", frameRateMode: "30/1" },
    browserInput: { codec: "H264", hasBFrames: 0, pixelFormat: "yuv420p" }
  };
}

function manifest() {
  return {
    event: "physical-media",
    droplets: [
      { name: "bvm-preview-01", role: "ingest" },
      { name: "bvm-compositor-a", role: "compositor", court: 1 }
    ]
  };
}

function lifecycle() {
  return {
    generationId: "generation-12345678",
    droplets: {
      "bvm-preview-01": { publicIpv4: "192.0.2.10", privateIpv4: "10.10.0.10" },
      "bvm-compositor-a": { publicIpv4: "192.0.2.11", privateIpv4: "10.10.0.11" }
    }
  };
}

function renderer() {
  return { origin: "https://renderer-test.vercel.app", deploymentId: "dpl_test123", gitSha: "a".repeat(40) };
}

function snapshot(nowMs) {
  return {
    version: 5,
    generatedAt: new Date(nowMs).toISOString(),
    collector: {},
    courts: Array.from({ length: 8 }, (_, index) => ({ courtNumber: index + 1, overallState: index === 0 ? "HEALTHY" : "EXPECTED_OFF", paths: {} })),
    agents: []
  };
}

async function protectedDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-media-prequalification-"));
  await chmod(directory, 0o700);
  return directory;
}
