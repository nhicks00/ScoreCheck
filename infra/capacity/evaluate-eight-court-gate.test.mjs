import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEightCourtConfig,
  assertExactPoolHostSet,
  buildEightCourtQueries,
  createConcurrencyLimiter,
  evaluateEightCourtEvidence
} from "./evaluate-eight-court-gate.mjs";

test("requires an exact one-court-per-worker topology and two commentary rooms", () => {
  const config = fixtureConfig();
  assert.doesNotThrow(() => assertEightCourtConfig(config));
  assert.throws(() => assertEightCourtConfig({ ...config, courts: config.courts.slice(0, 7) }), /exactly eight/);
  const duplicate = structuredClone(config);
  duplicate.courts[7].compositor.hostId = duplicate.courts[0].compositor.hostId;
  assert.throws(() => assertEightCourtConfig(duplicate), /unique compositor host/);
  const oneRoom = structuredClone(config);
  oneRoom.courts.forEach((court, index) => { court.commentaryRequired = index === 0; });
  assert.throws(() => assertEightCourtConfig(oneRoom), /at least two/);
  const assignedSpare = structuredClone(config);
  assignedSpare.warmSpare.hostId = assignedSpare.courts[0].compositor.hostId;
  assert.throws(() => assertEightCourtConfig(assignedSpare), /warm spare cannot own/);
  const undersizedWorker = structuredClone(config);
  undersizedWorker.courts[4].compositor.vcpus = 2;
  assert.throws(() => assertEightCourtConfig(undersizedWorker), /vcpus must match/);
  const invalidLastWorkerBaseline = structuredClone(config);
  invalidLastWorkerBaseline.courts[7].compositor.allowedBaselineUnclassified = [{ command: "bad" }];
  assert.throws(() => assertEightCourtConfig(invalidLastWorkerBaseline), /parentCommand/);
  const weakenedCoverage = structuredClone(config);
  weakenedCoverage.thresholds.minimumSampleCoverageRatio = 0.989;
  assert.throws(() => assertEightCourtConfig(weakenedCoverage), /at least 0.99/);
});

test("builds lifecycle, score, provider, and exact-reader queries for every court", () => {
  const queries = buildEightCourtQueries(fixtureConfig());
  assert.equal(Object.keys(queries.courts).length, 8);
  assert.match(queries.courts[1].browser_sessions, /scorecheck_program_browser_sessions_total/);
  assert.match(queries.courts[1].score_render_aligned, /scorecheck_program_score_render_aligned/);
  assert.match(queries.courts[1].path_readers_program, /branch="program"/);
  assert.match(queries.courts[1].compositor_assignment_count, /sum\(/);
  assert.match(queries.courts[1].commentary_sync_locked, /commentary_sync_locked/);
  assert.equal(queries.courts[3].commentary_sync_locked, undefined);
  assert.match(queries.global.active_alerts, /ALERTS/);
  assert.equal(queries.global.active_incidents, "scorecheck_active_incidents");
  assert.equal(queries.global.active_fault_gates, "scorecheck_active_fault_gates");
  assert.equal(queries.global.monitor_process_start_time, 'process_start_time_seconds{job="monitor-service"}');
  assert.equal(queries.global.dead_man_healthy, "min(scorecheck_external_dead_man_healthy)");
  assert.equal(queries.global.phone_channel_ready, "min(scorecheck_external_dead_man_phone_channel_ready)");
  assert.equal(queries.global.dead_man_active_running, "scorecheck_external_dead_man_active_running");
  assert.equal(queries.global.dead_man_channel_audit, "scorecheck_external_dead_man_channel_audit_healthy");
  assert.equal(queries.global.dead_man_test_gate_active, "max(scorecheck_external_dead_man_test_gate_active)");
  assert.match(queries.global.warm_spare_can_accept, /bvm-compositor-spare/);
});

test("rejects missing and extra host identities in the protected pool evidence", () => {
  const config = fixtureConfig();
  const hosts = [config.ingest, ...config.courts.map((court) => court.compositor), config.warmSpare];
  const expected = hosts.map((host, index) => ({
    hostId: host.hostId,
    event: "watcher_started",
    machineFingerprint: index.toString(16).padStart(16, "0"),
    provider: "digitalocean",
    providerResourceId: String(index + 1),
    providerHostname: host.hostId
  }));
  const preflight = { providerResources: providerResources(hosts) };
  assert.doesNotThrow(() => assertExactPoolHostSet(config, expected, preflight));
  assert.throws(() => assertExactPoolHostSet(config, expected.slice(0, -1), preflight), /do not match/);
  assert.throws(() => assertExactPoolHostSet(config, [...expected, { hostId: "unexpected-host" }], preflight), /do not match/);
  const duplicateMachine = structuredClone(expected);
  duplicateMachine[9].machineFingerprint = duplicateMachine[1].machineFingerprint;
  assert.throws(() => assertExactPoolHostSet(config, duplicateMachine, preflight), /same physical machine/);
  const missingMachine = structuredClone(expected);
  delete missingMachine[4].machineFingerprint;
  assert.throws(() => assertExactPoolHostSet(config, missingMachine, preflight), /remote machine fingerprint/);
  const mismatchedProvider = structuredClone(expected);
  mismatchedProvider[4].providerResourceId = "999";
  assert.throws(() => assertExactPoolHostSet(config, mismatchedProvider, preflight), /does not match the active DigitalOcean resource/);
  const missingProvider = structuredClone(expected);
  delete missingProvider[4].providerResourceId;
  assert.throws(() => assertExactPoolHostSet(config, missingProvider, preflight), /DigitalOcean identity at every watcher start/);
  const duplicateProvider = structuredClone(expected);
  duplicateProvider[9].providerResourceId = duplicateProvider[1].providerResourceId;
  const duplicatePreflight = structuredClone(preflight);
  duplicatePreflight.providerResources[9].resourceId = duplicatePreflight.providerResources[1].resourceId;
  assert.throws(() => assertExactPoolHostSet(config, duplicateProvider, duplicatePreflight), /same provider resource/);
});

test("bounds endpoint Prometheus collection concurrency", async () => {
  const limit = createConcurrencyLimiter(3);
  let active = 0;
  let maximum = 0;
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => limit(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return index;
  })));
  assert.equal(maximum, 3);
  assert.deepEqual(results, Array.from({ length: 20 }, (_, index) => index));
  await assert.rejects(createConcurrencyLimiter(1)(null), /must be a function/);
});

test("passes only complete eight-court evidence", () => {
  const input = passingInput();
  const report = evaluateEightCourtEvidence(input);
  assert.equal(report.verdict, "PASS", failures(report));
  assert.equal(report.courts.length, 8);
  assert.ok(report.courts.every((court) => court.verdict === "PASS"));
});

test("rounds the final gate's 99 percent sample requirement upward", () => {
  const input = passingInput();
  input.evidence.globalSeries.control_plane_fresh = Array.from({ length: 119 }, (_, index) => ({
    timestamp: 120 + (index * (7_200 / 118)),
    value: 1
  }));
  const report = evaluateEightCourtEvidence(input);
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "global_control_plane_fresh_series_coverage")?.pass, false);
});

test("fails direct evaluator calls with missing or mismatched provider bindings", () => {
  const missing = passingInput();
  delete missing.hosts[missing.config.courts[3].compositor.hostId].providerIdentity;
  let report = evaluateEightCourtEvidence(missing);
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "pool_host_provider_bindings")?.pass, false);

  const mismatched = passingInput();
  mismatched.hosts[mismatched.config.courts[3].compositor.hostId].providerIdentity.resourceId = "999";
  report = evaluateEightCourtEvidence(mismatched);
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "pool_host_provider_bindings")?.pass, false);
});

test("fails on browser session churn, a firing alert, an unavailable spare, or venue headroom below floor", () => {
  for (const mutate of [
    (input) => { input.evidence.courtSeries[4].browser_sessions = series([0, 0, 1, 1]); },
    (input) => { input.evidence.courtSeries[1].browser_fresh[40].value = 0; },
    (input) => { input.evidence.courtSeries[1].raw_bitrate[40].value = 0; },
    (input) => { input.evidence.courtSeries[1].ffmpeg_fps_preview[40].value = 10; },
    (input) => { input.evidence.globalSeries.active_alerts = series([0, 1, 0, 0]); },
    (input) => { input.evidence.globalSeries.active_incidents = series([0, 1, 1, 1]); },
    (input) => { input.evidence.globalSeries.active_fault_gates = series([0, 0, 1, 1]); },
    (input) => { input.evidence.globalSeries.dead_man_active_running = series([1, 1, 0, 0]); },
    (input) => { input.evidence.globalSeries.dead_man_test_gate_active = series([0, 1, 1, 0]); },
    (input) => { input.evidence.globalSeries.monitor_process_start_time = series([10, 10, 20, 20]); },
    (input) => { input.evidence.globalSeries.snapshot_generated = input.evidence.globalSeries.snapshot_generated.map((sample) => ({ ...sample, value: sample.timestamp - 16 })); },
    (input) => { input.poolPreflight.compositors.exactPlan.matchedNames.pop(); input.poolPreflight.compositors.matchingActive = 8; },
    (input) => { input.poolPreflight.region = "nyc3"; },
    (input) => { input.poolPreflight.size.slug = "s-4vcpu-8gb"; },
    (input) => { input.evidence.globalSeries.warm_spare_can_accept = series([1, 1, 0, 1]); },
    (input) => { input.evidence.courtSeries[2].compositor_assignment_count = series([1, 1, 2, 2]); },
    (input) => { input.poolPreflight.checkedAt = new Date(1_000).toISOString(); },
    (input) => { input.venueEvidence.capturedAt = new Date(1_000).toISOString(); },
    (input) => { input.attestations.capturedAt = new Date(7_319_000).toISOString(); },
    (input) => { input.attestations.courts[0].avSyncObservedAt = new Date(60_000).toISOString(); },
    (input) => { input.venueEvidence.samples[0].uploadBps = 74_999_999; },
    (input) => { input.venueEvidence.samples[1].measuredAt = input.venueEvidence.samples[0].measuredAt; }
  ]) {
    const input = passingInput();
    mutate(input);
    const report = evaluateEightCourtEvidence(input);
    assert.equal(report.verdict, "FAIL");
  }
});

test("fails closed when one worker has no independent host evidence", () => {
  const input = passingInput();
  delete input.hosts["bvm-compositor-h"];
  assert.throws(() => evaluateEightCourtEvidence(input), /host evidence is missing for court 8/);
  const missingSpare = passingInput();
  delete missingSpare.hosts[missingSpare.config.warmSpare.hostId];
  assert.throws(() => evaluateEightCourtEvidence(missingSpare), /ingest host or warm spare/);
});

test("fails a clustered Prometheus series that leaves a monitoring blind spot", () => {
  const input = passingInput();
  const samples = input.evidence.courtSeries[1].browser_fps;
  input.evidence.courtSeries[1].browser_fps = samples.filter((sample) => sample.timestamp < 2_000 || sample.timestamp > 2_120);
  const report = evaluateEightCourtEvidence(input);
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "court1_browser_fps_series_maximum_gap")?.pass, false);
});

function passingInput() {
  const config = fixtureConfig();
  const queries = buildEightCourtQueries(config);
  const globalSeries = Object.fromEntries(Object.keys(queries.global).map((name) => [name, series([1, 1, 1, 1])]));
  globalSeries.agent_count = series([11, 11, 11, 11]);
  globalSeries.active_alerts = series([0, 0, 0, 0]);
  globalSeries.active_incidents = series([0, 0, 0, 0]);
  globalSeries.active_fault_gates = series([0, 0, 0, 0]);
  globalSeries.dead_man_test_gate_active = series([0, 0, 0, 0]);
  globalSeries.warm_spare_active_requests = series([0, 0, 0, 0]);
  globalSeries.warm_spare_assignments = series([0, 0, 0, 0]);
  globalSeries.warm_spare_restarts = series([0, 0, 0, 0]);
  globalSeries.warm_spare_oom = series([0, 0, 0, 0]);
  globalSeries.total_compositor_assignments = series([8, 8, 8, 8]);
  globalSeries.monitor_process_start_time = series([10, 10, 10, 10]);
  globalSeries.snapshot_generated = series([0]).map((sample) => ({ ...sample, value: sample.timestamp }));
  const courtSeries = {};
  for (const court of config.courts) {
    const values = Object.fromEntries(Object.keys(queries.courts[court.court]).map((name) => [name, series([1, 1, 1, 1])]));
    for (const name of Object.keys(values)) {
      if (/(?:frame_errors|ffmpeg_dropped|ffmpeg_duplicated|browser_dropped|browser_freeze_duration|browser_packets_lost|browser_reconnects|browser_reloads|browser_sessions|visual_frozen|visual_black|camera_audio_silence|camera_audio_clipping|youtube_degraded|commentary_muted|commentary_clipping|commentary_silence|commentary_packets_lost|commentary_jitter|commentary_sync_gap|active_requests|restarts|oom)$/.test(name)) values[name] = series([0, 0, 0, 0]);
      if (/memory$/.test(name)) values[name] = series([1_000, 1_000, 1_000, 1_000]);
      if (/cpu$/.test(name)) values[name] = series([1, 1, 1, 1]);
    }
    values.raw_bitrate = series([2_500_000, 2_500_000, 2_500_000, 2_500_000]);
    for (const branch of court.ffmpegBranches) {
      values[`ffmpeg_fps_${branch}`] = series([30, 30, 30, 30]);
      values[`ffmpeg_speed_${branch}`] = series([1, 1, 1, 1]);
    }
    values.browser_fps = series([30, 30, 30, 30]);
    values.browser_received = series([0, 100, 200, 300]);
    values.egress_idle = series([0, 0, 0, 0]);
    values.egress_can_accept = series([0, 0, 0, 0]);
    values.egress_active_web_requests = series([1, 1, 1, 1]);
    values.egress_maximum_web_requests = series([1, 1, 1, 1]);
    if (court.commentaryRequired) values.commentary_packets_received = series([0, 100, 200, 300]);
    courtSeries[court.court] = values;
  }
  const hostDefinitions = [config.ingest, ...config.courts.map((court) => court.compositor), config.warmSpare];
  const hosts = Object.fromEntries(hostDefinitions.map((host, index) => [host.hostId, {
    ...hostEvidence(),
    providerIdentity: { provider: "digitalocean", resourceId: String(index + 1), hostname: host.hostId }
  }]));
  const profiles = Object.fromEntries(config.courts.map((court) => [court.court, court.expectedSourceProfile]));
  return {
    config,
    evidence: { startEpochSeconds: 0, effectiveStartEpochSeconds: 120, endEpochSeconds: 7_320, globalSeries, courtSeries },
    attestations: {
      schemaVersion: 1,
      capturedAt: new Date(7_380_000).toISOString(),
      crossCourtIsolationVerified: true,
      youtubeBroadcastsUnlisted: true,
      youtubeAutoLifecycleDisabled: true,
      courts: config.courts.map((court) => ({
        court: court.court,
        observedSourceProfile: profiles[court.court],
        assignmentVerified: true,
        egressErrors: 0,
        egressShmEnabled: true,
        avSyncObserved: court.commentaryRequired,
        avSyncObservedAt: court.commentaryRequired ? new Date(3_600_000).toISOString() : null
      }))
    },
    hosts,
    poolPreflight: {
      checkedAt: new Date(-100_000).toISOString(),
      status: "PASS",
      region: "sfo2",
      size: { slug: "c-4", vcpus: 4 },
      providerResources: providerResources(hostDefinitions),
      compositors: {
        matchingActive: 9,
        target: 9,
        additionsRequired: 0,
        exactPlan: {
          complete: true,
          matchedNames: [...config.courts.map((court) => court.compositor.hostId), config.warmSpare.hostId].sort(),
          missingSlots: [], conflicts: [], extraTagged: []
        }
      },
      blockers: []
    },
    venueEvidence: {
      schemaVersion: 1,
      capturedAt: new Date(-50_000).toISOString(),
      samples: [-500_000, -300_000, -100_000].map((measuredAt) => ({
        measuredAt: new Date(measuredAt).toISOString(),
        uploadBps: 80_000_000,
        packetLossRatio: 0
      })),
      failClosedRoutingVerified: true,
      speedifyExitVerified: true
    }
  };
}

function fixtureConfig() {
  const source = {
    protocol: "SRT", mode: "PUSH", videoCodec: "H264", videoWidth: 1280, videoHeight: 720,
    videoProfile: "Main", audioCodec: "AAC", audioSampleRateHz: 48000, audioChannelCount: 2
  };
  return {
    schemaVersion: 1,
    gateId: "eight-court-endurance",
    minimumDurationSeconds: 7_320,
    warmupSeconds: 120,
    stepSeconds: 60,
    expectedAgentCount: 11,
    expectedPoolRegion: "sfo2",
    expectedPoolSizeSlug: "c-4",
    expectedPoolSizeVcpus: 4,
    minimumVenueUploadBps: 75_000_000,
    maximumVenueEvidenceAgeSeconds: 3_600,
    minimumVenueMeasurementSpanSeconds: 300,
    maximumPoolPreflightAgeSeconds: 300,
    maximumAttestationLagSeconds: 900,
    warmSpare: { hostId: "bvm-compositor-spare", agent: "bvm-compositor-spare", service: "bvm-egress", vcpus: 4, allowedBaselineUnclassified: [] },
    ingest: { hostId: "bvm-preview-01", agent: "bvm-preview-01", service: "mediamtx", vcpus: 8, allowedBaselineUnclassified: [] },
    courts: Array.from({ length: 8 }, (_, index) => ({
      court: index + 1,
      requiredBranches: ["raw", "preview", "program"],
      ffmpegBranches: ["preview", "program"],
      expectedSourceProfile: { ...source },
      commentaryRequired: index < 2,
      compositor: {
        hostId: `bvm-compositor-${String.fromCharCode(97 + index)}`,
        agent: `bvm-compositor-${String.fromCharCode(97 + index)}`,
        service: "bvm-egress",
        vcpus: 4,
        allowedBaselineUnclassified: []
      }
    })),
    thresholds: {
      minimumSampleCoverageRatio: 0.99,
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
      maximumHostSampleGapSeconds: 60,
      maximumHostSampleLagMs: 250,
      maximumShmRatio: 0.8,
      maximumZombieWatcherHeartbeatGapSeconds: 2,
      maximumZombieWatcherScanGapMs: 250,
      maximumZombiePollIntervalMs: 50,
      maximumObserverZombieDurationMs: 2_000,
      maximumObserverZombieEvents: 480,
      maximumObserverZombieEventsPerMinute: 16,
      maximumWorkloadZombieDurationMs: 500,
      maximumWorkloadZombieEvents: 16,
      maximumWorkloadZombieEventsPerMinute: 8,
      maximumWorkloadConcurrentZombies: 1,
      maximumCameraAudioSilenceSeconds: 60,
      maximumCameraAudioClippedSampleRatio: 0.05,
      maximumCommentaryClippedSampleRatio: 0.05,
      maximumCommentarySilenceSeconds: 60,
      maximumCommentaryJitterMs: 300,
      maximumCommentarySyncGapMs: 250,
      maximumCommentaryPacketLossRatio: 0.1,
      maximumVenuePacketLossRatio: 0.01,
      maximumBrowserLowFpsRatio: 0.005,
      maximumRawLowBitrateRatio: 0.005,
      maximumFfmpegLowFpsRatio: 0.005,
      maximumMetricSampleGapSeconds: 90,
      maximumSnapshotAgeSeconds: 15
    }
  };
}

function providerResources(hosts) {
  return hosts.map((host, index) => ({
    provider: "digitalocean",
    resourceType: "droplet",
    resourceId: String(index + 1),
    name: host.hostId,
    status: "active",
    region: "sfo2",
    size: host.hostId === "bvm-preview-01" ? "c-8" : "c-4"
  }));
}

function hostEvidence() {
  return {
    samples: {
      coverageRatio: 1, p95GapSeconds: 5, maxGapSeconds: 5, startEdgeGapSeconds: 0,
      endEdgeGapSeconds: 0, baselineAgeSeconds: 5, cpuP95Ratio: 0.5, cpuMaxRatio: 0.6,
      sampleLagP95Ms: 20, sampleLagMaxMs: 30, shmMaxRatio: 0.2
    },
    zombies: {
      watcherStartedAt: "1969-12-31T23:59:59.000Z", pollIntervalMs: 50, watcherRestarts: 0,
      watcherStops: 0, startEdgeGapSeconds: 1, endEdgeGapSeconds: 1, maximumHeartbeatGapSeconds: 1,
      maximumScanGapMs: 55, baselineUnclassifiedEvents: [], newUnclassifiedCount: 0,
      newUnclassifiedEvents: [], observerMaximumDurationMs: 0, observerEventCount: 0,
      observerMaximumRollingMinuteCount: 0, workloadMaximumDurationMs: 0, workloadEventCount: 0,
      workloadClassifications: {}, workloadMaximumRollingMinuteCount: 0,
      workloadMaximumConcurrentCount: 0, unclosedObserverCount: 0, unclosedWorkloadCount: 0,
      orphanCloseCount: 0
    }
  };
}

function series(values) {
  const sampleCount = 121;
  return Array.from({ length: sampleCount }, (_, index) => ({
    timestamp: 120 + index * 60,
    value: values[Math.min(values.length - 1, Math.floor((index * values.length) / sampleCount))]
  }));
}

function failures(report) {
  return JSON.stringify({
    aggregate: report.checks.filter((check) => !check.pass),
    courts: report.courts.map((court) => ({ court: court.court, failures: court.checks.filter((check) => !check.pass) })).filter((entry) => entry.failures.length)
  }, null, 2);
}
