import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildQueries, evaluateEvidence, memoryGrowthRatio, percentile, resetAwareIncrease } from "./evaluate-gate.mjs";

test("computes nearest-rank percentiles", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
  assert.equal(percentile([4, 1, 3, 2], 0.05), 1);
  assert.equal(percentile([], 0.95), null);
});

test("accumulates counter growth across resets", () => {
  assert.equal(resetAwareIncrease([10, 12, 1, 4]), 6);
});

test("compares median memory after warmup", () => {
  assert.equal(memoryGrowthRatio([100, 100, 102, 103, 104, 105, 110, 110, 110, 110]), 0.1);
});

test("builds bounded allowlisted queries", () => {
  const queries = buildQueries(config());
  assert.match(queries.raw_bitrate, /^scorecheck_media_path_inbound_bitrate_bps\{/);
  assert.match(queries.compositor_cpu, /agent="compositor-a",service="bvm-egress"/);
  assert.throws(() => buildQueries({ ...config(), ingest: { ...config().ingest, agent: 'bad"}' } }), /invalid agent/);
});

test("rejects missing hard acceptance thresholds", () => {
  const gateConfig = config();
  delete gateConfig.thresholds.maximumShmRatio;
  assert.throws(() => evaluateEvidence(gateConfig, healthyEvidence(config()), attestations()), /maximumShmRatio is required/);
});

test("passes complete healthy evidence", () => {
  const gateConfig = config();
  const evidence = healthyEvidence(gateConfig);
  const report = evaluateEvidence(gateConfig, evidence, attestations());
  assert.equal(report.verdict, "PASS");
  assert.equal(report.checks.filter((check) => !check.pass).length, 0);
});

test("fails on browser loss, CPU saturation, zombie growth, or missing attestation", () => {
  const gateConfig = config();
  const evidence = healthyEvidence(gateConfig);
  evidence.series.browser_dropped = series([0, 100, 200, 300, 400]);
  evidence.series.ingest_cpu = series([3.3, 3.3, 3.3, 3.3, 3.3]);
  const report = evaluateEvidence(gateConfig, evidence, {
    ...attestations(),
    ingestZombieGrowth: 2,
    observedSourceProfile: { ...attestations().observedSourceProfile, videoCodec: "H265" }
  });
  assert.equal(report.verdict, "FAIL");
  const failed = new Set(report.checks.filter((check) => !check.pass).map((check) => check.id));
  assert(failed.has("browser_drop_ratio"));
  assert(failed.has("ingest_cpu_max"));
  assert(failed.has("ingest_zombie_growth"));
  assert(failed.has("source_profile_videoCodec"));
});

test("CLI queries Prometheus and writes a protected credential-free report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-capacity-"));
  const configPath = join(directory, "config.json");
  const attestationPath = join(directory, "attestations.json");
  const outputPath = join(directory, "report.json");
  await writeFile(configPath, JSON.stringify(config()));
  await writeFile(attestationPath, JSON.stringify({ ...attestations(), ignoredSecret: "must-not-survive" }));

  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-only-token");
    const url = new URL(request.url, "http://127.0.0.1");
    const query = url.searchParams.get("query") ?? "";
    const values = prometheusValues(query);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "success", data: { resultType: "matrix", result: [{ metric: {}, values }] } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const result = await run(process.execPath, [
      fileURLToPath(new URL("./evaluate-gate.mjs", import.meta.url)),
      "--config", configPath,
      "--attestations", attestationPath,
      "--prometheus-url", `http://127.0.0.1:${address.port}`,
      "--start", "1970-01-01T00:00:00Z",
      "--end", "1970-01-01T00:00:25Z",
      "--output", outputPath
    ], { SCORECHECK_PROMETHEUS_BEARER_TOKEN: "test-only-token" });
    assert.equal(result.code, 0, result.stderr);
    const reportText = await readFile(outputPath, "utf8");
    const report = JSON.parse(reportText);
    assert.equal(report.verdict, "PASS");
    assert.equal(report.attestations.observedSourceProfile.videoCodec, "H264");
    assert(!reportText.includes("test-only-token"));
    assert(!reportText.includes("must-not-survive"));
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function config() {
  return {
    schemaVersion: 1,
    gateId: "court1-c4",
    court: 1,
    minimumDurationSeconds: 20,
    warmupSeconds: 5,
    stepSeconds: 5,
    requiredBranches: ["raw", "preview", "program"],
    ffmpegBranches: ["preview", "program"],
    expectedSourceProfile: sourceProfile(),
    ingest: { agent: "ingest-a", service: "mediamtx", vcpus: 4 },
    compositor: { agent: "compositor-a", service: "bvm-egress", vcpus: 4 },
    requireBrowser: true,
    thresholds: {
      minimumSampleCoverageRatio: 0.8,
      minimumActiveRatio: 0.95,
      minimumRawBitrateBps: 1_000_000,
      minimumFfmpegFps: 29,
      minimumFfmpegSpeed: 0.98,
      minimumBrowserFps: 29,
      maximumBrowserDropRatio: 0.005,
      maximumBrowserFreezeRatio: 0.01,
      maximumCpuP95Ratio: 0.75,
      maximumCpuRatio: 0.8,
      maximumMemoryGrowthRatio: 0.1,
      maximumShmRatio: 0.8
    }
  };
}

function attestations() {
  return {
    observedSourceProfile: sourceProfile(),
    assignmentVerified: true,
    unassignedCourtsUnaffected: true,
    ingestZombieGrowth: 0,
    ingestHostCpuP95Ratio: 0.6,
    ingestHostCpuMaxRatio: 0.7,
    compositorZombieGrowth: 0,
    compositorHostCpuP95Ratio: 0.55,
    compositorHostCpuMaxRatio: 0.65,
    egressErrors: 0,
    egressShmMaxRatio: 0.4
  };
}

function sourceProfile() {
  return {
    protocol: "RTMP",
    mode: "PUSH",
    videoCodec: "H264",
    videoWidth: 1920,
    videoHeight: 1080,
    videoProfile: "Main",
    audioCodec: "AAC",
    audioSampleRateHz: 48000,
    audioChannelCount: 2
  };
}

function healthyEvidence(gateConfig) {
  const evidence = {
    startEpochSeconds: 0,
    effectiveStartEpochSeconds: 5,
    endEpochSeconds: 25,
    series: {}
  };
  for (const name of Object.keys(buildQueries(gateConfig))) evidence.series[name] = series([1, 1, 1, 1, 1]);
  evidence.series.raw_bitrate = series([6_000_000, 6_100_000, 5_900_000, 6_000_000, 6_200_000]);
  evidence.series.ffmpeg_fps_preview = series([30, 30, 30, 30, 30]);
  evidence.series.ffmpeg_fps_program = series([30, 30, 30, 30, 30]);
  evidence.series.ffmpeg_speed_preview = series([1, 1, 1, 1, 1]);
  evidence.series.ffmpeg_speed_program = series([1, 1, 1, 1, 1]);
  evidence.series.ffmpeg_dropped_preview = series([0, 0, 0, 0, 0]);
  evidence.series.ffmpeg_dropped_program = series([0, 0, 0, 0, 0]);
  evidence.series.path_frame_errors_raw = series([0, 0, 0, 0, 0]);
  evidence.series.path_frame_errors_preview = series([0, 0, 0, 0, 0]);
  evidence.series.path_frame_errors_program = series([0, 0, 0, 0, 0]);
  evidence.series.ingest_cpu = series([2.0, 2.2, 2.4, 2.2, 2.1]);
  evidence.series.compositor_cpu = series([1.8, 2.0, 2.1, 2.0, 1.9]);
  evidence.series.ingest_memory = series([1_000, 1_000, 1_020, 1_030, 1_040]);
  evidence.series.compositor_memory = series([1_000, 1_000, 1_010, 1_020, 1_030]);
  evidence.series.ingest_restarts = series([0, 0, 0, 0, 0]);
  evidence.series.compositor_restarts = series([0, 0, 0, 0, 0]);
  evidence.series.ingest_oom = series([0, 0, 0, 0, 0]);
  evidence.series.compositor_oom = series([0, 0, 0, 0, 0]);
  evidence.series.egress_idle = series([0, 0, 0, 0, 0]);
  evidence.series.browser_fps = series([30, 30, 30, 30, 30]);
  evidence.series.browser_received = series([0, 150, 300, 450, 600]);
  evidence.series.browser_dropped = series([0, 0, 0, 0, 0]);
  evidence.series.browser_freeze_duration = series([0, 0, 0, 0, 0]);
  return evidence;
}

function series(values) {
  return values.map((value, index) => ({ timestamp: 5 + (index * 5), value }));
}

function prometheusValues(query) {
  let values = [1, 1, 1, 1, 1];
  if (query.includes("inbound_bitrate")) values = [6_000_000, 6_100_000, 5_900_000, 6_000_000, 6_200_000];
  else if (query.includes("frames_per_second")) values = [30, 30, 30, 30, 30];
  else if (query.includes("frames_received_total")) values = [0, 150, 300, 450, 600];
  else if (query.includes("egress_idle")) values = [0, 0, 0, 0, 0];
  else if (query.includes("memory_usage")) values = [1_000, 1_000, 1_020, 1_030, 1_040];
  else if (query.includes("frame_errors") || query.includes("dropped") || query.includes("freeze_duration") || query.includes("restart") || query.includes("oom_killed")) values = [0, 0, 0, 0, 0];
  return values.map((value, index) => [5 + (index * 5), String(value)]);
}

function run(command, args, envPatch) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...envPatch } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
