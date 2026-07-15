#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, open, readFile, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,80}$/;
const SAFE_HOST = /^[a-zA-Z0-9_.:@-]{1,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROFILE_FIELDS = [
  "sourceProtocol",
  "sourceMode",
  "videoCodec",
  "videoWidth",
  "videoHeight",
  "audioCodec",
  "audioSampleRateHz",
  "audioChannelCount"
];

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function parseTime(value, name) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp`);
  return parsed;
}

function addCheck(checks, id, pass, observed, expected) {
  checks.push({ id, pass: Boolean(pass), observed, expected });
}

function validateConfig(config) {
  if (config?.schemaVersion !== 1) throw new Error("camera profile config schemaVersion must be 1");
  if (!SAFE_ID.test(config.gateId ?? "")) throw new Error("gateId is invalid");
  if (!Array.isArray(config.requiredCourts) || config.requiredCourts.length === 0) throw new Error("requiredCourts must be a non-empty array");
  const courts = new Set();
  for (const court of config.requiredCourts) {
    if (!Number.isInteger(court) || court < 1 || court > 8) throw new Error("requiredCourts must contain integers from 1 through 8");
    if (courts.has(court)) throw new Error(`requiredCourts contains duplicate court ${court}`);
    courts.add(court);
  }
  if (!Number.isInteger(config.minimumDurationSeconds) || config.minimumDurationSeconds < 1) throw new Error("minimumDurationSeconds must be a positive integer");
  if (!Number.isInteger(config.intervalSeconds) || config.intervalSeconds < 1 || config.intervalSeconds > 60) throw new Error("intervalSeconds must be from 1 through 60");
  if (config.minimumDurationSeconds < config.intervalSeconds) throw new Error("minimumDurationSeconds must be at least intervalSeconds");

  const requiredThresholds = [
    "minimumSampleCoverageRatio",
    "maximumSampleGapSeconds",
    "maximumEdgeGapSeconds",
    "maximumSampleLatenessMs",
    "maximumSnapshotAgeMs",
    "minimumRawBitrateBps",
    "maximumProbeOffsetSeconds"
  ];
  for (const name of requiredThresholds) {
    if (!finite(config.thresholds?.[name]) || config.thresholds[name] < 0) throw new Error(`threshold ${name} is required`);
  }
  if (config.thresholds.minimumSampleCoverageRatio <= 0 || config.thresholds.minimumSampleCoverageRatio > 1) {
    throw new Error("minimumSampleCoverageRatio must be greater than 0 and no more than 1");
  }
  if (config.thresholds.maximumSampleGapSeconds < config.intervalSeconds) throw new Error("maximumSampleGapSeconds cannot be less than intervalSeconds");

  if (!config.expectedProfiles || typeof config.expectedProfiles !== "object") throw new Error("expectedProfiles is required");
  for (const court of config.requiredCourts) validateExpectedProfile(config.expectedProfiles[String(court)], court);
  return config;
}

function validateExpectedProfile(profile, court) {
  if (!profile || typeof profile !== "object") throw new Error(`expectedProfiles.${court} is required`);
  for (const field of PROFILE_FIELDS) {
    const value = profile[field];
    if (typeof value === "string") {
      if (!SAFE_ID.test(value)) throw new Error(`expectedProfiles.${court}.${field} is invalid`);
    } else if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`expectedProfiles.${court}.${field} is invalid`);
    }
  }
  if (!Array.isArray(profile.videoProfilesAllowed) || profile.videoProfilesAllowed.length === 0) {
    throw new Error(`expectedProfiles.${court}.videoProfilesAllowed must be non-empty`);
  }
  for (const value of profile.videoProfilesAllowed) {
    if (typeof value !== "string" || !SAFE_ID.test(value)) throw new Error(`expectedProfiles.${court}.videoProfilesAllowed is invalid`);
  }
  if (!finite(profile.minimumFps) || !finite(profile.maximumFps) || profile.minimumFps <= 0 || profile.maximumFps < profile.minimumFps) {
    throw new Error(`expectedProfiles.${court} FPS range is invalid`);
  }
}

export function sanitizeSnapshot(snapshot, requiredCourts, sampledAt, scheduledAt) {
  const courtsByNumber = new Map((snapshot?.courts ?? []).map((court) => [court.courtNumber, court]));
  return {
    recordType: "sample",
    schemaVersion: 1,
    sampledAt,
    scheduledAt,
    generatedAt: snapshot?.generatedAt ?? null,
    collector: {
      state: snapshot?.collector?.state ?? null,
      agentsExpected: snapshot?.collector?.agentsExpected ?? null,
      agentsFresh: snapshot?.collector?.agentsFresh ?? null
    },
    incidentCount: Array.isArray(snapshot?.incidents) ? snapshot.incidents.length : null,
    faultGateCount: Array.isArray(snapshot?.faultGates) ? snapshot.faultGates.length : null,
    courts: requiredCourts.map((courtNumber) => {
      const court = courtsByNumber.get(courtNumber);
      const raw = court?.paths?.raw;
      return {
        courtNumber,
        overallState: court?.overallState ?? null,
        raw: raw ? {
          ready: raw.ready,
          readySince: raw.readySince,
          inboundBitrateBps: raw.inboundBitrateBps,
          bytesReceived: raw.bytesReceived,
          frameErrors: raw.frameErrors,
          sourceProtocol: raw.sourceProtocol,
          sourceMode: raw.sourceMode,
          videoCodec: raw.videoCodec,
          videoProfile: raw.videoProfile,
          videoWidth: raw.videoWidth,
          videoHeight: raw.videoHeight,
          audioCodec: raw.audioCodec,
          audioSampleRateHz: raw.audioSampleRateHz,
          audioChannelCount: raw.audioChannelCount
        } : null
      };
    })
  };
}

export function parseFrameRate(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d+)\/(\d+)$/);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function normalizeCodec(value) {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function sameText(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

export function evaluateCameraProfileGate(configInput, evidenceInput, probes, sourceEvidence = {}) {
  const config = validateConfig(configInput);
  const checks = [];
  const run = evidenceInput.run;
  const samples = [...evidenceInput.samples].sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt));
  const errors = evidenceInput.errors ?? [];
  if (!run) throw new Error("evidence run metadata is missing");
  if (run.schemaVersion !== 1 || run.gateId !== config.gateId) throw new Error("evidence run metadata does not match the config");
  if (JSON.stringify(run.requiredCourts) !== JSON.stringify(config.requiredCourts)) throw new Error("evidence requiredCourts do not match the config");

  const startMs = parseTime(run.plannedStartAt, "plannedStartAt");
  const endMs = parseTime(run.plannedEndAt, "plannedEndAt");
  if (run.intervalSeconds !== config.intervalSeconds) throw new Error("evidence intervalSeconds does not match the config");
  const durationSeconds = (endMs - startMs) / 1_000;
  if (durationSeconds <= 0) throw new Error("evidence window must have positive duration");
  const expectedSamples = Math.floor(durationSeconds / config.intervalSeconds) + 1;
  const coverageRatio = samples.length / expectedSamples;
  addCheck(checks, "duration", durationSeconds >= config.minimumDurationSeconds, durationSeconds, `>= ${config.minimumDurationSeconds} seconds`);
  addCheck(checks, "source_evidence_digests", SHA256.test(sourceEvidence.samplesSha256 ?? "") && SHA256.test(sourceEvidence.probesSha256 ?? ""), sourceEvidence, "lowercase SHA-256 for the sanitized sample and probe artifacts");
  addCheck(checks, "sample_errors", errors.length === 0, errors.length, "0");
  addCheck(checks, "sample_coverage", coverageRatio >= config.thresholds.minimumSampleCoverageRatio, coverageRatio, `>= ${config.thresholds.minimumSampleCoverageRatio}`);

  const sampleTimes = samples.map((sample) => parseTime(sample.sampledAt, "sampledAt"));
  const scheduledTimes = samples.map((sample) => parseTime(sample.scheduledAt, "scheduledAt"));
  const scheduleUnique = new Set(scheduledTimes).size === scheduledTimes.length;
  const scheduleAligned = scheduledTimes.every((value) => value >= startMs && value <= endMs && (value - startMs) % (config.intervalSeconds * 1_000) === 0);
  const sampleTimesBounded = samples.every((sample, index) => sampleTimes[index] >= scheduledTimes[index] && sampleTimes[index] <= endMs + config.thresholds.maximumSampleLatenessMs);
  addCheck(checks, "sample_schedule_unique", scheduleUnique, scheduledTimes.length - new Set(scheduledTimes).size, "0 duplicate slots");
  addCheck(checks, "sample_schedule_aligned", scheduleAligned, scheduledTimes.map((value) => iso(value)), "every slot aligned inside the planned window");
  addCheck(checks, "sample_times_bounded", sampleTimesBounded, sampleTimes.map((value) => iso(value)), "at or after the scheduled slot and within the bounded run tail");
  const gaps = sampleTimes.slice(1).map((value, index) => (value - sampleTimes[index]) / 1_000);
  const maxGapSeconds = gaps.length > 0 ? Math.max(...gaps) : Number.POSITIVE_INFINITY;
  const startEdgeSeconds = sampleTimes.length > 0 ? Math.max(0, (sampleTimes[0] - startMs) / 1_000) : Number.POSITIVE_INFINITY;
  const endEdgeSeconds = sampleTimes.length > 0 ? Math.max(0, (endMs - sampleTimes.at(-1)) / 1_000) : Number.POSITIVE_INFINITY;
  addCheck(checks, "sample_max_gap", maxGapSeconds <= config.thresholds.maximumSampleGapSeconds, maxGapSeconds, `<= ${config.thresholds.maximumSampleGapSeconds} seconds`);
  addCheck(checks, "sample_start_edge", startEdgeSeconds <= config.thresholds.maximumEdgeGapSeconds, startEdgeSeconds, `<= ${config.thresholds.maximumEdgeGapSeconds} seconds`);
  addCheck(checks, "sample_end_edge", endEdgeSeconds <= config.thresholds.maximumEdgeGapSeconds, endEdgeSeconds, `<= ${config.thresholds.maximumEdgeGapSeconds} seconds`);

  const latenessValues = samples.map((sample) => parseTime(sample.sampledAt, "sampledAt") - parseTime(sample.scheduledAt, "scheduledAt"));
  const maxLatenessMs = latenessValues.length > 0 ? Math.max(...latenessValues) : Number.POSITIVE_INFINITY;
  addCheck(checks, "sample_lateness", maxLatenessMs <= config.thresholds.maximumSampleLatenessMs, maxLatenessMs, `<= ${config.thresholds.maximumSampleLatenessMs} ms`);

  const snapshotAges = samples.map((sample) => parseTime(sample.sampledAt, "sampledAt") - parseTime(sample.generatedAt, "generatedAt"));
  const maxSnapshotAgeMs = snapshotAges.length > 0 ? Math.max(...snapshotAges) : Number.POSITIVE_INFINITY;
  const minSnapshotAgeMs = snapshotAges.length > 0 ? Math.min(...snapshotAges) : Number.NEGATIVE_INFINITY;
  addCheck(checks, "snapshot_age", minSnapshotAgeMs >= -1_000 && maxSnapshotAgeMs <= config.thresholds.maximumSnapshotAgeMs, { minMs: minSnapshotAgeMs, maxMs: maxSnapshotAgeMs }, `between -1000 and ${config.thresholds.maximumSnapshotAgeMs} ms`);

  addCheck(checks, "collector_healthy", samples.length > 0 && samples.every((sample) => sample.collector?.state === "HEALTHY"), samples.map((sample) => sample.collector?.state), "HEALTHY for every sample");
  addCheck(checks, "collector_complete", samples.length > 0 && samples.every((sample) => Number.isInteger(sample.collector?.agentsExpected) && sample.collector.agentsFresh === sample.collector.agentsExpected), samples.map((sample) => `${sample.collector?.agentsFresh}/${sample.collector?.agentsExpected}`), "all expected agents fresh for every sample");
  addCheck(checks, "incidents_absent", samples.length > 0 && samples.every((sample) => sample.incidentCount === 0), Math.max(0, ...samples.map((sample) => sample.incidentCount ?? 0)), "0");
  addCheck(checks, "fault_gates_absent", samples.length > 0 && samples.every((sample) => sample.faultGateCount === 0), Math.max(0, ...samples.map((sample) => sample.faultGateCount ?? 0)), "0");

  const observedCourts = {};
  for (const courtNumber of config.requiredCourts) {
    observedCourts[courtNumber] = evaluateCourt(checks, config, samples, probes, courtNumber, startMs, endMs);
  }

  return {
    schemaVersion: 2,
    gateId: config.gateId,
    generatedAt: new Date().toISOString(),
    qualification: qualificationContract(config),
    sourceEvidence: {
      samplesSha256: sourceEvidence.samplesSha256 ?? null,
      probesSha256: sourceEvidence.probesSha256 ?? null
    },
    verdict: checks.every((check) => check.pass) ? "PASS" : "FAIL",
    window: {
      plannedStartAt: run.plannedStartAt,
      plannedEndAt: run.plannedEndAt,
      durationSeconds,
      expectedSamples,
      observedSamples: samples.length,
      coverageRatio,
      maxGapSeconds,
      startEdgeSeconds,
      endEdgeSeconds,
      maxLatenessMs,
      maxSnapshotAgeMs
    },
    observedCourts,
    checks
  };
}

function qualificationContract(config) {
  return {
    schemaVersion: 1,
    requiredCourts: [...config.requiredCourts],
    minimumDurationSeconds: config.minimumDurationSeconds,
    intervalSeconds: config.intervalSeconds,
    thresholds: { ...config.thresholds },
    expectedProfiles: Object.fromEntries(config.requiredCourts.map((court) => [
      String(court),
      {
        ...config.expectedProfiles[String(court)],
        videoProfilesAllowed: [...config.expectedProfiles[String(court)].videoProfilesAllowed]
      }
    ]))
  };
}

function evaluateCourt(checks, config, samples, probes, courtNumber, startMs, endMs) {
  const expected = config.expectedProfiles[String(courtNumber)];
  const prefix = `court_${courtNumber}`;
  const courtSamples = samples.map((sample) => sample.courts?.find((court) => court.courtNumber === courtNumber) ?? null);
  const rawSamples = courtSamples.map((court) => court?.raw ?? null);
  addCheck(checks, `${prefix}_present`, rawSamples.length > 0 && rawSamples.every(Boolean), rawSamples.filter(Boolean).length, `${samples.length}`);
  addCheck(checks, `${prefix}_ready`, rawSamples.length > 0 && rawSamples.every((raw) => raw?.ready === true), rawSamples.filter((raw) => raw?.ready === true).length, `${samples.length}`);

  const bitrateValues = rawSamples.map((raw) => raw?.inboundBitrateBps).filter(finite);
  const bitrateP05 = percentile(bitrateValues, 0.05);
  addCheck(checks, `${prefix}_bitrate_p05`, bitrateValues.length === samples.length && bitrateP05 >= config.thresholds.minimumRawBitrateBps, bitrateP05, `>= ${config.thresholds.minimumRawBitrateBps}`);

  const frameErrors = rawSamples.map((raw) => raw?.frameErrors).filter(finite);
  const frameErrorGrowth = counterGrowth(frameErrors);
  addCheck(checks, `${prefix}_frame_error_growth`, frameErrors.length === samples.length && frameErrorGrowth === 0, frameErrorGrowth, "0");

  const bytes = rawSamples.map((raw) => raw?.bytesReceived).filter(finite);
  const bytesMonotonic = bytes.length === samples.length && bytes.every((value, index) => index === 0 || value >= bytes[index - 1]);
  const byteGrowth = bytes.length > 1 ? bytes.at(-1) - bytes[0] : 0;
  addCheck(checks, `${prefix}_bytes_monotonic`, bytesMonotonic && byteGrowth > 0, { monotonic: bytesMonotonic, growth: byteGrowth }, "monotonic with positive growth");

  const readySinceValues = new Set(rawSamples.map((raw) => raw?.readySince).filter((value) => typeof value === "string"));
  addCheck(checks, `${prefix}_publisher_continuity`, readySinceValues.size === 1 && rawSamples.every((raw) => typeof raw?.readySince === "string"), [...readySinceValues], "one unchanged readySince timestamp");

  for (const field of PROFILE_FIELDS) {
    const values = rawSamples.map((raw) => raw?.[field]);
    addCheck(checks, `${prefix}_monitor_${field}`, values.length > 0 && values.every((value) => profileValueEqual(field, value, expected[field])), [...new Set(values)], expected[field]);
  }
  const monitorProfiles = rawSamples.map((raw) => raw?.videoProfile);
  addCheck(checks, `${prefix}_monitor_videoProfile`, monitorProfiles.length > 0 && monitorProfiles.every((value) => expected.videoProfilesAllowed.includes(value)), [...new Set(monitorProfiles)], expected.videoProfilesAllowed);

  const courtProbes = probes?.courts?.filter((probe) => probe.courtNumber === courtNumber) ?? [];
  addCheck(checks, `${prefix}_probe_count`, courtProbes.length === 1, courtProbes.length, "1");
  const allowedOffsetMs = config.thresholds.maximumProbeOffsetSeconds * 1_000;
  const probesInWindow = courtProbes.every((probe) => {
    const sampledAt = parseTime(probe.sampledAt, "probe sampledAt");
    return sampledAt >= startMs - allowedOffsetMs && sampledAt <= endMs + allowedOffsetMs;
  });
  addCheck(checks, `${prefix}_probe_window`, courtProbes.length > 0 && probesInWindow, courtProbes.map((probe) => probe.sampledAt), `within ${config.thresholds.maximumProbeOffsetSeconds} seconds of the evidence window`);

  const probeFps = [];
  let probeProfile = null;
  for (const probe of courtProbes) {
    const videos = probe.streams?.filter((stream) => stream.codecType === "video") ?? [];
    const audios = probe.streams?.filter((stream) => stream.codecType === "audio") ?? [];
    addCheck(checks, `${prefix}_probe_${probe.sampledAt}_video_count`, videos.length === 1, videos.length, "1");
    addCheck(checks, `${prefix}_probe_${probe.sampledAt}_audio_count`, audios.length === 1, audios.length, "1");
    if (videos.length === 1) {
      const video = videos[0];
      const fps = parseFrameRate(video.avgFrameRate) ?? parseFrameRate(video.realFrameRate);
      probeFps.push(fps);
      addCheck(checks, `${prefix}_probe_${probe.sampledAt}_video_codec`, sameText(video.codecName, expected.videoCodec), video.codecName, expected.videoCodec);
      addCheck(checks, `${prefix}_probe_${probe.sampledAt}_video_profile`, expected.videoProfilesAllowed.includes(video.profile), video.profile, expected.videoProfilesAllowed);
      addCheck(checks, `${prefix}_probe_${probe.sampledAt}_dimensions`, video.width === expected.videoWidth && video.height === expected.videoHeight, `${video.width}x${video.height}`, `${expected.videoWidth}x${expected.videoHeight}`);
      addCheck(checks, `${prefix}_probe_${probe.sampledAt}_fps`, finite(fps) && fps >= expected.minimumFps && fps <= expected.maximumFps, fps, `${expected.minimumFps}-${expected.maximumFps}`);
    }
    if (audios.length === 1) {
      const audio = audios[0];
      addCheck(checks, `${prefix}_probe_${probe.sampledAt}_audio_codec`, sameText(audio.codecName, expected.audioCodec), audio.codecName, expected.audioCodec);
      addCheck(checks, `${prefix}_probe_${probe.sampledAt}_audio_sample_rate`, Number(audio.sampleRateHz) === expected.audioSampleRateHz, Number(audio.sampleRateHz), expected.audioSampleRateHz);
      addCheck(checks, `${prefix}_probe_${probe.sampledAt}_audio_channels`, audio.channels === expected.audioChannelCount, audio.channels, expected.audioChannelCount);
    }
    if (courtProbes.length === 1 && videos.length === 1 && audios.length === 1) {
      const video = videos[0];
      const audio = audios[0];
      probeProfile = {
        videoCodec: video.codecName,
        videoProfile: video.profile,
        videoWidth: video.width,
        videoHeight: video.height,
        videoFps: parseFrameRate(video.avgFrameRate) ?? parseFrameRate(video.realFrameRate),
        audioCodec: audio.codecName,
        audioSampleRateHz: Number(audio.sampleRateHz),
        audioChannelCount: audio.channels
      };
    }
  }

  return {
    bitrateP05,
    frameErrorGrowth,
    byteGrowth,
    readySince: readySinceValues.size === 1 ? [...readySinceValues][0] : null,
    monitorProfile: rawSamples.length > 0 ? pickProfile(rawSamples.at(-1)) : null,
    probeFps,
    probeSampledAt: courtProbes.length === 1 ? courtProbes[0].sampledAt : null,
    probeProfile
  };
}

function profileValueEqual(field, observed, expected) {
  if (typeof expected === "string") return sameText(observed, expected);
  return observed === expected;
}

function counterGrowth(values) {
  let growth = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    growth += delta >= 0 ? delta : values[index];
  }
  return growth;
}

function pickProfile(raw) {
  return Object.fromEntries([...PROFILE_FIELDS, "videoProfile"].map((field) => [field, raw?.[field] ?? null]));
}

export function parseEvidenceNdjson(text) {
  let run = null;
  const samples = [];
  const errors = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`invalid evidence JSON at line ${index + 1}`);
    }
    if (record.recordType === "run") {
      if (run) throw new Error("evidence contains multiple run records");
      run = record;
    } else if (record.recordType === "sample") samples.push(record);
    else if (record.recordType === "error") errors.push(record);
    else throw new Error(`unknown evidence recordType at line ${index + 1}`);
  }
  return { run, samples, errors };
}

export function sanitizeProbeStreams(payload) {
  if (!payload || !Array.isArray(payload.streams)) throw new Error("ffprobe output did not contain streams");
  return payload.streams.map((stream) => ({
    index: stream.index,
    codecType: stream.codec_type,
    codecName: stream.codec_name,
    profile: stream.profile ?? null,
    width: stream.width ?? null,
    height: stream.height ?? null,
    realFrameRate: stream.r_frame_rate ?? null,
    avgFrameRate: stream.avg_frame_rate ?? null,
    sampleRateHz: stream.sample_rate ?? null,
    channels: stream.channels ?? null
  }));
}

function parseArgs(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value == null) throw new Error(`invalid argument near ${name ?? "end of command"}`);
    values[name.slice(2)] = value;
  }
  return { command, values };
}

async function loadConfig(path) {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}

async function protectedWriter(path) {
  const handle = await open(path, "wx", 0o600);
  await chmod(path, 0o600);
  return handle;
}

async function sampleCommand(values) {
  const config = await loadConfig(required(values, "config"));
  const output = required(values, "output");
  const monitorUrl = snapshotUrl(required(values, "monitor-url"));
  const token = process.env.SCORECHECK_MONITOR_API_TOKEN?.trim();
  if (!token) throw new Error("SCORECHECK_MONITOR_API_TOKEN is required");
  const durationSeconds = values["duration-seconds"] == null ? config.minimumDurationSeconds : positiveInteger(values["duration-seconds"], "duration-seconds");
  if (durationSeconds < config.minimumDurationSeconds) throw new Error("duration-seconds cannot be less than the configured minimumDurationSeconds");
  const intervalMs = config.intervalSeconds * 1_000;
  const startMs = Date.now();
  const endMs = startMs + durationSeconds * 1_000;
  const writer = await protectedWriter(output);
  try {
    await writer.write(`${JSON.stringify({ recordType: "run", schemaVersion: 1, gateId: config.gateId, requiredCourts: config.requiredCourts, plannedStartAt: iso(startMs), plannedEndAt: iso(endMs), intervalSeconds: config.intervalSeconds })}\n`);
    const slots = Math.floor((endMs - startMs) / intervalMs) + 1;
    for (let slot = 0; slot < slots; slot += 1) {
      const scheduledMs = startMs + slot * intervalMs;
      const delayMs = scheduledMs - Date.now();
      if (delayMs > 0) await delay(delayMs);
      const sampledMs = Date.now();
      if (sampledMs - scheduledMs > intervalMs / 2) {
        await writer.write(`${JSON.stringify({ recordType: "error", schemaVersion: 1, scheduledAt: iso(scheduledMs), sampledAt: iso(sampledMs), code: "SAMPLE_SLOT_MISSED" })}\n`);
        continue;
      }
      try {
        const response = await fetch(monitorUrl, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(Math.min(10_000, intervalMs))
        });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const snapshot = await response.json();
        await writer.write(`${JSON.stringify(sanitizeSnapshot(snapshot, config.requiredCourts, iso(Date.now()), iso(scheduledMs)))}\n`);
      } catch (error) {
        const code = error instanceof Error && /^HTTP_\d+$/.test(error.message) ? error.message : "SNAPSHOT_UNAVAILABLE";
        await writer.write(`${JSON.stringify({ recordType: "error", schemaVersion: 1, scheduledAt: iso(scheduledMs), sampledAt: iso(Date.now()), code })}\n`);
      }
    }
  } finally {
    await writer.close();
  }
}

function snapshotUrl(input) {
  const url = new URL(input);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    throw new Error("monitor-url must use HTTPS except on localhost");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("monitor-url must not contain credentials, query parameters, or fragments");
  }
  if (!url.pathname.endsWith("/v1/snapshot")) url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/snapshot`;
  return url;
}

async function probeCommand(values) {
  const config = await loadConfig(required(values, "config"));
  const output = required(values, "output");
  const ffprobeBin = values["ffprobe-bin"] ?? "ffprobe";
  const directBase = values["rtsp-base-url"];
  const ingestHost = values["ingest-host"];
  if (Boolean(directBase) === Boolean(ingestHost)) throw new Error("provide exactly one of --rtsp-base-url or --ingest-host");
  let tunnel = null;
  let baseUrl;
  try {
    if (directBase) {
      baseUrl = validateLocalRtspBase(directBase);
    } else {
      if (!SAFE_HOST.test(ingestHost)) throw new Error("ingest-host is invalid");
      const sshKey = required(values, "ssh-key");
      const port = await allocatePort();
      tunnel = await startSshTunnel(ingestHost, sshKey, port);
      baseUrl = new URL(`rtsp://127.0.0.1:${port}/`);
    }
    const courts = [];
    for (const courtNumber of config.requiredCourts) {
      const args = buildFfprobeArgs(baseUrl, courtNumber);
      const { stdout } = await execFileAsync(ffprobeBin, args, { timeout: 20_000, maxBuffer: 1_000_000 });
      courts.push({ courtNumber, sampledAt: new Date().toISOString(), streams: sanitizeProbeStreams(JSON.parse(stdout)) });
    }
    await writeProtectedJson(output, { schemaVersion: 1, gateId: config.gateId, generatedAt: new Date().toISOString(), courts });
  } finally {
    if (tunnel) await stopChild(tunnel);
  }
}

export function buildFfprobeArgs(baseUrl, courtNumber) {
  const url = new URL(`court${courtNumber}_raw`, baseUrl.href.endsWith("/") ? baseUrl : `${baseUrl.href}/`);
  return [
    "-v", "error",
    "-rtsp_transport", "tcp",
    "-timeout", "5000000",
    "-show_entries", "stream=index,codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels",
    "-of", "json",
    url.href
  ];
}

function validateLocalRtspBase(input) {
  const url = new URL(input);
  if (url.protocol !== "rtsp:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname) || url.username || url.password) {
    throw new Error("rtsp-base-url must be an unauthenticated localhost RTSP URL");
  }
  return url;
}

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("could not allocate a local RTSP tunnel port");
  return port;
}

async function startSshTunnel(host, key, port) {
  const { spawn } = await import("node:child_process");
  const child = spawn("ssh", [
    "-i", key,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ExitOnForwardFailure=yes",
    "-L", `${port}:127.0.0.1:8554`,
    "-N",
    host
  ], { stdio: "ignore" });
  await waitForPort(port, child, 12_000);
  return child;
}

async function waitForPort(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("SSH tunnel exited before becoming ready");
    if (await canConnect(port)) return;
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error("SSH tunnel did not become ready");
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(100, () => { socket.destroy(); resolve(false); });
  });
}

async function stopChild(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(1_000).then(() => false)
  ]);
  if (!exited && child.exitCode == null) child.kill("SIGKILL");
}

async function evaluateCommand(values) {
  const config = await loadConfig(required(values, "config"));
  const evidenceText = await readFile(required(values, "evidence"), "utf8");
  const probesText = await readFile(required(values, "probes"), "utf8");
  const evidence = parseEvidenceNdjson(evidenceText);
  const probes = JSON.parse(probesText);
  if (probes.schemaVersion !== 1 || probes.gateId !== config.gateId || !Array.isArray(probes.courts)) throw new Error("probe evidence does not match the config");
  const report = evaluateCameraProfileGate(config, evidence, probes, {
    samplesSha256: createHash("sha256").update(evidenceText).digest("hex"),
    probesSha256: createHash("sha256").update(probesText).digest("hex")
  });
  await writeProtectedJson(required(values, "output"), report);
  process.exitCode = report.verdict === "PASS" ? 0 : 2;
}

async function writeProtectedJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  if (command === "sample") await sampleCommand(values);
  else if (command === "probe") await probeCommand(values);
  else if (command === "evaluate") await evaluateCommand(values);
  else throw new Error("usage: camera-profile-gate.mjs <sample|probe|evaluate> [arguments]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "camera profile gate failed");
    process.exitCode = 1;
  });
}
