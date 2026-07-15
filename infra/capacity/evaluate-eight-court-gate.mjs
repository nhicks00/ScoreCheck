#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  assertCapacityConfig,
  buildQueries,
  evaluateEvidence,
  evaluateHostSamples,
  evaluateZombieEvidence,
  percentile,
  queryRange,
  resetAwareIncrease
} from "./evaluate-gate.mjs";
import { pairPoolHostSamples, parsePoolHostEventsNdjson, summarizePoolHost } from "./pool-host-evidence.mjs";

const LABEL_VALUE = /^[a-zA-Z0-9_.:-]{1,80}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_FIELDS = ["protocol", "mode", "videoCodec", "videoWidth", "videoHeight", "videoProfile", "audioCodec", "audioSampleRateHz", "audioChannelCount"];
const CAMERA_MONITOR_FIELDS = ["sourceProtocol", "sourceMode", "videoCodec", "videoWidth", "videoHeight", "audioCodec", "audioSampleRateHz", "audioChannelCount"];
const PROMETHEUS_QUERY_CONCURRENCY = 8;

export function assertEightCourtConfig(config) {
  if (config?.schemaVersion !== 1) throw new Error("eight-court config schemaVersion must be 1");
  safeLabel("gateId", config.gateId);
  if (!Number.isFinite(config.minimumDurationSeconds) || config.minimumDurationSeconds < 7_200) throw new Error("minimumDurationSeconds must be at least 7200");
  if (!Number.isFinite(config.warmupSeconds) || config.warmupSeconds < 0 || config.warmupSeconds >= config.minimumDurationSeconds) throw new Error("warmupSeconds is invalid");
  if (config.minimumDurationSeconds - config.warmupSeconds < 7_200) throw new Error("the post-warmup evaluated window must be at least 7200 seconds");
  if (!Number.isInteger(config.stepSeconds) || config.stepSeconds < 5 || config.stepSeconds > 60) throw new Error("stepSeconds must be from 5 through 60");
  if (config.expectedAgentCount !== 11) throw new Error("expectedAgentCount must be exactly 11 for ingest, commentary, eight active compositors, and the warm spare");
  safeLabel("expectedPoolRegion", config.expectedPoolRegion);
  safeLabel("expectedPoolSizeSlug", config.expectedPoolSizeSlug);
  if (!Number.isInteger(config.expectedPoolSizeVcpus) || config.expectedPoolSizeVcpus < 1) throw new Error("expectedPoolSizeVcpus is invalid");
  if (!Number.isFinite(config.minimumVenueUploadBps) || config.minimumVenueUploadBps < 75_000_000) throw new Error("minimumVenueUploadBps must be at least 75000000");
  if (!Number.isFinite(config.maximumVenueEvidenceAgeSeconds) || config.maximumVenueEvidenceAgeSeconds <= 0) throw new Error("maximumVenueEvidenceAgeSeconds is invalid");
  if (!Number.isFinite(config.minimumVenueMeasurementSpanSeconds) || config.minimumVenueMeasurementSpanSeconds < 60 || config.minimumVenueMeasurementSpanSeconds > config.maximumVenueEvidenceAgeSeconds) throw new Error("minimumVenueMeasurementSpanSeconds is invalid");
  if (!Number.isFinite(config.maximumPoolPreflightAgeSeconds) || config.maximumPoolPreflightAgeSeconds <= 0) throw new Error("maximumPoolPreflightAgeSeconds is invalid");
  safeLabel("expectedCameraProfileGateId", config.expectedCameraProfileGateId);
  if (!Number.isFinite(config.maximumCameraProfileEvidenceAgeSeconds)
    || config.maximumCameraProfileEvidenceAgeSeconds <= 0
    || config.maximumCameraProfileEvidenceAgeSeconds > 3_600) {
    throw new Error("maximumCameraProfileEvidenceAgeSeconds must be greater than 0 and no more than 3600");
  }
  if (!Number.isFinite(config.maximumAttestationLagSeconds) || config.maximumAttestationLagSeconds <= 0) throw new Error("maximumAttestationLagSeconds is invalid");
  assertHost(config.ingest, "ingest");
  assertHost(config.warmSpare, "warm spare");
  if (config.warmSpare.vcpus !== config.expectedPoolSizeVcpus) throw new Error("warm-spare vcpus must match expectedPoolSizeVcpus");
  if (!Array.isArray(config.courts) || config.courts.length !== 8) throw new Error("eight-court config must contain exactly eight courts");
  const courtNumbers = config.courts.map((court) => court.court).sort((left, right) => left - right);
  if (courtNumbers.some((court, index) => court !== index + 1)) throw new Error("courts must assign each number 1 through 8 exactly once");
  const compositorHosts = new Set();
  const compositorAgents = new Set();
  let commentaryCourts = 0;
  for (const court of config.courts) {
    assertHost(court.compositor, `court ${court.court} compositor`);
    if (court.compositor.vcpus !== config.expectedPoolSizeVcpus) throw new Error(`court ${court.court} compositor vcpus must match expectedPoolSizeVcpus`);
    if (compositorHosts.has(court.compositor.hostId)) throw new Error("each court must use a unique compositor host");
    if (compositorAgents.has(court.compositor.agent)) throw new Error("each court must use a unique compositor agent");
    compositorHosts.add(court.compositor.hostId);
    compositorAgents.add(court.compositor.agent);
    if (court.commentaryRequired === true) commentaryCourts += 1;
    if (!Array.isArray(court.requiredBranches) || !["raw", "preview", "program"].every((branch) => court.requiredBranches.includes(branch))) {
      throw new Error(`court ${court.court} must require raw, preview, and program branches`);
    }
    if (!Array.isArray(court.ffmpegBranches)) throw new Error(`court ${court.court} ffmpegBranches must be an array`);
    assertSourceProfile(court.expectedSourceProfile, court.court);
  }
  if (commentaryCourts < 2) throw new Error("at least two courts must require commentary");
  if (compositorHosts.has(config.ingest.hostId) || config.ingest.hostId === config.warmSpare.hostId) throw new Error("ingest and warm-spare identities must be distinct from active compositors");
  if (compositorAgents.has(config.ingest.agent)) throw new Error("ingest agent must be distinct from active compositors");
  if (compositorHosts.has(config.warmSpare.hostId)) throw new Error("warm spare cannot own an active court");
  if (compositorAgents.has(config.warmSpare.agent) || config.ingest.agent === config.warmSpare.agent) throw new Error("warm-spare agent must be distinct from ingest and active compositors");
  for (const required of [
    "maximumCameraAudioSilenceSeconds", "maximumCameraAudioClippedSampleRatio",
    "maximumCommentaryClippedSampleRatio", "maximumCommentarySilenceSeconds",
    "maximumCommentaryJitterMs", "maximumCommentarySyncGapMs",
    "maximumCommentaryPacketLossRatio", "maximumVenuePacketLossRatio",
    "maximumBrowserLowFpsRatio", "maximumMetricSampleGapSeconds",
    "maximumSnapshotAgeSeconds", "maximumRawLowBitrateRatio",
    "maximumFfmpegLowFpsRatio"
  ]) {
    if (!Number.isFinite(config.thresholds?.[required]) || config.thresholds[required] < 0) throw new Error(`threshold ${required} is required`);
  }
  if (config.thresholds.maximumMetricSampleGapSeconds < config.stepSeconds || config.thresholds.maximumMetricSampleGapSeconds > 120) {
    throw new Error("maximumMetricSampleGapSeconds must be between stepSeconds and 120 seconds");
  }
  if (config.thresholds.minimumSampleCoverageRatio < 0.99) {
    throw new Error("minimumSampleCoverageRatio must be at least 0.99 for the eight-court endurance gate");
  }
  for (const ratio of [
    "maximumRawLowBitrateRatio", "maximumFfmpegLowFpsRatio",
    "maximumBrowserLowFpsRatio", "maximumCommentaryPacketLossRatio",
    "maximumVenuePacketLossRatio"
  ]) {
    if (config.thresholds[ratio] > 1) throw new Error(`${ratio} cannot exceed 1`);
  }
  for (const court of config.courts) assertCapacityConfig(toSingleCourtConfig(config, court));
  assertCapacityConfig(toWarmSpareValidationConfig(config));
}

export function buildEightCourtQueries(config) {
  assertEightCourtConfig(config);
  const courts = {};
  for (const court of config.courts) {
    const number = String(court.court);
    const base = buildQueries(toSingleCourtConfig(config, court));
    const extra = {
      expectation_media: selector("scorecheck_court_media_required", { court: number }),
      expectation_broadcast: selector("scorecheck_court_broadcast_live", { court: number }),
      expectation_match: selector("scorecheck_court_live_match", { court: number }),
      expectation_scoring: selector("scorecheck_court_scoring_live", { court: number }),
      compositor_assignment: selector("scorecheck_compositor_court_assignment", { agent: court.compositor.agent, court: number }),
      compositor_assignment_count: `sum(${selector("scorecheck_compositor_court_assignment", { agent: court.compositor.agent })}) or vector(0)`,
      browser_packets_lost: selector("scorecheck_program_browser_packets_lost", { court: number }),
      browser_reconnects: selector("scorecheck_program_browser_reconnects", { court: number }),
      browser_reloads: selector("scorecheck_program_browser_reloads", { court: number }),
      browser_sessions: selector("scorecheck_program_browser_sessions_total", { court: number }),
      visual_frozen: selector("scorecheck_program_visual_frozen_duration_seconds", { court: number }),
      visual_black: selector("scorecheck_program_visual_black_duration_seconds", { court: number }),
      camera_audio_track: selector("scorecheck_program_camera_audio_track_present", { court: number }),
      camera_audio_silence: selector("scorecheck_program_camera_audio_silence_age_seconds", { court: number }),
      camera_audio_clipping: selector("scorecheck_program_camera_audio_clipped_sample_ratio", { court: number }),
      score_source_aligned: selector("scorecheck_score_source_aligned", { court: number }),
      score_render_aligned: selector("scorecheck_program_score_render_aligned", { court: number }),
      youtube_healthy: selector("scorecheck_youtube_healthy", { court: number }),
      youtube_degraded: selector("scorecheck_youtube_degraded", { court: number })
    };
    for (const branch of court.requiredBranches) extra[`path_readers_${branch}`] = selector("scorecheck_media_path_readers", { agent: config.ingest.agent, court: number, branch });
    for (const branch of court.ffmpegBranches) extra[`ffmpeg_duplicated_${branch}`] = selector("scorecheck_ffmpeg_duplicated_frames", { agent: config.ingest.agent, court: number, branch });
    if (court.commentaryRequired) Object.assign(extra, commentaryQueries(number));
    courts[court.court] = { ...base, ...extra };
  }
  return {
    global: {
      control_plane_fresh: "scorecheck_control_plane_fresh",
      snapshot_generated: "scorecheck_monitor_snapshot_generated_timestamp_seconds",
      monitor_process_start_time: selector("process_start_time_seconds", { job: "monitor-service" }),
      score_worker_healthy: "scorecheck_score_worker_healthy",
      youtube_api_up: "scorecheck_youtube_api_up",
      dead_man_healthy: "min(scorecheck_external_dead_man_healthy)",
      dead_man_active_running: "scorecheck_external_dead_man_active_running",
      dead_man_channel_audit: "scorecheck_external_dead_man_channel_audit_healthy",
      dead_man_test_gate_active: "max(scorecheck_external_dead_man_test_gate_active)",
      phone_channel_ready: "min(scorecheck_external_dead_man_phone_channel_ready)",
      pushover_healthy: selector("scorecheck_notification_provider_healthy", { provider: "pushover" }),
      agents_fresh_min: "min(scorecheck_monitor_agent_fresh)",
      agent_count: "count(scorecheck_monitor_agent_fresh)",
      active_alerts: "sum(ALERTS{alertstate=\"firing\",severity=~\"warning|critical\"}) or vector(0)",
      active_incidents: "scorecheck_active_incidents",
      active_fault_gates: "scorecheck_active_fault_gates",
      warm_spare_fresh: selector("scorecheck_monitor_agent_fresh", { agent: config.warmSpare.agent, role: "compositor" }),
      warm_spare_egress_idle: selector("scorecheck_egress_idle", { agent: config.warmSpare.agent }),
      warm_spare_metrics_valid: selector("scorecheck_egress_metrics_valid", { agent: config.warmSpare.agent }),
      warm_spare_can_accept: selector("scorecheck_egress_can_accept_request", { agent: config.warmSpare.agent }),
      warm_spare_active_requests: selector("scorecheck_egress_active_web_requests", { agent: config.warmSpare.agent }),
      warm_spare_maximum_requests: selector("scorecheck_egress_maximum_web_requests", { agent: config.warmSpare.agent }),
      warm_spare_assignments: `sum(${selector("scorecheck_compositor_court_assignment", { agent: config.warmSpare.agent })}) or vector(0)`,
      warm_spare_restarts: selector("scorecheck_service_restart_total", { agent: config.warmSpare.agent, service: config.warmSpare.service }),
      warm_spare_oom: selector("scorecheck_service_oom_killed", { agent: config.warmSpare.agent, service: config.warmSpare.service }),
      total_compositor_assignments: "sum(scorecheck_compositor_court_assignment) or vector(0)"
    },
    courts
  };
}

export function assertExactPoolHostSet(config, hostEvents, poolPreflight) {
  assertEightCourtConfig(config);
  if (!Array.isArray(hostEvents)) throw new Error("pool host events must be an array");
  const expected = [config.ingest, ...config.courts.map((court) => court.compositor), config.warmSpare]
    .map((host) => host.hostId)
    .sort();
  const observed = [...new Set(hostEvents.map((event) => event?.hostId).filter((hostId) => typeof hostId === "string"))].sort();
  if (!arraysEqual(observed, expected)) throw new Error(`pool host evidence identities do not match the exact topology: expected ${expected.join(",")}; observed ${observed.join(",")}`);
  const machineFingerprints = [];
  const providerResourceIds = [];
  const providerResources = Array.isArray(poolPreflight?.providerResources) ? poolPreflight.providerResources : null;
  if (!providerResources) throw new Error("pool preflight provider resources are missing");
  for (const hostId of expected) {
    const starts = hostEvents.filter((event) => event?.hostId === hostId && event.event === "watcher_started");
    if (starts.length === 0 || starts.some((event) => typeof event.machineFingerprint !== "string")) {
      throw new Error(`pool host ${hostId} must report a remote machine fingerprint at every watcher start`);
    }
    const fingerprints = [...new Set(starts
      .map((event) => event.machineFingerprint)
      .filter((value) => typeof value === "string"))];
    if (fingerprints.length !== 1) throw new Error(`pool host ${hostId} must have one stable remote machine fingerprint`);
    machineFingerprints.push(fingerprints[0]);
    if (starts.some((event) => event.provider !== "digitalocean"
      || typeof event.providerResourceId !== "string" || typeof event.providerHostname !== "string")) {
      throw new Error(`pool host ${hostId} must report its DigitalOcean identity at every watcher start`);
    }
    const providerIdentities = [...new Map(starts
      .filter((event) => event.provider != null || event.providerResourceId != null || event.providerHostname != null)
      .map((event) => [`${event.provider}\u0000${event.providerResourceId}\u0000${event.providerHostname}`, event])).values()];
    if (providerIdentities.length !== 1) throw new Error(`pool host ${hostId} must have one stable provider identity`);
    const providerIdentity = providerIdentities[0];
    if (providerIdentity.provider !== "digitalocean" || providerIdentity.providerHostname !== hostId || typeof providerIdentity.providerResourceId !== "string") {
      throw new Error(`pool host ${hostId} provider identity does not match its configured host`);
    }
    const providerMatches = providerResources.filter((resource) => resource?.provider === "digitalocean"
      && resource?.resourceType === "droplet" && resource?.name === hostId);
    if (providerMatches.length !== 1) throw new Error(`pool preflight must contain one DigitalOcean resource for ${hostId}`);
    const providerResource = providerMatches[0];
    if (providerResource.status !== "active" || providerResource.region !== config.expectedPoolRegion
      || providerResource.resourceId !== providerIdentity.providerResourceId) {
      throw new Error(`pool host ${hostId} does not match the active DigitalOcean resource captured by preflight`);
    }
    providerResourceIds.push(providerIdentity.providerResourceId);
  }
  if (new Set(machineFingerprints).size !== expected.length) throw new Error("pool host evidence maps multiple configured hosts to the same physical machine");
  if (new Set(providerResourceIds).size !== expected.length) throw new Error("pool host evidence maps multiple configured hosts to the same provider resource");
}

export function createConcurrencyLimiter(maximum) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 64) throw new Error("concurrency limit must be an integer from 1 through 64");
  let active = 0;
  const queue = [];
  const drain = () => {
    while (active < maximum && queue.length > 0) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };
  return (task) => new Promise((resolve, reject) => {
    if (typeof task !== "function") {
      reject(new Error("concurrency-limited task must be a function"));
      return;
    }
    queue.push({ task, resolve, reject });
    drain();
  });
}

export function evaluateEightCourtEvidence({ config, evidence, attestations, hosts, poolPreflight, venueEvidence, cameraProfileEvidence }) {
  assertEightCourtConfig(config);
  assertEightCourtAttestations(config, attestations);
  const startEpochSeconds = evidence.startEpochSeconds;
  const effectiveStartEpochSeconds = evidence.effectiveStartEpochSeconds;
  const endEpochSeconds = evidence.endEpochSeconds;
  if (![startEpochSeconds, effectiveStartEpochSeconds, endEpochSeconds].every(Number.isFinite)
      || startEpochSeconds >= effectiveStartEpochSeconds
      || effectiveStartEpochSeconds >= endEpochSeconds) {
    throw new Error("evidence window is invalid");
  }
  const expectedSamples = Math.floor((endEpochSeconds - effectiveStartEpochSeconds) / config.stepSeconds) + 1;
  const minimumSamples = Math.max(2, Math.ceil(expectedSamples * config.thresholds.minimumSampleCoverageRatio));
  const checks = [];
  const attestationCapturedAt = Date.parse(attestations.capturedAt) / 1_000;
  const attestationLagSeconds = attestationCapturedAt - endEpochSeconds;
  check(checks, "attestation_capture_fresh", Number.isFinite(attestationLagSeconds) && attestationLagSeconds >= 0 && attestationLagSeconds <= config.maximumAttestationLagSeconds, Number.isFinite(attestationLagSeconds) ? attestationLagSeconds : null, `0..${config.maximumAttestationLagSeconds} seconds after endpoint`);
  const expectedQueries = buildEightCourtQueries(config);
  for (const name of Object.keys(expectedQueries.global)) {
    metricSeriesCoverage(checks, `global_${name}`, evidence.globalSeries?.[name], {
      startEpochSeconds: effectiveStartEpochSeconds,
      endEpochSeconds,
      minimumSamples,
      maximumGapSeconds: config.thresholds.maximumMetricSampleGapSeconds
    });
  }
  for (const court of config.courts) {
    for (const name of Object.keys(expectedQueries.courts[court.court])) {
      metricSeriesCoverage(checks, `court${court.court}_${name}`, evidence.courtSeries?.[court.court]?.[name], {
        startEpochSeconds: effectiveStartEpochSeconds,
        endEpochSeconds,
        minimumSamples,
        maximumGapSeconds: config.thresholds.maximumMetricSampleGapSeconds
      });
    }
  }
  const globalSeries = evidence.globalSeries ?? {};
  for (const metric of [
    "control_plane_fresh", "score_worker_healthy", "youtube_api_up", "dead_man_healthy",
    "dead_man_active_running", "dead_man_channel_audit", "phone_channel_ready",
    "pushover_healthy", "agents_fresh_min", "warm_spare_fresh",
    "warm_spare_egress_idle", "warm_spare_metrics_valid", "warm_spare_can_accept"
  ]) {
    continuous(checks, globalSeries, metric, minimumSamples, (values) => Math.min(...values) >= 1, "1 for every sample");
  }
  for (const metric of ["active_incidents", "active_fault_gates", "dead_man_test_gate_active", "warm_spare_active_requests", "warm_spare_oom"]) {
    continuous(checks, globalSeries, metric, minimumSamples, (values) => Math.max(...values) === 0, "0 for every sample");
  }
  continuous(checks, globalSeries, "warm_spare_assignments", minimumSamples, (values) => Math.max(...values) === 0, "0 for every sample");
  continuous(checks, globalSeries, "warm_spare_maximum_requests", minimumSamples, (values) => Math.min(...values) === 1 && Math.max(...values) === 1, "exactly 1 for every sample");
  continuous(checks, globalSeries, "total_compositor_assignments", minimumSamples, (values) => Math.min(...values) === 8 && Math.max(...values) === 8, "exactly 8 for every sample");
  growth(checks, globalSeries, "warm_spare_restarts", minimumSamples, 0);
  continuous(checks, globalSeries, "agent_count", minimumSamples, (values) => Math.min(...values) === config.expectedAgentCount && Math.max(...values) === config.expectedAgentCount, `exactly ${config.expectedAgentCount}`);
  continuous(checks, globalSeries, "active_alerts", minimumSamples, (values) => Math.max(...values) === 0, "0 for every sample");
  continuous(checks, globalSeries, "monitor_process_start_time", minimumSamples, (values) => Math.min(...values) === Math.max(...values), "one unchanged process start time");
  const snapshotSamples = globalSeries.snapshot_generated ?? [];
  const snapshotAges = snapshotSamples.map((sample) => sample.timestamp - sample.value).filter(Number.isFinite);
  check(checks, "snapshot_generated_fresh", snapshotAges.length >= minimumSamples
    && Math.min(...snapshotAges) >= 0
    && Math.max(...snapshotAges) <= config.thresholds.maximumSnapshotAgeSeconds, snapshotAges.length ? { minimum: Math.min(...snapshotAges), maximum: Math.max(...snapshotAges) } : null, `0..${config.thresholds.maximumSnapshotAgeSeconds} seconds`);
  evaluatePoolPreflight(checks, config, poolPreflight, startEpochSeconds);
  evaluateProviderBindings(checks, config, hosts, poolPreflight);
  const qualifiedSourceProfiles = evaluateCameraProfileEvidence(checks, config, cameraProfileEvidence, startEpochSeconds);
  evaluateVenue(checks, config, venueEvidence, startEpochSeconds);
  check(checks, "cross_court_isolation_attested", attestations?.crossCourtIsolationVerified === true, attestations?.crossCourtIsolationVerified ?? null, true);
  check(checks, "youtube_test_privacy_attested", attestations?.youtubeBroadcastsUnlisted === true, attestations?.youtubeBroadcastsUnlisted ?? null, true);
  check(checks, "youtube_manual_lifecycle_attested", attestations?.youtubeAutoLifecycleDisabled === true, attestations?.youtubeAutoLifecycleDisabled ?? null, true);

  const ingestHost = hosts?.[config.ingest.hostId];
  const warmSpareHost = hosts?.[config.warmSpare.hostId];
  if (!ingestHost || !warmSpareHost) throw new Error("host evidence is missing for the ingest host or warm spare");
  const warmSpareChecks = [];
  const warmSpareHostConfig = hostPairConfig(config, config.warmSpare);
  evaluateHostSamples(warmSpareChecks, warmSpareHostConfig, pairPoolHostSamples(ingestHost.samples, warmSpareHost.samples));
  evaluateZombieEvidence(warmSpareChecks, warmSpareHostConfig, { roles: { ingest: ingestHost.zombies, compositor: warmSpareHost.zombies } });
  checks.push(...warmSpareChecks.map((entry) => ({ ...entry, id: `warm_spare_${entry.id}` })));

  const courtAttestations = new Map((attestations?.courts ?? []).map((court) => [court.court, court]));
  const courtReports = [];
  for (const court of config.courts) {
    const ingest = hosts?.[config.ingest.hostId];
    const compositor = hosts?.[court.compositor.hostId];
    if (!ingest || !compositor) throw new Error(`host evidence is missing for court ${court.court}`);
    const singleConfig = toSingleCourtConfig(config, court);
    const courtAttestation = courtAttestations.get(court.court) ?? {};
    const singleReport = evaluateEvidence(singleConfig, {
      startEpochSeconds,
      effectiveStartEpochSeconds,
      endEpochSeconds,
      series: evidence.courtSeries?.[court.court] ?? {}
    }, {
      observedSourceProfile: boundedSourceProfile(qualifiedSourceProfiles.get(court.court)),
      assignmentVerified: courtAttestation.assignmentVerified === true,
      unassignedCourtsUnaffected: attestations?.crossCourtIsolationVerified === true,
      egressErrors: Number.isFinite(courtAttestation.egressErrors) ? courtAttestation.egressErrors : null,
      egressShmEnabled: courtAttestation.egressShmEnabled === true
    }, pairPoolHostSamples(ingest.samples, compositor.samples), {
      roles: { ingest: ingest.zombies, compositor: compositor.zombies }
    });
    const extraChecks = evaluateCourtExtras(config, court, evidence.courtSeries?.[court.court] ?? {}, minimumSamples, courtAttestation, {
      effectiveStartEpochSeconds,
      endEpochSeconds
    });
    singleReport.checks.push(...extraChecks);
    singleReport.verdict = singleReport.checks.every((entry) => entry.pass) ? "PASS" : "FAIL";
    courtReports.push(singleReport);
  }
  check(checks, "all_eight_courts_pass", courtReports.length === 8 && courtReports.every((report) => report.verdict === "PASS"), courtReports.map((report) => ({ court: report.court, verdict: report.verdict })), "8 PASS reports");
  return {
    schemaVersion: 1,
    gateId: config.gateId,
    startAt: new Date(startEpochSeconds * 1_000).toISOString(),
    effectiveStartAt: new Date(effectiveStartEpochSeconds * 1_000).toISOString(),
    endAt: new Date(endEpochSeconds * 1_000).toISOString(),
    verdict: checks.every((entry) => entry.pass) && courtReports.every((report) => report.verdict === "PASS") ? "PASS" : "FAIL",
    checks,
    courts: courtReports
  };
}

function evaluateCourtExtras(config, court, series, minimumSamples, attestation, window) {
  const checks = [];
  for (const metric of ["expectation_media", "expectation_broadcast", "expectation_match", "expectation_scoring", "compositor_assignment", "browser_fresh", "camera_audio_track", "score_source_aligned", "score_render_aligned", "youtube_healthy"]) {
    continuous(checks, series, metric, minimumSamples, (values) => Math.min(...values) >= 1, "1 for every sample");
  }
  continuous(checks, series, "compositor_assignment_count", minimumSamples, (values) => Math.min(...values) === 1 && Math.max(...values) === 1, "exactly 1 for every sample");
  for (const metric of ["youtube_degraded", "visual_frozen", "visual_black"]) continuous(checks, series, metric, minimumSamples, (values) => Math.max(...values) === 0, "0 for every sample");
  for (const branch of court.requiredBranches) continuous(checks, series, `path_readers_${branch}`, minimumSamples, (values) => Math.min(...values) === 1 && Math.max(...values) === 1, "exactly 1 for every sample");
  const rawBitrate = values(series, "raw_bitrate");
  if (rawBitrate.length >= minimumSamples) {
    const lowRatio = rawBitrate.filter((value) => value < config.thresholds.minimumRawBitrateBps).length / rawBitrate.length;
    check(checks, "raw_bitrate_positive", Math.min(...rawBitrate) > 0, Math.min(...rawBitrate), "> 0 for every sample");
    check(checks, "raw_low_bitrate_ratio", lowRatio <= config.thresholds.maximumRawLowBitrateRatio, lowRatio, `<= ${config.thresholds.maximumRawLowBitrateRatio}`);
  }
  for (const branch of court.ffmpegBranches) {
    growth(checks, series, `ffmpeg_duplicated_${branch}`, minimumSamples, 0);
    const fps = values(series, `ffmpeg_fps_${branch}`);
    if (fps.length >= minimumSamples) {
      const lowRatio = fps.filter((value) => value < config.thresholds.minimumFfmpegFps).length / fps.length;
      check(checks, `ffmpeg_${branch}_low_fps_ratio`, lowRatio <= config.thresholds.maximumFfmpegLowFpsRatio, lowRatio, `<= ${config.thresholds.maximumFfmpegLowFpsRatio}`);
      check(checks, `ffmpeg_${branch}_fps_never_critical`, Math.min(...fps) >= 20, Math.min(...fps), ">= 20");
    }
  }
  for (const metric of ["browser_packets_lost", "browser_reconnects", "browser_reloads", "browser_sessions"]) growth(checks, series, metric, minimumSamples, 0);
  const browserFps = values(series, "browser_fps");
  if (browserFps.length >= minimumSamples) {
    const lowRatio = browserFps.filter((value) => value < config.thresholds.minimumBrowserFps).length / browserFps.length;
    check(checks, "browser_low_fps_ratio", lowRatio <= config.thresholds.maximumBrowserLowFpsRatio, lowRatio, `<= ${config.thresholds.maximumBrowserLowFpsRatio}`);
    check(checks, "browser_fps_never_critical", Math.min(...browserFps) >= 20, Math.min(...browserFps), ">= 20");
  }
  boundedMaximum(checks, series, "camera_audio_silence", minimumSamples, config.thresholds.maximumCameraAudioSilenceSeconds);
  boundedMaximum(checks, series, "camera_audio_clipping", minimumSamples, config.thresholds.maximumCameraAudioClippedSampleRatio);
  if (court.commentaryRequired) {
    for (const metric of ["commentary_connected", "commentary_sync_locked"]) continuous(checks, series, metric, minimumSamples, (values) => Math.min(...values) >= 1, "1 for every sample");
    continuous(checks, series, "commentary_tracks", minimumSamples, (values) => Math.min(...values) >= 1, ">= 1 for every sample");
    continuous(checks, series, "commentary_muted", minimumSamples, (values) => Math.max(...values) === 0, "0 for every sample");
    boundedMaximum(checks, series, "commentary_clipping", minimumSamples, config.thresholds.maximumCommentaryClippedSampleRatio);
    boundedMaximum(checks, series, "commentary_silence", minimumSamples, config.thresholds.maximumCommentarySilenceSeconds);
    boundedMaximum(checks, series, "commentary_jitter", minimumSamples, config.thresholds.maximumCommentaryJitterMs);
    boundedMaximum(checks, series, "commentary_sync_gap", minimumSamples, config.thresholds.maximumCommentarySyncGapMs);
    const lost = values(series, "commentary_packets_lost");
    const received = values(series, "commentary_packets_received");
    requireSamples(checks, "commentary_packets_lost", lost, minimumSamples);
    requireSamples(checks, "commentary_packets_received", received, minimumSamples);
    if (lost.length >= minimumSamples && received.length >= minimumSamples) {
      const ratio = resetAwareIncrease(lost) / Math.max(1, resetAwareIncrease(lost) + resetAwareIncrease(received));
      check(checks, "commentary_packet_loss_ratio", ratio <= config.thresholds.maximumCommentaryPacketLossRatio, ratio, `<= ${config.thresholds.maximumCommentaryPacketLossRatio}`);
    }
    check(checks, "commentary_av_sync_attested", attestation.avSyncObserved === true, attestation.avSyncObserved ?? null, true);
    const observedAt = Date.parse(attestation.avSyncObservedAt) / 1_000;
    check(checks, "commentary_av_sync_in_window", Number.isFinite(observedAt) && observedAt >= window.effectiveStartEpochSeconds && observedAt <= window.endEpochSeconds, Number.isFinite(observedAt) ? new Date(observedAt * 1_000).toISOString() : null, `${new Date(window.effectiveStartEpochSeconds * 1_000).toISOString()}..${new Date(window.endEpochSeconds * 1_000).toISOString()}`);
  }
  return checks;
}

function evaluatePoolPreflight(checks, config, pool, startEpochSeconds) {
  const expectedNames = [...config.courts.map((court) => court.compositor.hostId), config.warmSpare.hostId].sort();
  const observedNames = [...(pool?.compositors?.exactPlan?.matchedNames ?? [])].sort();
  const checkedAt = Date.parse(pool?.checkedAt) / 1_000;
  const age = startEpochSeconds - checkedAt;
  check(checks, "pool_preflight_fresh", Number.isFinite(age) && age >= 0 && age <= config.maximumPoolPreflightAgeSeconds, Number.isFinite(age) ? age : null, `0..${config.maximumPoolPreflightAgeSeconds} seconds`);
  check(checks, "pool_preflight_status", pool?.status === "PASS", pool?.status ?? null, "PASS");
  check(checks, "pool_region", pool?.region === config.expectedPoolRegion, pool?.region ?? null, config.expectedPoolRegion);
  check(checks, "pool_size_slug", pool?.size?.slug === config.expectedPoolSizeSlug, pool?.size?.slug ?? null, config.expectedPoolSizeSlug);
  check(checks, "pool_size_vcpus", pool?.size?.vcpus === config.expectedPoolSizeVcpus, pool?.size?.vcpus ?? null, config.expectedPoolSizeVcpus);
  check(checks, "pool_exact_plan_complete", pool?.compositors?.exactPlan?.complete === true, pool?.compositors?.exactPlan?.complete ?? null, true);
  check(checks, "pool_nine_workers_active", pool?.compositors?.matchingActive === 9 && pool?.compositors?.target === 9 && pool?.compositors?.additionsRequired === 0, {
    matchingActive: pool?.compositors?.matchingActive ?? null,
    target: pool?.compositors?.target ?? null,
    additionsRequired: pool?.compositors?.additionsRequired ?? null
  }, { matchingActive: 9, target: 9, additionsRequired: 0 });
  check(checks, "pool_exact_names", arraysEqual(observedNames, expectedNames), observedNames, expectedNames);
  check(checks, "pool_no_blockers", Array.isArray(pool?.blockers) && pool.blockers.length === 0, pool?.blockers ?? null, []);
}

function evaluateProviderBindings(checks, config, hosts, pool) {
  const expectedHosts = [config.ingest, ...config.courts.map((court) => court.compositor), config.warmSpare];
  const resources = Array.isArray(pool?.providerResources) ? pool.providerResources : [];
  const bindings = expectedHosts.map((host) => {
    const identity = hosts?.[host.hostId]?.providerIdentity ?? null;
    const matches = resources.filter((resource) => resource?.provider === "digitalocean"
      && resource?.resourceType === "droplet" && resource?.name === host.hostId);
    const resource = matches.length === 1 ? matches[0] : null;
    const pass = identity?.provider === "digitalocean"
      && identity?.hostname === host.hostId
      && typeof identity?.resourceId === "string"
      && resource?.resourceId === identity.resourceId
      && resource?.status === "active"
      && resource?.region === config.expectedPoolRegion;
    return {
      hostId: host.hostId,
      provider: identity?.provider ?? null,
      resourceId: identity?.resourceId ?? null,
      hostname: identity?.hostname ?? null,
      providerMatchCount: matches.length,
      pass
    };
  });
  const resourceIds = bindings.map((binding) => binding.resourceId).filter((value) => typeof value === "string");
  const unique = resourceIds.length === expectedHosts.length && new Set(resourceIds).size === expectedHosts.length;
  check(checks, "pool_host_provider_bindings", bindings.every((binding) => binding.pass) && unique, bindings, "each host bound to one unique active DigitalOcean preflight resource");
}

function evaluateCameraProfileEvidence(checks, config, artifact, startEpochSeconds) {
  const report = artifact?.report;
  const qualification = report?.qualification;
  const expectedCourts = config.courts.map((court) => court.court).sort((left, right) => left - right);
  const observedCourtNumbers = Object.keys(report?.observedCourts ?? {})
    .map(Number)
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  const qualifiedCourtNumbers = Array.isArray(qualification?.requiredCourts)
    ? [...qualification.requiredCourts].sort((left, right) => left - right)
    : [];
  const reportChecks = Array.isArray(report?.checks) ? report.checks : [];
  const reportCheckIds = reportChecks.map((entry) => entry?.id);
  const requiredCheckIds = cameraProfileRequiredCheckIds(expectedCourts);
  const dynamicProbeChecksComplete = expectedCourts.every((court) => cameraProfileProbeChecksComplete(
    reportCheckIds,
    court,
    report?.observedCourts?.[court]?.probeSampledAt
  ));
  const reportChecksComplete = reportChecks.length > 0
    && reportChecks.every((entry) => typeof entry?.id === "string" && entry.pass === true)
    && new Set(reportCheckIds).size === reportCheckIds.length
    && requiredCheckIds.every((id) => reportCheckIds.includes(id))
    && dynamicProbeChecksComplete;
  check(checks, "camera_profile_artifact_digest", typeof artifact?.sha256 === "string" && SHA256.test(artifact.sha256), artifact?.sha256 ?? null, "64 lowercase hexadecimal characters");
  check(checks, "camera_profile_report_schema", report?.schemaVersion === 2 && qualification?.schemaVersion === 1, {
    report: report?.schemaVersion ?? null,
    qualification: qualification?.schemaVersion ?? null
  }, { report: 2, qualification: 1 });
  check(checks, "camera_profile_gate_identity", report?.gateId === config.expectedCameraProfileGateId, report?.gateId ?? null, config.expectedCameraProfileGateId);
  check(checks, "camera_profile_source_digests", SHA256.test(report?.sourceEvidence?.samplesSha256 ?? "")
    && SHA256.test(report?.sourceEvidence?.probesSha256 ?? ""), report?.sourceEvidence ?? null, "lowercase SHA-256 for sanitized sample and probe artifacts");
  check(checks, "camera_profile_report_pass", report?.verdict === "PASS" && reportChecksComplete, {
    verdict: report?.verdict ?? null,
    checkCount: reportChecks.length,
    failedChecks: reportChecks.filter((entry) => entry?.pass !== true).length,
    missingRequiredChecks: requiredCheckIds.filter((id) => !reportCheckIds.includes(id)),
    dynamicProbeChecksComplete
  }, "PASS with unique all-passing checks and the complete fixed qualification check set");
  const qualifiedProfileNumbers = Object.keys(qualification?.expectedProfiles ?? {})
    .map(Number)
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  check(checks, "camera_profile_exact_courts", arraysEqual(observedCourtNumbers, expectedCourts)
    && arraysEqual(qualifiedCourtNumbers, expectedCourts)
    && arraysEqual(qualifiedProfileNumbers, expectedCourts), {
    observedCourts: observedCourtNumbers,
    qualifiedCourts: qualification?.requiredCourts ?? null,
    qualifiedProfiles: qualifiedProfileNumbers
  }, expectedCourts);

  const thresholds = qualification?.thresholds;
  const contractPass = Number.isInteger(qualification?.minimumDurationSeconds) && qualification.minimumDurationSeconds >= 600
    && Number.isInteger(qualification?.intervalSeconds) && qualification.intervalSeconds >= 1 && qualification.intervalSeconds <= 5
    && Number.isFinite(thresholds?.minimumSampleCoverageRatio) && thresholds.minimumSampleCoverageRatio >= 0.99
    && thresholds.minimumSampleCoverageRatio <= 1
    && Number.isFinite(thresholds?.maximumSampleGapSeconds) && thresholds.maximumSampleGapSeconds >= qualification.intervalSeconds && thresholds.maximumSampleGapSeconds <= 7.5
    && Number.isFinite(thresholds?.maximumEdgeGapSeconds) && thresholds.maximumEdgeGapSeconds >= 0 && thresholds.maximumEdgeGapSeconds <= 7.5
    && Number.isFinite(thresholds?.maximumSampleLatenessMs) && thresholds.maximumSampleLatenessMs >= 0 && thresholds.maximumSampleLatenessMs <= 1_000
    && Number.isFinite(thresholds?.maximumSnapshotAgeMs) && thresholds.maximumSnapshotAgeMs >= 0 && thresholds.maximumSnapshotAgeMs <= 10_000
    && Number.isFinite(thresholds?.minimumRawBitrateBps) && thresholds.minimumRawBitrateBps >= Math.max(2_000_000, config.thresholds.minimumRawBitrateBps)
    && Number.isFinite(thresholds?.maximumProbeOffsetSeconds) && thresholds.maximumProbeOffsetSeconds >= 0 && thresholds.maximumProbeOffsetSeconds <= 30;
  check(checks, "camera_profile_qualification_contract", contractPass, qualification ? {
    minimumDurationSeconds: qualification.minimumDurationSeconds,
    intervalSeconds: qualification.intervalSeconds,
    thresholds
  } : null, "at least 600 seconds, at least 99% coverage, five-second-or-better cadence, bounded gaps/age/probe offset, and at least a 2 Mbps bitrate floor");

  const profileStart = Date.parse(report?.window?.plannedStartAt) / 1_000;
  const profileEnd = Date.parse(report?.window?.plannedEndAt) / 1_000;
  const generatedAt = Date.parse(report?.generatedAt) / 1_000;
  const ageSeconds = startEpochSeconds - profileEnd;
  check(checks, "camera_profile_evidence_fresh", Number.isFinite(profileEnd) && Number.isFinite(generatedAt)
    && profileEnd <= generatedAt && generatedAt <= startEpochSeconds
    && ageSeconds >= 0 && ageSeconds <= config.maximumCameraProfileEvidenceAgeSeconds, {
    plannedEndAt: report?.window?.plannedEndAt ?? null,
    generatedAt: report?.generatedAt ?? null,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null
  }, `completed before workload start and no more than ${config.maximumCameraProfileEvidenceAgeSeconds} seconds old`);
  const expectedProfileSamples = report?.window?.expectedSamples;
  const observedProfileSamples = report?.window?.observedSamples;
  const reportedCoverage = report?.window?.coverageRatio;
  const computedDuration = Number.isFinite(profileStart) && Number.isFinite(profileEnd) ? profileEnd - profileStart : null;
  const computedExpectedSamples = Number.isFinite(computedDuration) && Number.isInteger(qualification?.intervalSeconds)
    ? Math.floor(computedDuration / qualification.intervalSeconds) + 1
    : null;
  const computedCoverage = Number.isInteger(expectedProfileSamples) && expectedProfileSamples > 0 && Number.isInteger(observedProfileSamples)
    ? observedProfileSamples / expectedProfileSamples
    : null;
  check(checks, "camera_profile_window_contract", Number.isFinite(report?.window?.durationSeconds)
    && report.window.durationSeconds >= 600
    && report.window.durationSeconds >= qualification?.minimumDurationSeconds
    && report.window.durationSeconds === computedDuration
    && expectedProfileSamples === computedExpectedSamples
    && observedProfileSamples > 0 && observedProfileSamples <= expectedProfileSamples
    && Number.isFinite(reportedCoverage) && reportedCoverage >= 0.99
    && reportedCoverage >= thresholds?.minimumSampleCoverageRatio && reportedCoverage <= 1
    && Number.isFinite(report?.window?.maxGapSeconds) && report.window.maxGapSeconds <= thresholds?.maximumSampleGapSeconds
    && Number.isFinite(report?.window?.startEdgeSeconds) && report.window.startEdgeSeconds <= thresholds?.maximumEdgeGapSeconds
    && Number.isFinite(report?.window?.endEdgeSeconds) && report.window.endEdgeSeconds <= thresholds?.maximumEdgeGapSeconds
    && Number.isFinite(report?.window?.maxLatenessMs) && report.window.maxLatenessMs <= thresholds?.maximumSampleLatenessMs
    && Number.isFinite(report?.window?.maxSnapshotAgeMs) && report.window.maxSnapshotAgeMs <= thresholds?.maximumSnapshotAgeMs
    && Number.isFinite(computedCoverage) && Math.abs(computedCoverage - reportedCoverage) <= 1e-12, {
    durationSeconds: report?.window?.durationSeconds ?? null,
    computedDuration,
    expectedSamples: expectedProfileSamples ?? null,
    computedExpectedSamples,
    observedSamples: observedProfileSamples ?? null,
    coverageRatio: reportedCoverage ?? null,
    computedCoverage,
    maxGapSeconds: report?.window?.maxGapSeconds ?? null,
    startEdgeSeconds: report?.window?.startEdgeSeconds ?? null,
    endEdgeSeconds: report?.window?.endEdgeSeconds ?? null,
    maxLatenessMs: report?.window?.maxLatenessMs ?? null,
    maxSnapshotAgeMs: report?.window?.maxSnapshotAgeMs ?? null
  }, { minimumDurationSeconds: 600, minimumCoverageRatio: 0.99 });

  const profiles = new Map();
  let allProfilesMatch = true;
  const observed = [];
  for (const court of config.courts) {
    const courtEvidence = report?.observedCourts?.[court.court];
    const monitorProfile = courtEvidence?.monitorProfile;
    const sourceProfile = cameraMonitorProfile(monitorProfile);
    const expectedProfile = qualification?.expectedProfiles?.[court.court];
    const probeFps = courtEvidence?.probeFps;
    const probeSampledAt = courtEvidence?.probeSampledAt;
    const probeProfile = courtEvidence?.probeProfile;
    const probeEpochSeconds = Date.parse(probeSampledAt) / 1_000;
    const maximumProbeOffsetSeconds = thresholds?.maximumProbeOffsetSeconds;
    const probeInWindow = Number.isFinite(probeEpochSeconds) && Number.isFinite(maximumProbeOffsetSeconds)
      && probeEpochSeconds >= profileStart - maximumProbeOffsetSeconds
      && probeEpochSeconds <= profileEnd + maximumProbeOffsetSeconds;
    const matches = sourceProfilesEqual(sourceProfile, court.expectedSourceProfile)
      && cameraQualificationProfileMatches(expectedProfile, court.expectedSourceProfile)
      && Array.isArray(probeFps) && probeFps.length === 1 && probeFps.every((fps) => Number.isFinite(fps) && fps >= 29 && fps <= 31)
      && probeFps[0] === probeProfile?.videoFps
      && probeInWindow
      && Number.isFinite(courtEvidence?.bitrateP05) && courtEvidence.bitrateP05 >= thresholds?.minimumRawBitrateBps
      && courtEvidence?.frameErrorGrowth === 0
      && Number.isFinite(courtEvidence?.byteGrowth) && courtEvidence.byteGrowth > 0
      && Number.isFinite(Date.parse(courtEvidence?.readySince)) && Date.parse(courtEvidence.readySince) / 1_000 <= profileStart
      && cameraProbeProfileMatches(probeProfile, court.expectedSourceProfile);
    allProfilesMatch &&= matches;
    profiles.set(court.court, matches ? { ...court.expectedSourceProfile } : sourceProfile);
    observed.push({
      court: court.court,
      bitrateP05: courtEvidence?.bitrateP05 ?? null,
      frameErrorGrowth: courtEvidence?.frameErrorGrowth ?? null,
      byteGrowth: courtEvidence?.byteGrowth ?? null,
      readySince: courtEvidence?.readySince ?? null,
      monitorProfile: sourceProfile,
      probeSampledAt,
      probeProfile,
      matches
    });
  }
  check(checks, "camera_profile_exact_profiles", allProfilesMatch, observed, "every qualified and observed profile matches the endurance manifest");
  return profiles;
}

function cameraProfileRequiredCheckIds(courts) {
  const ids = [
    "duration", "source_evidence_digests", "sample_errors", "sample_coverage", "sample_schedule_unique",
    "sample_schedule_aligned", "sample_times_bounded", "sample_max_gap",
    "sample_start_edge", "sample_end_edge", "sample_lateness", "snapshot_age",
    "collector_healthy", "collector_complete", "incidents_absent", "fault_gates_absent"
  ];
  for (const court of courts) {
    const prefix = `court_${court}`;
    ids.push(
      `${prefix}_present`, `${prefix}_ready`, `${prefix}_bitrate_p05`,
      `${prefix}_frame_error_growth`, `${prefix}_bytes_monotonic`,
      `${prefix}_publisher_continuity`, ...CAMERA_MONITOR_FIELDS.map((field) => `${prefix}_monitor_${field}`),
      `${prefix}_monitor_videoProfile`, `${prefix}_probe_count`, `${prefix}_probe_window`
    );
  }
  return ids;
}

function cameraProfileProbeChecksComplete(checkIds, court, probeSampledAt) {
  const prefix = `court_${court}_probe_`;
  const fixed = new Set([`${prefix}count`, `${prefix}window`]);
  const dynamic = checkIds.filter((id) => typeof id === "string" && id.startsWith(prefix) && !fixed.has(id));
  const suffixes = [
    "video_count", "audio_count", "video_codec", "video_profile", "dimensions",
    "fps", "audio_codec", "audio_sample_rate", "audio_channels"
  ];
  if (dynamic.length !== suffixes.length) return false;
  const stems = suffixes.map((suffix) => {
    const matches = dynamic.filter((id) => id.endsWith(`_${suffix}`));
    return matches.length === 1 ? matches[0].slice(0, -(`_${suffix}`.length)) : null;
  });
  const expectedStem = `${prefix}${probeSampledAt}`;
  return Number.isFinite(Date.parse(probeSampledAt))
    && stems.every((stem) => typeof stem === "string" && stem === expectedStem);
}

function cameraMonitorProfile(profile) {
  return {
    protocol: profile?.sourceProtocol ?? null,
    mode: profile?.sourceMode ?? null,
    videoCodec: profile?.videoCodec ?? null,
    videoWidth: profile?.videoWidth ?? null,
    videoHeight: profile?.videoHeight ?? null,
    videoProfile: profile?.videoProfile ?? null,
    audioCodec: profile?.audioCodec ?? null,
    audioSampleRateHz: profile?.audioSampleRateHz ?? null,
    audioChannelCount: profile?.audioChannelCount ?? null
  };
}

function sourceProfilesEqual(observed, expected) {
  return SOURCE_FIELDS.every((field) => sourceFieldEqual(observed?.[field], expected?.[field]));
}

function cameraQualificationProfileMatches(observed, expected) {
  return sourceFieldEqual(observed?.sourceProtocol, expected?.protocol)
    && sourceFieldEqual(observed?.sourceMode, expected?.mode)
    && sourceFieldEqual(observed?.videoCodec, expected?.videoCodec)
    && observed?.videoWidth === expected?.videoWidth
    && observed?.videoHeight === expected?.videoHeight
    && Array.isArray(observed?.videoProfilesAllowed) && observed.videoProfilesAllowed.some((profile) => sourceFieldEqual(profile, expected?.videoProfile))
    && Number.isFinite(observed?.minimumFps) && observed.minimumFps >= 29
    && Number.isFinite(observed?.maximumFps) && observed.maximumFps >= observed.minimumFps && observed.maximumFps <= 31
    && sourceFieldEqual(observed?.audioCodec, expected?.audioCodec)
    && observed?.audioSampleRateHz === expected?.audioSampleRateHz
    && observed?.audioChannelCount === expected?.audioChannelCount;
}

function cameraProbeProfileMatches(observed, expected) {
  return sourceFieldEqual(observed?.videoCodec, expected?.videoCodec)
    && sourceFieldEqual(observed?.videoProfile, expected?.videoProfile)
    && observed?.videoWidth === expected?.videoWidth
    && observed?.videoHeight === expected?.videoHeight
    && Number.isFinite(observed?.videoFps) && observed.videoFps >= 29 && observed.videoFps <= 31
    && sourceFieldEqual(observed?.audioCodec, expected?.audioCodec)
    && observed?.audioSampleRateHz === expected?.audioSampleRateHz
    && observed?.audioChannelCount === expected?.audioChannelCount;
}

function sourceFieldEqual(left, right) {
  return typeof left === "string" && typeof right === "string"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function evaluateVenue(checks, config, venue, startEpochSeconds) {
  const capturedAt = Date.parse(venue?.capturedAt) / 1_000;
  const age = startEpochSeconds - capturedAt;
  const samples = Array.isArray(venue?.samples) ? venue.samples : [];
  const parsedSamples = samples.map((sample) => ({
    measuredAt: Date.parse(sample?.measuredAt) / 1_000,
    uploadBps: sample?.uploadBps,
    packetLossRatio: sample?.packetLossRatio
  }));
  const samplesValid = parsedSamples.every((sample) => Number.isFinite(sample.measuredAt)
    && Number.isFinite(sample.uploadBps) && sample.uploadBps > 0
    && Number.isFinite(sample.packetLossRatio) && sample.packetLossRatio >= 0 && sample.packetLossRatio <= 1);
  const timestamps = parsedSamples.map((sample) => sample.measuredAt);
  const ordered = samplesValid && timestamps.every((timestamp, index) => index === 0 || timestamp > timestamps[index - 1]);
  const allPreRunAndFresh = ordered && timestamps.every((timestamp) => timestamp <= capturedAt
    && timestamp <= startEpochSeconds
    && startEpochSeconds - timestamp <= config.maximumVenueEvidenceAgeSeconds);
  const spanSeconds = ordered && timestamps.length > 1 ? timestamps.at(-1) - timestamps[0] : null;
  const uploadP05 = samplesValid && samples.length ? percentile(parsedSamples.map((sample) => sample.uploadBps), 0.05) : null;
  const maximumPacketLoss = samplesValid && samples.length ? Math.max(...parsedSamples.map((sample) => sample.packetLossRatio)) : null;
  check(checks, "venue_evidence_schema", venue?.schemaVersion === 1, venue?.schemaVersion ?? null, 1);
  check(checks, "venue_evidence_fresh", Number.isFinite(age) && age >= 0 && age <= config.maximumVenueEvidenceAgeSeconds, Number.isFinite(age) ? age : null, `0..${config.maximumVenueEvidenceAgeSeconds} seconds`);
  check(checks, "venue_samples_valid", samplesValid, samplesValid ? "valid" : "missing or malformed", "timestamped upload and packet-loss samples");
  check(checks, "venue_samples_ordered", ordered, ordered, true);
  check(checks, "venue_samples_pre_run_and_fresh", allPreRunAndFresh, allPreRunAndFresh, true);
  check(checks, "venue_upload_samples", samples.length >= 3, samples.length, ">= 3");
  check(checks, "venue_measurement_span", Number.isFinite(spanSeconds) && spanSeconds >= config.minimumVenueMeasurementSpanSeconds, spanSeconds, `>= ${config.minimumVenueMeasurementSpanSeconds} seconds`);
  check(checks, "venue_upload_p05", Number.isFinite(uploadP05) && uploadP05 >= config.minimumVenueUploadBps, uploadP05, `>= ${config.minimumVenueUploadBps}`);
  check(checks, "venue_packet_loss", Number.isFinite(maximumPacketLoss) && maximumPacketLoss <= config.thresholds.maximumVenuePacketLossRatio, maximumPacketLoss, `<= ${config.thresholds.maximumVenuePacketLossRatio} for every sample`);
  check(checks, "venue_fail_closed_routing", venue?.failClosedRoutingVerified === true, venue?.failClosedRoutingVerified ?? null, true);
  check(checks, "venue_speedify_exit", venue?.speedifyExitVerified === true, venue?.speedifyExitVerified ?? null, true);
}

function toSingleCourtConfig(config, court) {
  return {
    schemaVersion: 2,
    gateId: `${config.gateId}-court${court.court}`,
    court: court.court,
    minimumDurationSeconds: config.minimumDurationSeconds,
    warmupSeconds: config.warmupSeconds,
    stepSeconds: config.stepSeconds,
    requiredBranches: court.requiredBranches,
    ffmpegBranches: court.ffmpegBranches,
    expectedSourceProfile: court.expectedSourceProfile,
    allowedBaselineUnclassified: {
      ingest: config.ingest.allowedBaselineUnclassified,
      compositor: court.compositor.allowedBaselineUnclassified
    },
    ingest: hostForSingle(config.ingest),
    compositor: hostForSingle(court.compositor),
    requireBrowser: true,
    thresholds: config.thresholds
  };
}

function hostPairConfig(config, compositor) {
  return {
    stepSeconds: config.stepSeconds,
    compositor,
    thresholds: config.thresholds,
    allowedBaselineUnclassified: {
      ingest: config.ingest.allowedBaselineUnclassified,
      compositor: compositor.allowedBaselineUnclassified
    }
  };
}

function toWarmSpareValidationConfig(config) {
  const validation = toSingleCourtConfig(config, config.courts[0]);
  return {
    ...validation,
    gateId: `${config.gateId}-warm-spare`,
    compositor: hostForSingle(config.warmSpare),
    allowedBaselineUnclassified: {
      ingest: config.ingest.allowedBaselineUnclassified,
      compositor: config.warmSpare.allowedBaselineUnclassified
    }
  };
}

function hostForSingle(host) {
  return { agent: host.agent, service: host.service, vcpus: host.vcpus };
}

function assertHost(host, name) {
  if (!host || typeof host !== "object") throw new Error(`${name} host is required`);
  safeLabel(`${name} hostId`, host.hostId);
  safeLabel(`${name} agent`, host.agent);
  safeLabel(`${name} service`, host.service);
  if (!Number.isInteger(host.vcpus) || host.vcpus < 1 || host.vcpus > 256) throw new Error(`${name} vcpus is invalid`);
  if (!Array.isArray(host.allowedBaselineUnclassified)) throw new Error(`${name} allowedBaselineUnclassified must be an array`);
}

function assertEightCourtAttestations(config, attestations) {
  if (attestations?.schemaVersion !== 1) throw new Error("eight-court attestations schemaVersion must be 1");
  if (!Number.isFinite(Date.parse(attestations.capturedAt))) throw new Error("attestations capturedAt is invalid");
  if (!Array.isArray(attestations.courts) || attestations.courts.length !== 8) throw new Error("attestations must contain exactly eight courts");
  const numbers = attestations.courts.map((court) => court?.court).sort((left, right) => left - right);
  if (numbers.some((court, index) => court !== index + 1)) throw new Error("attestations must assign each court 1 through 8 exactly once");
  for (const court of attestations.courts) {
    if (!config.courts.some((configured) => configured.court === court.court)) throw new Error(`attestation court ${court.court} is not configured`);
    if (court.egressErrors != null && (!Number.isInteger(court.egressErrors) || court.egressErrors < 0)) {
      throw new Error(`attestation court ${court.court} egressErrors is invalid`);
    }
    const configured = config.courts.find((entry) => entry.court === court.court);
    if (configured.commentaryRequired && court.avSyncObservedAt != null && !Number.isFinite(Date.parse(court.avSyncObservedAt))) {
      throw new Error(`attestation court ${court.court} avSyncObservedAt is invalid`);
    }
  }
}

function assertSourceProfile(profile, court) {
  if (!profile || typeof profile !== "object") throw new Error(`court ${court} source profile is required`);
  for (const field of SOURCE_FIELDS) {
    const value = profile[field];
    if (typeof value === "string") safeLabel(`court ${court} source ${field}`, value);
    else if (!Number.isInteger(value) || value <= 0) throw new Error(`court ${court} source ${field} is invalid`);
  }
}

function commentaryQueries(court) {
  return {
    commentary_connected: selector("scorecheck_program_commentary_room_connected", { court }),
    commentary_tracks: selector("scorecheck_program_commentary_audio_tracks", { court }),
    commentary_muted: selector("scorecheck_program_commentary_muted_tracks", { court }),
    commentary_clipping: selector("scorecheck_program_commentary_clipped_sample_ratio", { court }),
    commentary_silence: selector("scorecheck_program_commentary_silence_age_seconds", { court }),
    commentary_packets_lost: selector("scorecheck_program_commentary_packets_lost", { court }),
    commentary_packets_received: selector("scorecheck_program_commentary_packets_received", { court }),
    commentary_jitter: selector("scorecheck_program_commentary_jitter_buffer_ms", { court }),
    commentary_sync_locked: selector("scorecheck_program_commentary_sync_locked", { court }),
    commentary_sync_gap: selector("scorecheck_program_commentary_sync_gap_ms", { court })
  };
}

function selector(metric, labels) {
  return `${metric}{${Object.entries(labels).map(([name, value]) => `${name}=\"${safeLabel(name, String(value))}\"`).join(",")}}`;
}

function safeLabel(name, value) {
  if (typeof value !== "string" || !LABEL_VALUE.test(value)) throw new Error(`invalid ${name}: ${value}`);
  return value;
}

function metricSeriesCoverage(checks, name, rawSamples, options) {
  const samples = Array.isArray(rawSamples) ? rawSamples : [];
  const valid = samples.every((sample) => Number.isFinite(sample?.timestamp) && Number.isFinite(sample?.value));
  check(checks, `${name}_series_valid`, valid, valid ? "valid" : "missing or malformed", "finite timestamp/value samples");
  if (!valid) return;
  const timestamps = samples.map((sample) => sample.timestamp);
  const ordered = timestamps.every((timestamp, index) => index === 0 || timestamp > timestamps[index - 1]);
  check(checks, `${name}_series_ordered`, ordered, ordered, true);
  const inWindow = timestamps.every((timestamp) => timestamp >= options.startEpochSeconds && timestamp <= options.endEpochSeconds);
  check(checks, `${name}_series_window`, inWindow, inWindow, true);
  check(checks, `${name}_series_coverage`, samples.length >= options.minimumSamples, samples.length, `>= ${options.minimumSamples}`);
  if (samples.length === 0) return;
  const startGap = timestamps[0] - options.startEpochSeconds;
  const endGap = options.endEpochSeconds - timestamps.at(-1);
  let maximumGap = 0;
  for (let index = 1; index < timestamps.length; index += 1) maximumGap = Math.max(maximumGap, timestamps[index] - timestamps[index - 1]);
  check(checks, `${name}_series_start_edge`, startGap >= 0 && startGap <= options.maximumGapSeconds, startGap, `0..${options.maximumGapSeconds} seconds`);
  check(checks, `${name}_series_end_edge`, endGap >= 0 && endGap <= options.maximumGapSeconds, endGap, `0..${options.maximumGapSeconds} seconds`);
  check(checks, `${name}_series_maximum_gap`, ordered && maximumGap <= options.maximumGapSeconds, maximumGap, `<= ${options.maximumGapSeconds} seconds`);
}

function continuous(checks, series, name, minimumSamples, predicate, expected) {
  const observed = values(series, name);
  requireSamples(checks, name, observed, minimumSamples);
  if (observed.length >= minimumSamples) check(checks, `${name}_continuous`, predicate(observed), { minimum: Math.min(...observed), maximum: Math.max(...observed) }, expected);
}

function growth(checks, series, name, minimumSamples, maximumGrowth) {
  const observed = values(series, name);
  requireSamples(checks, name, observed, minimumSamples);
  if (observed.length >= minimumSamples) {
    const increase = resetAwareIncrease(observed);
    check(checks, `${name}_growth`, increase <= maximumGrowth, increase, `<= ${maximumGrowth}`);
  }
}

function boundedMaximum(checks, series, name, minimumSamples, maximum) {
  const observed = values(series, name);
  requireSamples(checks, name, observed, minimumSamples);
  if (observed.length >= minimumSamples) check(checks, `${name}_maximum`, Math.max(...observed) <= maximum, Math.max(...observed), `<= ${maximum}`);
}

function requireSamples(checks, name, observed, minimumSamples) {
  check(checks, `${name}_samples`, observed.length >= minimumSamples, observed.length, `>= ${minimumSamples}`);
}

function values(series, name) {
  return (series?.[name] ?? []).map((sample) => sample.value).filter(Number.isFinite);
}

function check(checks, id, pass, observed, expected) {
  checks.push({ id, pass: Boolean(pass), observed, expected });
}

function boundedSourceProfile(profile) {
  return Object.fromEntries(SOURCE_FIELDS.map((field) => [field, typeof profile?.[field] === "string" || Number.isFinite(profile?.[field]) ? profile[field] : null]));
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument near ${key ?? "end of command"}`);
    const name = key.slice(2);
    if (values[name] != null) throw new Error(`${key} may be provided only once`);
    values[name] = value;
  }
  for (const required of ["config", "attestations", "host-events", "pool-preflight", "venue-evidence", "camera-profile-report", "prometheus-url", "start", "end", "output"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(args.config, "utf8"));
  const attestations = JSON.parse(await readFile(args.attestations, "utf8"));
  const poolPreflight = JSON.parse(await readFile(args["pool-preflight"], "utf8"));
  const venueEvidence = JSON.parse(await readFile(args["venue-evidence"], "utf8"));
  const cameraProfileReportText = await readFile(args["camera-profile-report"], "utf8");
  const cameraProfileEvidence = {
    sha256: createHash("sha256").update(cameraProfileReportText).digest("hex"),
    report: JSON.parse(cameraProfileReportText)
  };
  assertEightCourtConfig(config);
  const startEpochSeconds = Date.parse(args.start) / 1_000;
  const endEpochSeconds = Date.parse(args.end) / 1_000;
  if (!Number.isFinite(startEpochSeconds) || !Number.isFinite(endEpochSeconds) || endEpochSeconds <= startEpochSeconds) throw new Error("--start and --end must define an increasing ISO-8601 window");
  const effectiveStartEpochSeconds = startEpochSeconds + config.warmupSeconds;
  const hostEventsText = await readFile(args["host-events"], "utf8");
  const hostEvents = parsePoolHostEventsNdjson(hostEventsText);
  const hostEventEvidence = {
    sha256: createHash("sha256").update(hostEventsText).digest("hex"),
    eventCount: hostEvents.length
  };
  const hostDefinitions = [config.ingest, ...config.courts.map((court) => court.compositor), config.warmSpare];
  assertExactPoolHostSet(config, hostEvents, poolPreflight);
  const hosts = Object.fromEntries(hostDefinitions.map((host, index) => [host.hostId, summarizePoolHost(hostEvents, {
    hostId: host.hostId,
    role: index === 0 ? "ingest" : "compositor",
    startEpochSeconds,
    endEpochSeconds,
    stepSeconds: config.stepSeconds
  })]));
  const queries = buildEightCourtQueries(config);
  const token = process.env.SCORECHECK_PROMETHEUS_BEARER_TOKEN ?? "";
  const cache = new Map();
  const limitQuery = createConcurrencyLimiter(PROMETHEUS_QUERY_CONCURRENCY);
  const runQuery = async (query) => {
    if (!cache.has(query)) {
      cache.set(query, limitQuery(() => queryRange(args["prometheus-url"], query, effectiveStartEpochSeconds, endEpochSeconds, config.stepSeconds, token)));
    }
    return cache.get(query);
  };
  const globalSeries = Object.fromEntries(await Promise.all(Object.entries(queries.global).map(async ([name, query]) => [name, await runQuery(query)])));
  const courtSeries = Object.fromEntries(await Promise.all(Object.entries(queries.courts).map(async ([court, courtQueries]) => [court, Object.fromEntries(await Promise.all(Object.entries(courtQueries).map(async ([name, query]) => [name, await runQuery(query)]))) ])));
  const evidence = { startEpochSeconds, effectiveStartEpochSeconds, endEpochSeconds, globalSeries, courtSeries };
  const report = evaluateEightCourtEvidence({ config, evidence, attestations, hosts, poolPreflight, venueEvidence, cameraProfileEvidence });
  await writeFile(args.output, `${JSON.stringify({ ...report, configuration: config, attestations, poolPreflight, venueEvidence, cameraProfileEvidence, hostEventEvidence, hosts, evidence }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(args.output, 0o600);
  process.stdout.write(`${report.verdict}: ${report.gateId} (${report.checks.filter((entry) => !entry.pass).length} aggregate failures; ${report.courts.filter((court) => court.verdict !== "PASS").length} court failures)\n`);
  process.exitCode = report.verdict === "PASS" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`eight-court gate error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
