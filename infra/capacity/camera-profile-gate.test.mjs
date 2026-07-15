import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildFfprobeArgs,
  evaluateCameraProfileGate,
  parseEvidenceNdjson,
  parseFrameRate,
  sanitizeProbeStreams,
  sanitizeSnapshot
} from "./camera-profile-gate.mjs";

const cliPath = fileURLToPath(new URL("./camera-profile-gate.mjs", import.meta.url));

test("parses rational frame rates and builds a credential-free raw-path probe", () => {
  assert.equal(parseFrameRate("30000/1001"), 30000 / 1001);
  assert.equal(parseFrameRate("30/1"), 30);
  assert.equal(parseFrameRate("0/0"), null);
  const args = buildFfprobeArgs(new URL("rtsp://127.0.0.1:18554/"), 3);
  assert.equal(args.at(-1), "rtsp://127.0.0.1:18554/court3_raw");
  assert(!args.join(" ").includes("streamid"));
});

test("sanitizes monitor and ffprobe payloads", () => {
  const snapshot = monitorSnapshot(new Date(0).toISOString());
  snapshot.secret = "must-not-survive";
  snapshot.courts[0].paths.raw.sourceUrl = "srt://credential-bearing-value";
  const sanitized = sanitizeSnapshot(snapshot, [3], new Date(0).toISOString(), new Date(0).toISOString());
  const serialized = JSON.stringify(sanitized);
  assert(!serialized.includes("must-not-survive"));
  assert(!serialized.includes("sourceUrl"));
  assert.deepEqual(sanitized.courts[0].raw.videoCodec, "H264");

  const streams = sanitizeProbeStreams({ streams: [
    { index: 0, codec_type: "video", codec_name: "h264", profile: "Main", width: 1280, height: 720, r_frame_rate: "30/1", avg_frame_rate: "30/1", extraneous: "secret" }
  ] });
  assert.equal(streams[0].avgFrameRate, "30/1");
  assert(!JSON.stringify(streams).includes("extraneous"));
});

test("passes bounded stable camera profile evidence", () => {
  const gateConfig = config();
  const evidence = healthyEvidence();
  const report = evaluateCameraProfileGate(gateConfig, evidence, healthyProbes(), sourceEvidence());
  assert.equal(report.verdict, "PASS");
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.qualification.requiredCourts, [3]);
  assert.equal(report.qualification.minimumDurationSeconds, 2);
  assert.equal(report.qualification.thresholds.minimumSampleCoverageRatio, 0.9);
  assert.deepEqual(report.sourceEvidence, sourceEvidence());
  assert.deepEqual(report.qualification.expectedProfiles["3"], gateConfig.expectedProfiles["3"]);
  assert.equal(report.checks.filter((check) => !check.pass).length, 0);
  assert.equal(report.observedCourts[3].bitrateP05, 2_500_000);
  assert.equal(report.observedCourts[3].probeFps[0], 30);
  assert.equal(report.observedCourts[3].probeSampledAt, "2026-01-01T00:00:01Z");
  assert.deepEqual(report.observedCourts[3].probeProfile, {
    videoCodec: "h264",
    videoProfile: "Main",
    videoWidth: 1280,
    videoHeight: 720,
    videoFps: 30,
    audioCodec: "aac",
    audioSampleRateHz: 48000,
    audioChannelCount: 2
  });
});

test("fails sparse, restarted, malformed, and degraded camera evidence", () => {
  const gateConfig = config();
  const evidence = healthyEvidence();
  evidence.samples.splice(1, 1);
  evidence.samples[1].incidentCount = 1;
  evidence.samples[1].courts[0].raw.readySince = "2026-01-01T00:00:01Z";
  evidence.samples[1].courts[0].raw.videoCodec = "H265";
  evidence.samples[1].courts[0].raw.frameErrors = 2;
  evidence.samples[1].courts[0].raw.bytesReceived = 900;
  const probes = healthyProbes();
  probes.courts[0].streams[0].avgFrameRate = "25/1";
  const report = evaluateCameraProfileGate(gateConfig, evidence, probes, sourceEvidence());
  assert.equal(report.verdict, "FAIL");
  const failed = new Set(report.checks.filter((check) => !check.pass).map((check) => check.id));
  assert(failed.has("sample_coverage"));
  assert(failed.has("sample_max_gap"));
  assert(failed.has("incidents_absent"));
  assert(failed.has("court_3_frame_error_growth"));
  assert(failed.has("court_3_bytes_monotonic"));
  assert(failed.has("court_3_publisher_continuity"));
  assert(failed.has("court_3_monitor_videoCodec"));
  assert([...failed].some((id) => id.endsWith("_fps")));
});

test("fails duplicate or off-grid scheduled samples even when count coverage passes", () => {
  const evidence = healthyEvidence();
  evidence.samples[2].scheduledAt = evidence.samples[1].scheduledAt;
  const report = evaluateCameraProfileGate(config(), evidence, healthyProbes(), sourceEvidence());
  const failed = new Set(report.checks.filter((check) => !check.pass).map((check) => check.id));
  assert.equal(report.verdict, "FAIL");
  assert(failed.has("sample_schedule_unique"));

  const offGrid = healthyEvidence();
  offGrid.samples[1].scheduledAt = "2026-01-01T00:00:01.500Z";
  const offGridReport = evaluateCameraProfileGate(config(), offGrid, healthyProbes(), sourceEvidence());
  assert(offGridReport.checks.some((check) => check.id === "sample_schedule_aligned" && !check.pass));

  const early = healthyEvidence();
  early.samples[1].sampledAt = "2026-01-01T00:00:00.999Z";
  const earlyReport = evaluateCameraProfileGate(config(), early, healthyProbes(), sourceEvidence());
  assert(earlyReport.checks.some((check) => check.id === "sample_times_bounded" && !check.pass));
});

test("requires exactly one bounded probe per court", () => {
  const probes = healthyProbes();
  probes.courts.push(structuredClone(probes.courts[0]));
  const report = evaluateCameraProfileGate(config(), healthyEvidence(), probes, sourceEvidence());
  assert.equal(report.verdict, "FAIL");
  assert(report.checks.some((check) => check.id === "court_3_probe_count" && !check.pass));
});

test("requires sanitized source artifact digests", () => {
  const report = evaluateCameraProfileGate(config(), healthyEvidence(), healthyProbes());
  assert.equal(report.verdict, "FAIL");
  assert(report.checks.some((check) => check.id === "source_evidence_digests" && !check.pass));
});

test("parses run, sample, and bounded error records", () => {
  const parsed = parseEvidenceNdjson([
    JSON.stringify(healthyEvidence().run),
    JSON.stringify(healthyEvidence().samples[0]),
    JSON.stringify({ recordType: "error", schemaVersion: 1, code: "SAMPLE_SLOT_MISSED" })
  ].join("\n"));
  assert.equal(parsed.samples.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.throws(() => parseEvidenceNdjson('{"recordType":"unknown"}\n'), /unknown evidence recordType/);
});

test("sample CLI uses fixed protected credential-free evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-camera-sample-"));
  const configPath = join(directory, "config.json");
  const outputPath = join(directory, "samples.ndjson");
  const gateConfig = config({ minimumDurationSeconds: 1, intervalSeconds: 1 });
  await writeFile(configPath, JSON.stringify(gateConfig));
  let requests = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-monitor-token");
    requests += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(monitorSnapshot(new Date().toISOString())));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const result = await run(process.execPath, [
      cliPath,
      "sample",
      "--config", configPath,
      "--monitor-url", `http://127.0.0.1:${address.port}`,
      "--duration-seconds", "1",
      "--output", outputPath
    ], { SCORECHECK_MONITOR_API_TOKEN: "test-monitor-token" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requests, 2);
    const contents = await readFile(outputPath, "utf8");
    assert(!contents.includes("test-monitor-token"));
    assert(!contents.includes("must-not-survive"));
    const evidence = parseEvidenceNdjson(contents);
    assert.equal(evidence.samples.length, 2);
    assert.equal(evidence.errors.length, 0);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);

    const unsafeResult = await run(process.execPath, [
      cliPath,
      "sample",
      "--config", configPath,
      "--monitor-url", "https://example.invalid?token=must-not-enter-process-args",
      "--duration-seconds", "1",
      "--output", join(directory, "unsafe.ndjson")
    ], { SCORECHECK_MONITOR_API_TOKEN: "test-monitor-token" });
    assert.equal(unsafeResult.code, 1);
    assert.match(unsafeResult.stderr, /must not contain credentials, query parameters, or fragments/);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("probe and evaluate CLIs write protected sanitized evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-camera-probe-"));
  const configPath = join(directory, "config.json");
  const probePath = join(directory, "probes.json");
  const evidencePath = join(directory, "samples.ndjson");
  const reportPath = join(directory, "report.json");
  const fakeFfprobe = join(directory, "fake-ffprobe.mjs");
  const gateConfig = config();
  await writeFile(configPath, JSON.stringify(gateConfig));
  await writeFile(fakeFfprobe, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${JSON.stringify(rawProbePayload())}));\n`, { mode: 0o755 });
  await chmod(fakeFfprobe, 0o755);
  try {
    const probeResult = await run(process.execPath, [
      cliPath,
      "probe",
      "--config", configPath,
      "--rtsp-base-url", "rtsp://127.0.0.1:8554/",
      "--ffprobe-bin", fakeFfprobe,
      "--output", probePath
    ]);
    assert.equal(probeResult.code, 0, probeResult.stderr);
    const probeText = await readFile(probePath, "utf8");
    assert(!probeText.includes("rtsp://"));
    assert(!probeText.includes("credential"));
    assert.equal((await stat(probePath)).mode & 0o777, 0o600);

    const probes = JSON.parse(probeText);
    const evidence = healthyEvidence();
    probes.courts[0].sampledAt = "2026-01-01T00:00:01Z";
    await writeFile(probePath, `${JSON.stringify(probes)}\n`, { mode: 0o600 });
    await writeFile(evidencePath, [evidence.run, ...evidence.samples].map((record) => JSON.stringify(record)).join("\n"));
    const evaluateResult = await run(process.execPath, [
      cliPath,
      "evaluate",
      "--config", configPath,
      "--evidence", evidencePath,
      "--probes", probePath,
      "--output", reportPath
    ]);
    assert.equal(evaluateResult.code, 0, evaluateResult.stderr);
    assert.equal(JSON.parse(await readFile(reportPath, "utf8")).verdict, "PASS");
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function config(overrides = {}) {
  const minimumDurationSeconds = overrides.minimumDurationSeconds ?? 2;
  const intervalSeconds = overrides.intervalSeconds ?? 1;
  return {
    schemaVersion: 1,
    gateId: "camera-profile-test",
    requiredCourts: [3],
    minimumDurationSeconds,
    intervalSeconds,
    thresholds: {
      minimumSampleCoverageRatio: 0.9,
      maximumSampleGapSeconds: 1.5,
      maximumEdgeGapSeconds: 1.5,
      maximumSampleLatenessMs: 500,
      maximumSnapshotAgeMs: 10_000,
      minimumRawBitrateBps: 2_000_000,
      maximumProbeOffsetSeconds: 30
    },
    expectedProfiles: {
      "3": {
        sourceProtocol: "SRT",
        sourceMode: "PUSH",
        videoCodec: "H264",
        videoProfilesAllowed: ["Main"],
        videoWidth: 1280,
        videoHeight: 720,
        minimumFps: 29,
        maximumFps: 31,
        audioCodec: "AAC",
        audioSampleRateHz: 48_000,
        audioChannelCount: 2
      }
    }
  };
}

function healthyEvidence() {
  const times = [0, 1, 2].map((offset) => `2026-01-01T00:00:0${offset}Z`);
  return {
    run: {
      recordType: "run",
      schemaVersion: 1,
      gateId: "camera-profile-test",
      requiredCourts: [3],
      plannedStartAt: times[0],
      plannedEndAt: times[2],
      intervalSeconds: 1
    },
    samples: times.map((sampledAt, index) => ({
      recordType: "sample",
      schemaVersion: 1,
      sampledAt,
      scheduledAt: sampledAt,
      generatedAt: sampledAt,
      collector: { state: "HEALTHY", agentsExpected: 6, agentsFresh: 6 },
      incidentCount: 0,
      faultGateCount: 0,
      courts: [{
        courtNumber: 3,
        overallState: "HEALTHY",
        raw: rawPath({ bytesReceived: 1_000 + index * 500 })
      }]
    })),
    errors: []
  };
}

function healthyProbes() {
  return {
    schemaVersion: 1,
    gateId: "camera-profile-test",
    generatedAt: "2026-01-01T00:00:01Z",
    courts: [{ courtNumber: 3, sampledAt: "2026-01-01T00:00:01Z", streams: sanitizeProbeStreams(rawProbePayload()) }]
  };
}

function rawProbePayload() {
  return {
    credential: "must-not-survive",
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", profile: "Main", width: 1280, height: 720, r_frame_rate: "30/1", avg_frame_rate: "30/1" },
      { index: 1, codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2, r_frame_rate: "0/0", avg_frame_rate: "0/0" }
    ]
  };
}

function monitorSnapshot(generatedAt) {
  return {
    generatedAt,
    secret: "must-not-survive",
    collector: { state: "HEALTHY", agentsExpected: 6, agentsFresh: 6 },
    incidents: [],
    faultGates: [],
    courts: [{ courtNumber: 3, overallState: "HEALTHY", paths: { raw: rawPath() } }]
  };
}

function rawPath(overrides = {}) {
  return {
    ready: true,
    readySince: "2026-01-01T00:00:00Z",
    inboundBitrateBps: 2_500_000,
    bytesReceived: 1_000,
    frameErrors: 0,
    sourceProtocol: "SRT",
    sourceMode: "PUSH",
    videoCodec: "H264",
    videoProfile: "Main",
    videoWidth: 1280,
    videoHeight: 720,
    audioCodec: "AAC",
    audioSampleRateHz: 48_000,
    audioChannelCount: 2,
    ...overrides
  };
}

function sourceEvidence() {
  return { samplesSha256: "a".repeat(64), probesSha256: "b".repeat(64) };
}

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
