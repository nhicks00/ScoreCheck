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
  assert.match(queries.ffmpeg_speed_available_preview, /^scorecheck_ffmpeg_speed_available\{/);
  assert.match(queries.egress_active_web_requests, /^scorecheck_egress_active_web_requests\{/);
  assert.throws(() => buildQueries({ ...config(), ingest: { ...config().ingest, agent: 'bad"}' } }), /invalid agent/);
});

test("rejects missing hard acceptance thresholds", () => {
  const gateConfig = config();
  delete gateConfig.thresholds.maximumShmRatio;
  assert.throws(() => evaluateEvidence(gateConfig, healthyEvidence(config()), attestations(), hostEvidence(), zombieEvidence()), /maximumShmRatio is required/);
});

test("checked-in c-4 profile requires a clean process baseline", async () => {
  const profile = JSON.parse(await readFile(new URL("./court1-c4.example.json", import.meta.url), "utf8"));
  assert.deepEqual(profile.allowedBaselineUnclassified, { ingest: [], compositor: [] });
});

test("passes complete healthy evidence", () => {
  const gateConfig = config();
  const evidence = healthyEvidence(gateConfig);
  const report = evaluateEvidence(gateConfig, evidence, attestations(), hostEvidence(), zombieEvidence());
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
    egressShmEnabled: false,
    observedSourceProfile: { ...attestations().observedSourceProfile, videoCodec: "H265" }
  }, { ...hostEvidence(), coverageRatio: 0.6 }, {
    ...zombieEvidence(),
    roles: {
      ...zombieEvidence().roles,
      ingest: {
        ...zombieEvidence().roles.ingest,
        newUnclassifiedCount: 1,
        newUnclassifiedEvents: [{ identity: "123:456", command: "pactl", classification: "unclassified" }]
      }
    }
  });
  assert.equal(report.verdict, "FAIL");
  const failed = new Set(report.checks.filter((check) => !check.pass).map((check) => check.id));
  assert(failed.has("browser_drop_ratio"));
  assert(failed.has("ingest_cpu_max"));
  assert(failed.has("ingest_new_unclassified_zombies"));
  assert(failed.has("host_sample_coverage"));
  assert(failed.has("egress_shm_enabled"));
  assert(failed.has("source_profile_videoCodec"));
});

test("CLI queries Prometheus and writes a protected credential-free report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-capacity-"));
  const configPath = join(directory, "config.json");
  const attestationPath = join(directory, "attestations.json");
  const hostSamplesPath = join(directory, "host-samples.csv");
  const zombieEventsPath = join(directory, "zombie-events.ndjson");
  const outputPath = join(directory, "report.json");
  await writeFile(configPath, JSON.stringify(config()));
  await writeFile(attestationPath, JSON.stringify({ ...attestations(), ignoredSecret: "must-not-survive" }));
  await writeFile(hostSamplesPath, healthyHostSamplesCsv());
  await writeFile(zombieEventsPath, healthyZombieEventsNdjson());

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
      "--host-samples", hostSamplesPath,
      "--zombie-events", zombieEventsPath,
      "--prometheus-url", `http://127.0.0.1:${address.port}`,
      "--start", "1970-01-01T00:00:00Z",
      "--end", "1970-01-01T00:00:25Z",
      "--output", outputPath
    ], { SCORECHECK_PROMETHEUS_BEARER_TOKEN: "test-only-token" });
    assert.equal(result.code, 0, result.stderr);
    const reportText = await readFile(outputPath, "utf8");
    const report = JSON.parse(reportText);
    assert.equal(report.verdict, "PASS");
    assert.equal(report.hostEvidence.coverageRatio, 1);
    assert.equal(report.hostEvidence.maxGapSeconds, 5);
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
    schemaVersion: 2,
    gateId: "court1-c4",
    court: 1,
    minimumDurationSeconds: 20,
    warmupSeconds: 5,
    stepSeconds: 5,
    requiredBranches: ["raw", "preview", "program"],
    ffmpegBranches: ["preview", "program"],
    expectedSourceProfile: sourceProfile(),
    allowedBaselineUnclassified: { ingest: [], compositor: [] },
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
      maximumHostSampleGapSeconds: 7.5,
      maximumHostSampleLagMs: 500,
      maximumShmRatio: 0.8,
      maximumZombieWatcherHeartbeatGapSeconds: 2,
      maximumZombieWatcherScanGapMs: 250,
      maximumZombiePollIntervalMs: 50,
      maximumObserverZombieDurationMs: 2_000,
      maximumObserverZombieEvents: 100,
      maximumObserverZombieEventsPerMinute: 20,
      maximumWorkloadZombieDurationMs: 500,
      maximumWorkloadZombieEvents: 16,
      maximumWorkloadZombieEventsPerMinute: 8,
      maximumWorkloadConcurrentZombies: 1
    }
  };
}

function attestations() {
  return {
    observedSourceProfile: sourceProfile(),
    assignmentVerified: true,
    unassignedCourtsUnaffected: true,
    egressErrors: 0,
    egressShmEnabled: true
  };
}

function hostEvidence() {
  return {
    coverageRatio: 1,
    p95GapSeconds: 5,
    maxGapSeconds: 5,
    startEdgeGapSeconds: 0,
    endEdgeGapSeconds: 0,
    baselineAgeSeconds: 5,
    ingestSampleLagP95Ms: 20,
    ingestSampleLagMaxMs: 25,
    ingestHostCpuP95Ratio: 0.6,
    ingestHostCpuMaxRatio: 0.7,
    compositorHostCpuP95Ratio: 0.55,
    compositorHostCpuMaxRatio: 0.65,
    compositorSampleLagP95Ms: 22,
    compositorSampleLagMaxMs: 30,
    egressShmMaxRatio: 0.4
  };
}

test("fails clustered host samples that conceal a long blind spot", () => {
  const gateConfig = config();
  const report = evaluateEvidence(gateConfig, healthyEvidence(gateConfig), attestations(), {
    ...hostEvidence(),
    coverageRatio: 1,
    p95GapSeconds: 5,
    maxGapSeconds: 30
  }, zombieEvidence());
  const failed = new Set(report.checks.filter((check) => !check.pass).map((check) => check.id));
  assert(failed.has("host_sample_gap_max"));
  assert(!failed.has("host_sample_coverage"));
  assert(!failed.has("host_sample_gap_p95"));
});

test("fails when a pre-existing zombie does not match the exact baseline allowlist", () => {
  const gateConfig = config();
  const baseline = {
    command: "timeout",
    parentCommand: "mediamtx",
    cgroupFingerprint: "480b4be510e9d52c"
  };
  const processEvidence = zombieEvidence();
  processEvidence.roles.ingest.baselineUnclassifiedCount = 1;
  processEvidence.roles.ingest.baselineUnclassifiedEvents = [baseline];
  const report = evaluateEvidence(gateConfig, healthyEvidence(gateConfig), attestations(), hostEvidence(), processEvidence);
  const failed = new Set(report.checks.filter((check) => !check.pass).map((check) => check.id));
  assert(failed.has("ingest_baseline_unclassified_zombies"));

  gateConfig.allowedBaselineUnclassified.ingest = [baseline];
  assert.equal(evaluateEvidence(gateConfig, healthyEvidence(gateConfig), attestations(), hostEvidence(), processEvidence).verdict, "PASS");
});

test("fails uncovered host-sample window edges independently of count coverage", () => {
  const gateConfig = config();
  const report = evaluateEvidence(gateConfig, healthyEvidence(gateConfig), attestations(), {
    ...hostEvidence(),
    coverageRatio: 1,
    startEdgeGapSeconds: 8,
    endEdgeGapSeconds: 9
  }, zombieEvidence());
  const failed = new Set(report.checks.filter((check) => !check.pass).map((check) => check.id));
  assert(failed.has("host_sample_start_edge_gap"));
  assert(failed.has("host_sample_end_edge_gap"));
  assert(!failed.has("host_sample_coverage"));
});

test("fails persistent or accumulating Egress workload child waits", () => {
  const gateConfig = config();
  const processEvidence = zombieEvidence();
  Object.assign(processEvidence.roles.compositor, {
    workloadEventCount: 17,
    workloadClassifications: { "workload.egress-chrome": 16, "workload.egress-pactl": 1 },
    workloadMaximumDurationMs: 501,
    workloadMaximumRollingMinuteCount: 9,
    workloadMaximumConcurrentCount: 2,
    unclosedWorkloadCount: 1
  });
  const report = evaluateEvidence(gateConfig, healthyEvidence(gateConfig), attestations(), hostEvidence(), processEvidence);
  const failed = new Set(report.checks.filter((check) => !check.pass).map((check) => check.id));
  for (const suffix of ["duration", "count", "rate", "concurrency", "closure"]) {
    assert(failed.has(`compositor_workload_zombie_${suffix}`));
  }
  assert(!failed.has("compositor_new_unclassified_zombies"));
});

function healthyHostSamplesCsv() {
  const rows = [];
  for (let second = -5; second <= 25; second += 5) {
    rows.push(`${new Date(second * 1_000).toISOString()},0.4,20,0.5,25,0.4,1`);
  }
  return [
    "sampled_at,ingest_cpu_ratio,ingest_sample_lag_ms,compositor_cpu_ratio,compositor_sample_lag_ms,egress_shm_ratio,sample_ok",
    ...rows
  ].join("\n");
}

function zombieEvidence() {
  const role = {
    watcherStartedAt: "1969-12-31T23:59:58.000Z",
    pollIntervalMs: 50,
    watcherRestarts: 0,
    watcherStops: 0,
    heartbeatSamples: 26,
    startEdgeGapSeconds: 1,
    endEdgeGapSeconds: 0,
    maximumHeartbeatGapSeconds: 1,
    maximumScanGapMs: 55,
    baselineUnclassifiedCount: 0,
    baselineUnclassifiedIdentities: [],
    baselineUnclassifiedEvents: [],
    newUnclassifiedCount: 0,
    newUnclassifiedEvents: [],
    observerEventCount: 0,
    observerClassifications: {},
    observerMaximumDurationMs: null,
    observerMaximumRollingMinuteCount: 0,
    workloadEventCount: 0,
    workloadClassifications: {},
    workloadMaximumDurationMs: null,
    workloadMaximumRollingMinuteCount: 0,
    workloadMaximumConcurrentCount: 0,
    maximumConcurrentZombies: 0,
    unclosedObserverCount: 0,
    unclosedWorkloadCount: 0,
    orphanCloseCount: 0
  };
  return { schemaVersion: 1, roles: { ingest: { ...role }, compositor: { ...role } } };
}

function healthyZombieEventsNdjson() {
  const events = [];
  for (const [index, role] of ["ingest", "compositor"].entries()) {
    events.push({ schemaVersion: 1, role, event: "watcher_started", observedAt: new Date(-2_000).toISOString(), pollIntervalMs: 50, watcherPid: 900 + index });
    for (let second = -1; second <= 26; second += 1) {
      events.push({ schemaVersion: 1, role, event: "heartbeat", observedAt: new Date(second * 1_000).toISOString(), scanCount: second + 2, activeZombieCount: 0, maximumScanGapMs: 55 });
    }
  }
  return events
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .map((event) => JSON.stringify(event))
    .join("\n");
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
  evidence.series.egress_can_accept = series([0, 0, 0, 0, 0]);
  evidence.series.egress_active_web_requests = series([1, 1, 1, 1, 1]);
  evidence.series.egress_maximum_web_requests = series([1, 1, 1, 1, 1]);
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
  else if (query.includes("egress_can_accept_request")) values = [0, 0, 0, 0, 0];
  else if (query.includes("egress_active_web_requests") || query.includes("egress_maximum_web_requests")) values = [1, 1, 1, 1, 1];
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
