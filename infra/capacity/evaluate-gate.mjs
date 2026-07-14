#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const LABEL_VALUE = /^[a-zA-Z0-9_.:-]{1,80}$/;

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

export function resetAwareIncrease(values) {
  let increase = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    increase += delta >= 0 ? delta : values[index];
  }
  return increase;
}

export function memoryGrowthRatio(values) {
  if (values.length < 4) return null;
  const segmentSize = Math.max(2, Math.floor(values.length * 0.2));
  const beginning = percentile(values.slice(0, segmentSize), 0.5);
  const ending = percentile(values.slice(-segmentSize), 0.5);
  if (beginning == null || ending == null || beginning <= 0) return null;
  return (ending - beginning) / beginning;
}

function label(name, value) {
  if (!LABEL_VALUE.test(value)) throw new Error(`invalid ${name}: ${value}`);
  return value;
}

function selector(metric, labels) {
  const values = Object.entries(labels)
    .map(([name, value]) => `${name}="${label(name, String(value))}"`)
    .join(",");
  return `${metric}{${values}}`;
}

export function buildQueries(config) {
  const court = String(config.court);
  const ingest = config.ingest;
  const queries = {};

  for (const branch of config.requiredBranches) {
    queries[`path_ready_${branch}`] = selector("scorecheck_media_path_ready", { agent: ingest.agent, court, branch });
    queries[`path_frame_errors_${branch}`] = selector("scorecheck_media_path_frame_errors_total", { agent: ingest.agent, court, branch });
  }
  queries.raw_bitrate = selector("scorecheck_media_path_inbound_bitrate_bps", { agent: ingest.agent, court, branch: "raw" });

  for (const branch of config.ffmpegBranches) {
    queries[`ffmpeg_fresh_${branch}`] = selector("scorecheck_ffmpeg_progress_fresh", { agent: ingest.agent, court, branch });
    queries[`ffmpeg_fps_${branch}`] = selector("scorecheck_ffmpeg_frames_per_second", { agent: ingest.agent, court, branch });
    queries[`ffmpeg_speed_${branch}`] = selector("scorecheck_ffmpeg_speed_ratio", { agent: ingest.agent, court, branch });
    queries[`ffmpeg_dropped_${branch}`] = selector("scorecheck_ffmpeg_dropped_frames", { agent: ingest.agent, court, branch });
  }

  addServiceQueries(queries, "ingest", ingest);

  if (config.compositor) {
    addServiceQueries(queries, "compositor", config.compositor);
    queries.egress_idle = selector("scorecheck_egress_idle", { agent: config.compositor.agent });
    queries.egress_metrics_valid = selector("scorecheck_egress_metrics_valid", { agent: config.compositor.agent });
  }

  if (config.requireBrowser) {
    queries.browser_fresh = selector("scorecheck_program_browser_heartbeat_fresh", { court });
    queries.browser_fps = selector("scorecheck_program_browser_frames_per_second", { court });
    queries.browser_received = selector("scorecheck_program_browser_frames_received_total", { court });
    queries.browser_dropped = selector("scorecheck_program_browser_frames_dropped_total", { court });
    queries.browser_freeze_duration = selector("scorecheck_program_browser_freeze_duration_seconds_total", { court });
  }

  return queries;
}

function addServiceQueries(queries, prefix, host) {
  const labels = { agent: host.agent, service: host.service };
  queries[`${prefix}_cpu`] = selector("scorecheck_service_cpu_ratio", labels);
  queries[`${prefix}_memory`] = selector("scorecheck_service_memory_usage_bytes", labels);
  queries[`${prefix}_restarts`] = selector("scorecheck_service_restart_total", labels);
  queries[`${prefix}_oom`] = selector("scorecheck_service_oom_killed", labels);
}

function assertConfig(config) {
  if (config.schemaVersion !== 1) throw new Error("capacity gate config schemaVersion must be 1");
  label("gateId", config.gateId);
  if (!Number.isInteger(config.court) || config.court < 1 || config.court > 8) throw new Error("court must be an integer from 1 through 8");
  if (!Array.isArray(config.requiredBranches) || !config.requiredBranches.includes("raw")) throw new Error("requiredBranches must include raw");
  if (!Array.isArray(config.ffmpegBranches)) throw new Error("ffmpegBranches must be an array");
  for (const branch of config.requiredBranches) label("required branch", branch);
  for (const branch of config.ffmpegBranches) label("FFmpeg branch", branch);
  assertHost("ingest", config.ingest);
  if (config.compositor) assertHost("compositor", config.compositor);
  assertSourceProfile(config.expectedSourceProfile);
  if (config.requireBrowser && !config.compositor) throw new Error("requireBrowser requires a compositor");
  if (config.minimumDurationSeconds <= config.warmupSeconds) throw new Error("minimumDurationSeconds must exceed warmupSeconds");
  if (config.stepSeconds < 1 || config.stepSeconds > 60) throw new Error("stepSeconds must be from 1 through 60");
  for (const [name, value] of Object.entries(config.thresholds ?? {})) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`threshold ${name} must be a non-negative number`);
  }
  for (const required of [
    "minimumSampleCoverageRatio", "minimumActiveRatio", "minimumRawBitrateBps",
    "minimumFfmpegFps", "minimumFfmpegSpeed", "minimumBrowserFps",
    "maximumBrowserDropRatio", "maximumBrowserFreezeRatio", "maximumCpuP95Ratio",
    "maximumCpuRatio", "maximumMemoryGrowthRatio", "maximumShmRatio"
  ]) {
    if (!Number.isFinite(config.thresholds?.[required])) throw new Error(`threshold ${required} is required`);
  }
  if (config.thresholds.minimumSampleCoverageRatio > 1 || config.thresholds.minimumActiveRatio > 1) throw new Error("coverage ratios cannot exceed 1");
  if (config.thresholds.maximumCpuP95Ratio > config.thresholds.maximumCpuRatio) throw new Error("maximumCpuP95Ratio cannot exceed maximumCpuRatio");
}

function assertSourceProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("expectedSourceProfile is required");
  for (const field of ["protocol", "mode", "videoCodec", "videoWidth", "videoHeight", "videoProfile", "audioCodec", "audioSampleRateHz", "audioChannelCount"]) {
    const value = profile[field];
    if (typeof value === "string") label(`source profile ${field}`, value);
    else if (!Number.isInteger(value) || value <= 0) throw new Error(`expectedSourceProfile.${field} is invalid`);
  }
}

function assertHost(name, host) {
  if (!host) throw new Error(`${name} host is required`);
  label(`${name} agent`, host.agent);
  label(`${name} service`, host.service);
  if (!Number.isInteger(host.vcpus) || host.vcpus < 1 || host.vcpus > 256) throw new Error(`${name}.vcpus must be a positive integer`);
}

function samplesFor(evidence, name) {
  return evidence.series[name] ?? [];
}

function valuesFor(evidence, name) {
  return samplesFor(evidence, name).map((sample) => sample.value);
}

function addCheck(checks, id, pass, observed, expected) {
  checks.push({ id, pass: Boolean(pass), observed, expected });
}

function requireSamples(checks, evidence, name, minimumCount) {
  const samples = samplesFor(evidence, name);
  addCheck(checks, `${name}_samples`, samples.length >= minimumCount, samples.length, `>= ${minimumCount}`);
  return samples.length >= minimumCount;
}

export function evaluateEvidence(config, evidence, attestations) {
  assertConfig(config);
  const checks = [];
  const durationSeconds = evidence.endEpochSeconds - evidence.startEpochSeconds;
  const evaluatedDurationSeconds = evidence.endEpochSeconds - evidence.effectiveStartEpochSeconds;
  const expectedSamples = Math.floor(evaluatedDurationSeconds / config.stepSeconds) + 1;
  const minimumSamples = Math.max(2, Math.floor(expectedSamples * config.thresholds.minimumSampleCoverageRatio));

  addCheck(checks, "duration", durationSeconds >= config.minimumDurationSeconds, durationSeconds, `>= ${config.minimumDurationSeconds} seconds`);

  for (const branch of config.requiredBranches) {
    const readyName = `path_ready_${branch}`;
    const errorName = `path_frame_errors_${branch}`;
    if (requireSamples(checks, evidence, readyName, minimumSamples)) {
      const values = valuesFor(evidence, readyName);
      addCheck(checks, `${readyName}_continuous`, Math.min(...values) >= 1, Math.min(...values), "1 for every sample");
    }
    if (requireSamples(checks, evidence, errorName, minimumSamples)) {
      const growth = resetAwareIncrease(valuesFor(evidence, errorName));
      addCheck(checks, `${errorName}_growth`, growth === 0, growth, "0");
    }
  }

  if (requireSamples(checks, evidence, "raw_bitrate", minimumSamples)) {
    const p05 = percentile(valuesFor(evidence, "raw_bitrate"), 0.05);
    addCheck(checks, "raw_bitrate_p05", p05 >= config.thresholds.minimumRawBitrateBps, p05, `>= ${config.thresholds.minimumRawBitrateBps}`);
  }

  for (const branch of config.ffmpegBranches) {
    evaluateFfmpeg(checks, evidence, branch, minimumSamples, config.thresholds);
  }

  evaluateHost(checks, evidence, "ingest", config.ingest, minimumSamples, config.thresholds);
  if (config.compositor) {
    evaluateHost(checks, evidence, "compositor", config.compositor, minimumSamples, config.thresholds);
    if (requireSamples(checks, evidence, "egress_idle", minimumSamples)) {
      const activeRatio = valuesFor(evidence, "egress_idle").filter((value) => value < 0.5).length / valuesFor(evidence, "egress_idle").length;
      addCheck(checks, "egress_active_ratio", activeRatio >= config.thresholds.minimumActiveRatio, activeRatio, `>= ${config.thresholds.minimumActiveRatio}`);
    }
    if (requireSamples(checks, evidence, "egress_metrics_valid", minimumSamples)) {
      addCheck(checks, "egress_metrics_continuous", Math.min(...valuesFor(evidence, "egress_metrics_valid")) >= 1, Math.min(...valuesFor(evidence, "egress_metrics_valid")), "1 for every sample");
    }
  }

  if (config.requireBrowser) evaluateBrowser(checks, evidence, minimumSamples, config.thresholds, evaluatedDurationSeconds);
  evaluateAttestations(checks, config, attestations);

  return {
    schemaVersion: 1,
    gateId: config.gateId,
    court: config.court,
    startAt: new Date(evidence.startEpochSeconds * 1000).toISOString(),
    effectiveStartAt: new Date(evidence.effectiveStartEpochSeconds * 1000).toISOString(),
    endAt: new Date(evidence.endEpochSeconds * 1000).toISOString(),
    verdict: checks.every((check) => check.pass) ? "PASS" : "FAIL",
    checks
  };
}

function evaluateFfmpeg(checks, evidence, branch, minimumSamples, thresholds) {
  for (const metric of ["fresh", "fps", "speed", "dropped"]) requireSamples(checks, evidence, `ffmpeg_${metric}_${branch}`, minimumSamples);
  const fresh = valuesFor(evidence, `ffmpeg_fresh_${branch}`);
  const fps = valuesFor(evidence, `ffmpeg_fps_${branch}`);
  const speed = valuesFor(evidence, `ffmpeg_speed_${branch}`);
  const dropped = valuesFor(evidence, `ffmpeg_dropped_${branch}`);
  if (fresh.length >= minimumSamples) addCheck(checks, `ffmpeg_fresh_${branch}_continuous`, Math.min(...fresh) >= 1, Math.min(...fresh), "1 for every sample");
  if (fps.length >= minimumSamples) addCheck(checks, `ffmpeg_fps_${branch}_p05`, percentile(fps, 0.05) >= thresholds.minimumFfmpegFps, percentile(fps, 0.05), `>= ${thresholds.minimumFfmpegFps}`);
  if (speed.length >= minimumSamples) addCheck(checks, `ffmpeg_speed_${branch}_p05`, percentile(speed, 0.05) >= thresholds.minimumFfmpegSpeed, percentile(speed, 0.05), `>= ${thresholds.minimumFfmpegSpeed}`);
  if (dropped.length >= minimumSamples) addCheck(checks, `ffmpeg_dropped_${branch}_growth`, resetAwareIncrease(dropped) === 0, resetAwareIncrease(dropped), "0");
}

function evaluateHost(checks, evidence, prefix, host, minimumSamples, thresholds) {
  for (const metric of ["cpu", "memory", "restarts", "oom"]) requireSamples(checks, evidence, `${prefix}_${metric}`, minimumSamples);
  const cpu = valuesFor(evidence, `${prefix}_cpu`).map((value) => value / host.vcpus);
  const memory = valuesFor(evidence, `${prefix}_memory`);
  const restarts = valuesFor(evidence, `${prefix}_restarts`);
  const oom = valuesFor(evidence, `${prefix}_oom`);
  if (cpu.length >= minimumSamples) {
    addCheck(checks, `${prefix}_cpu_p95`, percentile(cpu, 0.95) <= thresholds.maximumCpuP95Ratio, percentile(cpu, 0.95), `<= ${thresholds.maximumCpuP95Ratio}`);
    addCheck(checks, `${prefix}_cpu_max`, Math.max(...cpu) < thresholds.maximumCpuRatio, Math.max(...cpu), `< ${thresholds.maximumCpuRatio}`);
  }
  if (memory.length >= minimumSamples) {
    const growth = memoryGrowthRatio(memory);
    addCheck(checks, `${prefix}_memory_growth`, growth != null && growth <= thresholds.maximumMemoryGrowthRatio, growth, `<= ${thresholds.maximumMemoryGrowthRatio}`);
  }
  if (restarts.length >= minimumSamples) addCheck(checks, `${prefix}_restart_growth`, resetAwareIncrease(restarts) === 0, resetAwareIncrease(restarts), "0");
  if (oom.length >= minimumSamples) addCheck(checks, `${prefix}_oom`, Math.max(...oom) === 0, Math.max(...oom), "0");
}

function evaluateBrowser(checks, evidence, minimumSamples, thresholds, durationSeconds) {
  for (const metric of ["fresh", "fps", "received", "dropped", "freeze_duration"]) requireSamples(checks, evidence, `browser_${metric}`, minimumSamples);
  const fresh = valuesFor(evidence, "browser_fresh");
  const fps = valuesFor(evidence, "browser_fps");
  const received = valuesFor(evidence, "browser_received");
  const dropped = valuesFor(evidence, "browser_dropped");
  const freezeDuration = valuesFor(evidence, "browser_freeze_duration");
  if (fresh.length >= minimumSamples) {
    const freshRatio = fresh.filter((value) => value >= 1).length / fresh.length;
    addCheck(checks, "browser_fresh_ratio", freshRatio >= thresholds.minimumActiveRatio, freshRatio, `>= ${thresholds.minimumActiveRatio}`);
  }
  if (fps.length >= minimumSamples) addCheck(checks, "browser_fps_p05", percentile(fps, 0.05) >= thresholds.minimumBrowserFps, percentile(fps, 0.05), `>= ${thresholds.minimumBrowserFps}`);
  if (received.length >= minimumSamples && dropped.length >= minimumSamples) {
    const receivedGrowth = resetAwareIncrease(received);
    const dropRatio = resetAwareIncrease(dropped) / Math.max(1, receivedGrowth);
    addCheck(checks, "browser_drop_ratio", dropRatio <= thresholds.maximumBrowserDropRatio, dropRatio, `<= ${thresholds.maximumBrowserDropRatio}`);
  }
  if (freezeDuration.length >= minimumSamples) {
    const freezeRatio = resetAwareIncrease(freezeDuration) / Math.max(1, durationSeconds);
    addCheck(checks, "browser_freeze_ratio", freezeRatio <= thresholds.maximumBrowserFreezeRatio, freezeRatio, `<= ${thresholds.maximumBrowserFreezeRatio}`);
  }
}

function evaluateAttestations(checks, config, attestations) {
  for (const [field, expected] of Object.entries(config.expectedSourceProfile)) {
    const observed = attestations.observedSourceProfile?.[field] ?? null;
    addCheck(checks, `source_profile_${field}`, observed === expected, observed, expected);
  }
  addCheck(checks, "assignment_verified", attestations.assignmentVerified === true, attestations.assignmentVerified ?? null, true);
  addCheck(checks, "unassigned_courts_unaffected", attestations.unassignedCourtsUnaffected === true, attestations.unassignedCourtsUnaffected ?? null, true);
  addCheck(checks, "ingest_zombie_growth", attestations.ingestZombieGrowth === 0, attestations.ingestZombieGrowth ?? null, 0);
  addCheck(checks, "ingest_host_cpu_p95", Number.isFinite(attestations.ingestHostCpuP95Ratio) && attestations.ingestHostCpuP95Ratio <= config.thresholds.maximumCpuP95Ratio, attestations.ingestHostCpuP95Ratio ?? null, `<= ${config.thresholds.maximumCpuP95Ratio}`);
  addCheck(checks, "ingest_host_cpu_max", Number.isFinite(attestations.ingestHostCpuMaxRatio) && attestations.ingestHostCpuMaxRatio < config.thresholds.maximumCpuRatio, attestations.ingestHostCpuMaxRatio ?? null, `< ${config.thresholds.maximumCpuRatio}`);
  if (config.compositor) {
    addCheck(checks, "compositor_zombie_growth", attestations.compositorZombieGrowth === 0, attestations.compositorZombieGrowth ?? null, 0);
    addCheck(checks, "compositor_host_cpu_p95", Number.isFinite(attestations.compositorHostCpuP95Ratio) && attestations.compositorHostCpuP95Ratio <= config.thresholds.maximumCpuP95Ratio, attestations.compositorHostCpuP95Ratio ?? null, `<= ${config.thresholds.maximumCpuP95Ratio}`);
    addCheck(checks, "compositor_host_cpu_max", Number.isFinite(attestations.compositorHostCpuMaxRatio) && attestations.compositorHostCpuMaxRatio < config.thresholds.maximumCpuRatio, attestations.compositorHostCpuMaxRatio ?? null, `< ${config.thresholds.maximumCpuRatio}`);
    addCheck(checks, "egress_errors", attestations.egressErrors === 0, attestations.egressErrors ?? null, 0);
    addCheck(checks, "egress_shm_max_ratio", Number.isFinite(attestations.egressShmMaxRatio) && attestations.egressShmMaxRatio < config.thresholds.maximumShmRatio, attestations.egressShmMaxRatio ?? null, `< ${config.thresholds.maximumShmRatio}`);
  }
}

function boundedAttestations(input) {
  return {
    observedSourceProfile: boundedSourceProfile(input.observedSourceProfile),
    assignmentVerified: input.assignmentVerified === true,
    unassignedCourtsUnaffected: input.unassignedCourtsUnaffected === true,
    ingestZombieGrowth: Number.isFinite(input.ingestZombieGrowth) ? input.ingestZombieGrowth : null,
    ingestHostCpuP95Ratio: boundedNumber(input.ingestHostCpuP95Ratio),
    ingestHostCpuMaxRatio: boundedNumber(input.ingestHostCpuMaxRatio),
    compositorZombieGrowth: Number.isFinite(input.compositorZombieGrowth) ? input.compositorZombieGrowth : null,
    compositorHostCpuP95Ratio: boundedNumber(input.compositorHostCpuP95Ratio),
    compositorHostCpuMaxRatio: boundedNumber(input.compositorHostCpuMaxRatio),
    egressErrors: Number.isFinite(input.egressErrors) ? input.egressErrors : null,
    egressShmMaxRatio: Number.isFinite(input.egressShmMaxRatio) ? input.egressShmMaxRatio : null
  };
}

function boundedSourceProfile(profile) {
  const output = {};
  for (const field of ["protocol", "mode", "videoCodec", "videoWidth", "videoHeight", "videoProfile", "audioCodec", "audioSampleRateHz", "audioChannelCount"]) {
    const value = profile?.[field];
    output[field] = typeof value === "string" || Number.isFinite(value) ? value : null;
  }
  return output;
}

function boundedNumber(value) {
  return Number.isFinite(value) ? value : null;
}

async function queryRange(prometheusUrl, query, start, end, step, token) {
  const url = new URL("api/v1/query_range", `${prometheusUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("query", query);
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));
  url.searchParams.set("step", String(step));
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`Prometheus query failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.status !== "success") throw new Error("Prometheus query did not return success");
  if (payload.data.result.length !== 1) return [];
  return payload.data.result[0].values
    .map(([timestamp, value]) => ({ timestamp: Number(timestamp), value: Number(value) }))
    .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.value));
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument near ${key ?? "end of command"}`);
    values[key.slice(2)] = value;
  }
  for (const required of ["config", "attestations", "prometheus-url", "start", "end", "output"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(args.config, "utf8"));
  const attestations = boundedAttestations(JSON.parse(await readFile(args.attestations, "utf8")));
  assertConfig(config);
  const startEpochSeconds = Date.parse(args.start) / 1000;
  const endEpochSeconds = Date.parse(args.end) / 1000;
  if (!Number.isFinite(startEpochSeconds) || !Number.isFinite(endEpochSeconds) || endEpochSeconds <= startEpochSeconds) throw new Error("--start and --end must define a valid increasing ISO-8601 window");
  const effectiveStartEpochSeconds = startEpochSeconds + config.warmupSeconds;
  const queries = buildQueries(config);
  const token = process.env.SCORECHECK_PROMETHEUS_BEARER_TOKEN ?? "";
  const entries = await Promise.all(Object.entries(queries).map(async ([name, query]) => [
    name,
    (await queryRange(args["prometheus-url"], query, effectiveStartEpochSeconds, endEpochSeconds, config.stepSeconds, token))
  ]));
  const evidence = { startEpochSeconds, effectiveStartEpochSeconds, endEpochSeconds, series: Object.fromEntries(entries) };
  const report = evaluateEvidence(config, evidence, attestations);
  await writeFile(args.output, `${JSON.stringify({ ...report, configuration: config, attestations, evidence }, null, 2)}\n`, { mode: 0o600 });
  await chmod(args.output, 0o600);
  process.stdout.write(`${report.verdict}: ${report.gateId} (${report.checks.filter((check) => !check.pass).length} failed checks)\n`);
  process.exitCode = report.verdict === "PASS" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`capacity gate error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
