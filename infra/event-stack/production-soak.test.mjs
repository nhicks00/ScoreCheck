import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  browserDeltaProblems,
  assertProductionMonitorSnapshot,
  evaluateProductionSoak,
  evaluatePeplinkRouterEvidence,
  evaluateHlsRuntimeEvidence,
  evaluateSpeedifyEvidence,
  assertStartupObserversRunning,
  ensureStartupObserver,
  fetchProductionMonitorSnapshot,
  outputConformanceProblems,
  persistentOutputProblems,
  probeAdmittedSourceProfile,
  productionEgressOwner,
  productionIdleProblems,
  productionProviderIdleProblems,
  productionProviderProblems,
  productionPeplinkRouterProblems,
  productionRawProblems,
  productionRouterPreflightProblems,
  reconcileHostRecoveredEgress,
  recoverOwnedProgramEgress,
  sourceBitrateWindowStep,
  stopFailedStartupResources,
  stopPreOutputStartupResources,
  stopStartupObservers,
  productionSnapshotProblems,
  viewerEvidenceProblems
} from "./production-soak.mjs";
import { createSyntheticRehearsalVenueProfile, evaluateVenueAdmission } from "./venue-admission.mjs";

const startedMs = Date.parse("2026-07-21T12:00:00Z");
const venueProfile = createSyntheticRehearsalVenueProfile("six-camera-soak");
for (const camera of [1, 2]) {
  venueProfile.cameras[camera - 1].sourceProfile = "PRIORITY_1080P60";
  venueProfile.cameras[camera - 1].frameRateMode = "60/1";
  venueProfile.cameras[camera - 1].sourceRateCapMbps = 12;
}
for (const camera of [7, 8]) venueProfile.cameras[camera - 1] = { cameraNumber: camera, cameraIdentity: `camera-${camera}`, publishPath: `court${camera}_raw`, enabled: false };
venueProfile.uploadMeasurement.sustainedUploadMbps = 80;
const venue = { ...evaluateVenueAdmission(venueProfile), sha256: "f".repeat(64) };
const runBinding = {
  renderer: {
    gitSha: "a".repeat(40),
    deploymentId: "dpl_renderer123",
    runtimeOrigin: "http://renderer:3000",
    releaseOrigin: "https://scorecheck-test.vercel.app",
    bundleSha256: "c".repeat(64),
    assetNamespace: "dpl_renderer123",
    contracts: {
      programSession: "program-session-v1",
      overlayState: "overlay-state-v1",
      commentary: "commentary-v1",
      browserHeartbeat: "browser-heartbeat-v6"
    }
  },
  destinations: Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
    const camera = index + 1;
    return [camera, { streamId: `stream-${camera}`, broadcastId: `broadcast-${camera}` }];
  }))
};
const profiles = Object.fromEntries(venue.activeCameras.map((camera) => {
  const framesPerSecond = camera <= 2 ? 60 : 30;
  return [camera, {
    profile: framesPerSecond === 60 ? "1080p60" : "1080p30",
    width: 1920,
    height: 1080,
    framesPerSecond,
    videoBitrateKbps: framesPerSecond === 60 ? 12_000 : 10_000,
    sourcePathMode: "direct-h264",
    source: { codec: "H264", frameRateMode: framesPerSecond === 60 ? "60/1" : "30/1" },
    browserInput: { codec: "H264", hasBFrames: 0, pixelFormat: "yuv420p" }
  }];
}));

test("starts through the real CLI entrypoint after module initialization", () => {
  const script = fileURLToPath(new URL("./production-soak.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Usage:/);
  assert.match(result.stdout, /--ffprobe \/ABSOLUTE\/ffprobe/u);

  const missingProbe = spawnSync(process.execPath, [script, "status", "--profile", "/tmp/profile", "--destinations", "/tmp/destinations", "--evidence", "/tmp/evidence"], { encoding: "utf8" });
  assert.equal(missingProbe.status, 1);
  assert.match(missingProbe.stderr, /--ffprobe are required/u);
});

test("hard-cuts the production soak client to monitoring snapshot contract v6", () => {
  const current = snapshot({ active: false });
  assert.equal(assertProductionMonitorSnapshot(current), current);
  assert.throws(() => assertProductionMonitorSnapshot({ ...current, version: 4 }), /snapshot contract is invalid/u);
});

test("builds complete local-renderer Egress ownership", () => {
  assert.deepEqual(productionEgressOwner({ event: "event-test", runId: "run-test", runBinding }, 1), {
    event: "event-test",
    destinationId: "broadcast-1",
    destinationRole: "primary",
    outputGeneration: "run-test",
    rendererGitSha: "a".repeat(40),
    rendererDeploymentId: "dpl_renderer123",
    rendererRuntimeOrigin: "http://renderer:3000",
    rendererReleaseOrigin: "https://scorecheck-test.vercel.app",
    rendererBundleSha256: "c".repeat(64)
  });
});

test("requires a repeatable source-profile failure before rejecting admission", async () => {
  let attempts = 0;
  const sleeps = [];
  const recovered = await probeAdmittedSourceProfile({
    sourceProbe: {
      probe: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient packet cadence");
        return profiles[3];
      }
    },
    host: "198.51.100.1",
    camera: 3,
    assignment: venue.assignments[3],
    sleep: async (milliseconds) => { sleeps.push(milliseconds); }
  });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(recovered, profiles[3]);

  attempts = 0;
  const rejected = await probeAdmittedSourceProfile({
    sourceProbe: { probe: async () => { attempts += 1; throw new Error(`persistent failure ${attempts}`); } },
    host: "198.51.100.1",
    camera: 3,
    assignment: venue.assignments[3],
    sleep: async () => {}
  });
  assert.equal(attempts, 2);
  assert.equal(rejected.admitted, false);
  assert.match(rejected.admissionError, /persistent failure 2/u);
});

test("stops every run-owned observer after startup failure", async () => {
  const state = {
    startupFailure: { error: "startup failed" },
    sampler: { output: "/evidence/sampler.jsonl" },
    sentinel: { output: "/evidence/sentinel.jsonl" },
    criticalLogs: { output: "/evidence/logs.jsonl" }
  };
  const calls = [];
  const runtime = (name) => ({ stop: async (value) => { calls.push(name); return { ...value, status: "stopped" }; } });
  await stopStartupObservers({ state, sampler: runtime("sampler"), sentinel: runtime("sentinel"), criticalLogs: runtime("criticalLogs") });
  assert.deepEqual(calls, ["sampler", "sentinel", "criticalLogs"]);
  assert.equal(state.sampler.status, "stopped");
  assert.equal(state.sentinel.status, "stopped");
  assert.equal(state.criticalLogs.status, "stopped");
});

test("stops HEVC normalizers when startup fails before any output exists", async () => {
  const state = {
    startupFailure: { error: "startup failed" },
    normalizers: { 1: { required: true, running: true, camera: 1 } }
  };
  const calls = [];
  await stopPreOutputStartupResources({
    state,
    normalizer: { stop: async (value) => { calls.push(value); return { required: true, running: false, camera: 1, absent: true }; } },
    expectations: { clear: async () => assert.fail("absent expectation must not be cleared") },
    sampler: { stop: async () => assert.fail("absent sampler must not be stopped") },
    sentinel: { stop: async () => assert.fail("absent sentinel must not be stopped") },
    criticalLogs: { stop: async () => assert.fail("absent logs must not be stopped") },
    manifest: { droplets: [{ name: "bvm-compositor-a", role: "compositor", court: 1 }] },
    lifecycleState: { droplets: { "bvm-compositor-a": { publicIpv4: "198.51.100.1" } } }
  });
  assert.deepEqual(calls, [{ host: "198.51.100.1", court: 1 }]);
  assert.equal(state.normalizers[1].running, false);
});

test("clears run-owned monitoring expectations when startup fails before output", async () => {
  const state = {
    runId: "run-1",
    startupFailure: { error: "startup failed" },
    monitoringBinding: { eventId: "event-1", cameras: { 1: "court-1" } },
    monitoringExpectations: { 1: { phase: "TESTING" } }
  };
  const calls = [];
  await stopPreOutputStartupResources({
    state,
    normalizer: { stop: async () => assert.fail("absent normalizer must not be stopped") },
    expectations: { clear: async (value) => { calls.push(value); return { phase: "CLEARED", observedAt: "2026-07-26T12:00:00Z" }; } },
    sampler: { stop: async () => assert.fail("absent sampler must not be stopped") },
    sentinel: { stop: async () => assert.fail("absent sentinel must not be stopped") },
    criticalLogs: { stop: async () => assert.fail("absent logs must not be stopped") },
    manifest: { droplets: [] },
    lifecycleState: { droplets: {} }
  });
  assert.deepEqual(calls, [{ binding: state.monitoringBinding, camera: 1, runId: "run-1" }]);
  assert.equal(state.monitoringExpectations[1].phase, "CLEARED");
});

test("unwinds every resource owned by a partially started production run", async () => {
  const state = {
    runId: "run-1",
    startupFailure: { error: "startup failed" },
    egress: {
      1: { id: "EG_1", host: "198.51.100.1", profile: "1080p30", owner: { event: "event-1" } },
      2: { id: "EG_2", host: "198.51.100.2", profile: "1080p30", owner: { event: "event-1" } }
    },
    normalizers: { 1: { required: true, running: true } },
    monitoringBinding: { eventId: "event-1", cameras: { 1: "court-1", 2: "court-2" } },
    monitoringDestinations: {
      1: { broadcastId: "broadcast-1", previousVideoId: "old-video-1" },
      2: { broadcastId: "broadcast-2", previousVideoId: "old-video-2" }
    },
    monitoringExpectations: { 1: { phase: "LIVE" }, 2: { phase: "TESTING" } },
    sampler: { output: "/evidence/sampler.jsonl" },
    sentinel: { output: "/evidence/sentinel.jsonl" },
    criticalLogs: { output: "/evidence/logs.jsonl" },
    router: { status: "running", output: "/evidence/router.tsv" }
  };
  const calls = [];
  const broadcasts = new Map([["broadcast-1", "live"], ["broadcast-2", "testing"]]);
  await stopFailedStartupResources({
    state,
    egress: { stopExact: async ({ court, egressId }) => { calls.push(`egress:${court}:${egressId}`); } },
    youtube: {
      getBroadcast: async (id) => ({ id, lifeCycleStatus: broadcasts.get(id) }),
      transitionBroadcast: async (id, phase) => { calls.push(`youtube:${id}:${phase}`); broadcasts.set(id, phase); }
    },
    destinations: { broadcasts: { 1: { id: "broadcast-1" }, 2: { id: "broadcast-2" } } },
    normalizer: { stop: async ({ court }) => { calls.push(`normalizer:${court}`); return { required: true, running: false }; } },
    expectations: {
      clear: async ({ camera }) => { calls.push(`expectation:${camera}`); return { phase: "CLEARED" }; },
      restoreDestination: async ({ camera, broadcastId }) => {
        calls.push(`destination:${camera}:${broadcastId}`);
        return { status: "RESTORED", broadcastId };
      }
    },
    sampler: { stop: async (value) => { calls.push("sampler"); return { ...value, status: "stopped" }; } },
    sentinel: { stop: async (value) => { calls.push("sentinel"); return { ...value, status: "stopped" }; } },
    criticalLogs: { stop: async (value) => { calls.push("criticalLogs"); return { ...value, status: "stopped" }; } },
    router: { stopAndFetch: async (_value, output) => { calls.push(`router:${output}`); return { status: "stopped", output }; } },
    evidenceRoot: "/evidence",
    manifest: { droplets: [{ name: "bvm-compositor-a", role: "compositor", court: 1 }] },
    lifecycleState: { droplets: { "bvm-compositor-a": { publicIpv4: "198.51.100.1" } } }
  });
  assert.deepEqual(calls, [
    "egress:2:EG_2",
    "egress:1:EG_1",
    "youtube:broadcast-1:complete",
    "youtube:broadcast-2:complete",
    "normalizer:1",
    "expectation:1",
    "expectation:2",
    "destination:1:broadcast-1",
    "destination:2:broadcast-2",
    "sampler",
    "sentinel",
    "criticalLogs",
    "router:/evidence/startup-failure-router.tsv"
  ]);
  assert.equal(state.egress[1].status, "stopped");
  assert.equal(state.egress[2].status, "stopped");
  assert.equal(state.providerCleanup[1].lifecycleStatus, "complete");
  assert.equal(state.providerCleanup[2].lifecycleStatus, "complete");
  assert.equal(state.monitoringExpectations[1].phase, "CLEARED");
  assert.equal(state.monitoringExpectations[2].phase, "CLEARED");
  assert.equal(state.monitoringDestinations[1].status, "RESTORED");
  assert.equal(state.monitoringDestinations[2].status, "RESTORED");
  assert.equal(state.router.status, "stopped");
});

test("preserves exact cleanup failures instead of claiming a failed-start resource stopped", async () => {
  const state = {
    runId: "run-1",
    startupFailure: { error: "startup failed" },
    egress: { 1: { id: "EG_1", host: "198.51.100.1", profile: "1080p30", owner: { event: "event-1" } } }
  };
  await stopFailedStartupResources({
    state,
    egress: { stopExact: async () => { throw new Error("remote stop failed"); } },
    youtube: { getBroadcast: async () => ({ id: "broadcast-1", lifeCycleStatus: "ready" }) },
    destinations: { broadcasts: { 1: { id: "broadcast-1" } } },
    normalizer: {},
    expectations: {},
    sampler: {},
    sentinel: {},
    criticalLogs: {},
    manifest: { droplets: [] },
    lifecycleState: { droplets: {} }
  });
  assert.equal(state.egress[1].status, undefined);
  assert.deepEqual(state.startupFailure.cleanupErrors, ["Camera 1 Egress: remote stop failed"]);
});

test("recycles an idle worker before replaying an interrupted owned browser recovery", async () => {
  const calls = [];
  const replacement = await recoverOwnedProgramEgress({
    egress: {
      listActive: async () => [],
      recycleIdleWorker: async (host) => { calls.push(`recycle:${host}`); },
      ensureStarted: async ({ host, court }) => { calls.push(`start:${host}:${court}`); return { id: "EG_replacement" }; }
    },
    host: "198.51.100.1",
    court: 1,
    profile: "1080p30",
    owner: { event: "event-test" },
    oldEgressId: "EG_old"
  });
  assert.equal(replacement.id, "EG_replacement");
  assert.deepEqual(calls, ["recycle:198.51.100.1", "start:198.51.100.1:1"]);
});

test("adopts a host-local Egress recovery only after exact ownership reconciliation", async () => {
  const current = { id: "EG_old", host: "198.51.100.1", profile: "1080p30" };
  const monitor = snapshot();
  monitor.agents.find((entry) => entry.assignedCourts?.includes(1)).egressSupervisor = {
    ...monitor.agents.find((entry) => entry.assignedCourts?.includes(1)).egressSupervisor,
    status: "RECOVERED",
    egressId: "EG_replacement"
  };
  const calls = [];
  const adoption = await reconcileHostRecoveredEgress({
    egress: {
      reconcileOwned: async (value) => {
        calls.push(value);
        return { id: "EG_replacement", owner: { outputGeneration: "run-1" } };
      }
    },
    snapshot: monitor,
    current,
    host: "198.51.100.1",
    court: 1,
    profile: "1080p30",
    owner: { event: "event-test", destinationId: "broadcast-1", destinationRole: "primary", outputGeneration: "run-1" },
    nowMs: startedMs
  });
  assert.equal(adoption.adopted, true);
  assert.equal(adoption.oldEgressId, "EG_old");
  assert.equal(adoption.replacement.id, "EG_replacement");
  assert.equal(adoption.replacement.host, "198.51.100.1");
  assert.equal(adoption.replacement.profile, "1080p30");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedId, "EG_replacement");
});

test("does not reconcile an unchanged host-local Egress id", async () => {
  let calls = 0;
  const current = { id: "EG_Camera1", host: "198.51.100.1", profile: "1080p30" };
  const adoption = await reconcileHostRecoveredEgress({
    egress: { reconcileOwned: async () => { calls += 1; } },
    snapshot: snapshot(),
    current,
    host: "198.51.100.1",
    court: 1,
    profile: "1080p30",
    owner: { event: "event-test" },
    nowMs: startedMs
  });
  assert.equal(adoption.adopted, false);
  assert.equal(adoption.replacement, current);
  assert.equal(calls, 0);
});

test("rejects stale or unverified host-local Egress replacement telemetry", async () => {
  const monitor = snapshot();
  const supervisor = monitor.agents.find((entry) => entry.assignedCourts?.includes(1)).egressSupervisor;
  supervisor.egressId = "EG_replacement";
  supervisor.observedAt = new Date(startedMs - 30_000).toISOString();
  await assert.rejects(() => reconcileHostRecoveredEgress({
    egress: { reconcileOwned: async () => assert.fail("stale telemetry must not reach ownership reconciliation") },
    snapshot: monitor,
    current: { id: "EG_old" },
    host: "198.51.100.1",
    court: 1,
    profile: "1080p30",
    owner: { event: "event-test" },
    nowMs: startedMs
  }), /replacement Egress telemetry is not fresh and valid/u);

  supervisor.observedAt = new Date(startedMs).toISOString();
  await assert.rejects(() => reconcileHostRecoveredEgress({
    egress: { reconcileOwned: async () => { throw new Error("owner outputGeneration changed"); } },
    snapshot: monitor,
    current: { id: "EG_old" },
    host: "198.51.100.1",
    court: 1,
    profile: "1080p30",
    owner: { event: "event-test" },
    nowMs: startedMs
  }), /owner outputGeneration changed/u);
});

test("uses the adopted host-local Egress id for a later central browser recovery", async () => {
  const monitor = snapshot();
  monitor.agents.find((entry) => entry.assignedCourts?.includes(1)).egressSupervisor.egressId = "EG_replacement";
  const adoption = await reconcileHostRecoveredEgress({
    egress: { reconcileOwned: async () => ({ id: "EG_replacement" }) },
    snapshot: monitor,
    current: { id: "EG_old" },
    host: "198.51.100.1",
    court: 1,
    profile: "1080p30",
    owner: { event: "event-test" },
    nowMs: startedMs
  });
  const calls = [];
  const recovered = await recoverOwnedProgramEgress({
    egress: {
      listActive: async () => [{ id: "EG_replacement" }],
      restartOwned: async (value) => { calls.push(value); return { id: "EG_central" }; }
    },
    host: "198.51.100.1",
    court: 1,
    profile: "1080p30",
    owner: { event: "event-test" },
    oldEgressId: adoption.replacement.id
  });
  assert.equal(recovered.id, "EG_central");
  assert.equal(calls[0].egressId, "EG_replacement");
});

test("retries bounded transient monitor reads but not authentication failures", async () => {
  const current = snapshot({ active: false });
  const sleeps = [];
  let attempts = 0;
  const result = await fetchProductionMonitorSnapshot({
    monitorOrigin: "https://monitor.example.test",
    monitorToken: "token",
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return { ok: true, status: 200, async json() { return current; } };
    }
  });
  assert.equal(result, current);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [1_000]);

  let unauthorizedAttempts = 0;
  await assert.rejects(() => fetchProductionMonitorSnapshot({
    monitorOrigin: "https://monitor.example.test",
    monitorToken: "bad-token",
    sleep: async () => {},
    fetchImpl: async () => { unauthorizedAttempts += 1; return { ok: false, status: 401 }; }
  }), /HTTP 401/u);
  assert.equal(unauthorizedAttempts, 1);
});

test("reconciles a labeled-running startup observer against its actual process", async () => {
  const state = {
    runId: "run-1",
    sampler: { status: "running", pid: 100, output: "/evidence/pool-host-samples.jsonl" }
  };
  const writes = [];
  let starts = 0;
  const result = await ensureStartupObserver({
    state,
    statePath: "/evidence/state.json",
    key: "sampler",
    runtime: { inspect: async () => ({ pid: 100 }) },
    evidenceRoot: "/evidence",
    start: async () => { starts += 1; },
    now: () => startedMs,
    persist: async (_path, value) => { writes.push(structuredClone(value)); }
  });
  assert.equal(result.pid, 100);
  assert.equal(result.adopted, true);
  assert.equal(starts, 0);
  assert.equal(writes.at(-1).observerStarts.sampler.status, "running");
});

test("restarts a dead startup observer in a persisted fresh evidence generation", async () => {
  const state = {
    runId: "run-2",
    criticalLogs: { status: "running", pid: 200, output: "/evidence/critical-logs.jsonl" }
  };
  const writes = [];
  const starts = [];
  const result = await ensureStartupObserver({
    state,
    statePath: "/evidence/state.json",
    key: "criticalLogs",
    runtime: { inspect: async () => null },
    evidenceRoot: "/evidence",
    start: async (directory) => {
      starts.push(directory);
      assert.equal(writes.at(-1).observerStarts.criticalLogs.status, "starting");
      return { status: "running", pid: 201, output: `${directory}/critical-logs.jsonl` };
    },
    now: () => startedMs,
    persist: async (_path, value) => { writes.push(structuredClone(value)); }
  });
  assert.deepEqual(starts, ["/evidence/observer-generations/criticalLogs-000-run-2"]);
  assert.equal(result.pid, 201);
  assert.equal(state.observerStarts.criticalLogs.status, "running");
  assert.equal(writes.at(-1).observerStarts.criticalLogs.output, result.output);
});

test("adopts an interrupted startup attempt without creating another generation", async () => {
  const directory = "/evidence/observer-generations/sentinel-003-run-3";
  const state = {
    runId: "run-3",
    sentinel: { status: "running", pid: 300, output: "/evidence/platform-sentinel.jsonl" },
    observerStarts: {
      sentinel: { generation: 3, evidenceDirectory: directory, status: "starting", preparedAt: new Date(startedMs).toISOString() }
    }
  };
  const starts = [];
  const result = await ensureStartupObserver({
    state,
    statePath: "/evidence/state.json",
    key: "sentinel",
    runtime: { inspect: async () => { throw new Error("the stale owner must not be inspected"); } },
    evidenceRoot: "/evidence",
    start: async (value) => {
      starts.push(value);
      return { status: "running", pid: 301, output: `${value}/platform-sentinel.jsonl`, adopted: true };
    },
    now: () => startedMs,
    persist: async () => {}
  });
  assert.deepEqual(starts, [directory]);
  assert.equal(result.pid, 301);
  assert.equal(state.observerStarts.sentinel.generation, 3);
});

test("increments the startup observer generation after a failed attempt", async () => {
  const state = {
    runId: "run-4",
    sampler: { status: "running", pid: 400, output: "/evidence/pool-host-samples.jsonl" },
    observerStarts: {
      sampler: { generation: 2, evidenceDirectory: "/evidence/observer-generations/sampler-002-run-4", status: "failed" }
    }
  };
  const result = await ensureStartupObserver({
    state,
    statePath: "/evidence/state.json",
    key: "sampler",
    runtime: { inspect: async () => null },
    evidenceRoot: "/evidence",
    start: async (directory) => ({ status: "running", pid: 401, output: `${directory}/pool-host-samples.jsonl` }),
    now: () => startedMs,
    persist: async () => {}
  });
  assert.match(result.output, /sampler-003-run-4/u);
  assert.equal(state.observerStarts.sampler.generation, 3);
});

test("refuses formal admission when a startup observer has exited", async () => {
  const state = {
    sampler: { output: "/evidence/pool-host-samples.jsonl" },
    sentinel: { output: "/evidence/platform-sentinel.jsonl" },
    criticalLogs: { output: "/evidence/critical-logs.jsonl" }
  };
  const running = { inspect: async () => ({ pid: 100 }) };
  await assert.rejects(() => assertStartupObserversRunning({
    state,
    sampler: { inspect: async () => null },
    sentinel: running,
    criticalLogs: running
  }), /pool host sampler is not running/u);
});

test("accepts an idle twelve-host baseline with all cameras off", () => {
  assert.deepEqual(productionIdleProblems(snapshot({ active: false }), venue, startedMs), []);
});

test("allows auto-publishing raw cameras while keeping every output branch idle", () => {
  const current = snapshot({ active: false });
  for (const camera of venue.activeCameras) current.courts[camera - 1].paths.raw = path("raw", 1, 3_000_000);
  assert.deepEqual(productionIdleProblems(current, venue, startedMs), []);

  current.courts[0].paths.preview = path("preview", 1);
  current.courts[1].paths.raw.readerCount = 2;
  const problems = productionIdleProblems(current, venue, startedMs);
  assert.ok(problems.includes("Camera 1 preview is occupied before the soak starts"));
  assert.ok(problems.includes("Camera 2 raw path has an unexpected pre-soak reader"));
});

test("requires healthy commissioned UniFi access points without making uncommissioned rehearsals depend on them", () => {
  const current = snapshot({ active: false });
  current.unifi = { required: true, state: "DEGRADED" };
  assert.ok(productionIdleProblems(current, venue, startedMs).includes("venue Wi-Fi access points are not healthy in UniFi"));
  current.unifi.required = false;
  assert.deepEqual(productionIdleProblems(current, venue, startedMs), []);
});

test("does not mistake an expired browser heartbeat for an active idle-baseline reader", () => {
  const idle = snapshot({ active: false, sampledMs: startedMs });
  idle.courts[0].browser = browser(1, startedMs - 60_000, 0);
  assert.deepEqual(productionIdleProblems(idle, venue, startedMs), []);
  idle.courts[0].browser.receivedAt = new Date(startedMs).toISOString();
  assert.ok(productionIdleProblems(idle, venue, startedMs).includes("Camera 1 has a browser before the soak starts"));
});

test("accepts six native 1080 camera chains and two isolated inactive cameras", () => {
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  assert.deepEqual(productionRawProblems(after, venue, startedMs + 5_000), []);
  assert.deepEqual(productionSnapshotProblems(after, profiles, venue, before, startedMs + 5_000), []);
  assert.deepEqual(browserDeltaProblems(before, after, profiles, venue.activeCameras), []);
});

test("accepts a retired on-demand preview but validates one while occupied", () => {
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  delete before.courts[0].paths.preview;
  delete before.courts[0].ffmpeg.preview;
  delete after.courts[0].paths.preview;
  delete after.courts[0].ffmpeg.preview;
  assert.deepEqual(productionSnapshotProblems(after, profiles, venue, before, startedMs + 5_000), []);

  after.courts[0].paths.preview = path("preview", 3);
  after.courts[0].ffmpeg.preview = ffmpeg(20, 1);
  const problems = productionSnapshotProblems(after, profiles, venue, before, startedMs + 5_000);
  assert.ok(problems.includes("Camera 1 preview path is not healthy with 1-2 reader(s)"));
  assert.ok(problems.includes("Camera 1 preview processing is outside 60fps, zero-drop bounds"));
});

test("requires exactly one authenticated program HLS proxy session", () => {
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  after.courts[0].paths.program.readerCount = 2;
  assert.ok(productionSnapshotProblems(after, profiles, venue, before, startedMs + 5_000)
    .some((entry) => entry.includes("Camera 1 program path is not healthy with 1 reader(s)")));
});

test("allows bounded audio and mux overhead above a constrained camera encoder cap", () => {
  const constrainedProfile = structuredClone(venueProfile);
  constrainedProfile.cameras[2].sourceProfile = "CONSTRAINED_1080P30";
  constrainedProfile.cameras[2].sourceRateCapMbps = 3;
  const constrainedVenue = { ...evaluateVenueAdmission(constrainedProfile), sha256: "d".repeat(64) };
  const current = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  current.courts[2].paths.raw.inboundBitrateBps = 3_225_000;
  assert.deepEqual(productionRawProblems(current, constrainedVenue, startedMs + 5_000), []);
  current.courts[2].paths.raw.inboundBitrateBps = 0;
  assert.ok(productionRawProblems(current, constrainedVenue, startedMs + 5_000).some((entry) => entry.includes("Camera 3 raw bitrate is not positive")));
});

test("treats camera bitrate as VBR and fails only sustained excess or an extreme spike", () => {
  const constrainedProfile = structuredClone(venueProfile);
  constrainedProfile.cameras[2].sourceProfile = "CONSTRAINED_1080P30";
  constrainedProfile.cameras[2].sourceRateCapMbps = 3;
  const constrainedVenue = { ...evaluateVenueAdmission(constrainedProfile), sha256: "c".repeat(64) };
  const current = snapshot({ sampledMs: startedMs, framesMultiplier: 5 });
  let windows = {};
  for (let seconds = 0; seconds <= 60; seconds += 5) {
    current.courts[2].paths.raw.inboundBitrateBps = seconds === 25 ? 4_000_000 : seconds === 40 ? 1_000_000 : 3_225_000;
    const step = sourceBitrateWindowStep(windows, current, constrainedVenue, startedMs + seconds * 1_000);
    windows = step.windows;
    assert.deepEqual(step.problems, []);
  }

  windows = {};
  for (let seconds = 0; seconds <= 60; seconds += 5) {
    current.courts[2].paths.raw.inboundBitrateBps = 3_600_000;
    const step = sourceBitrateWindowStep(windows, current, constrainedVenue, startedMs + seconds * 1_000);
    windows = step.windows;
    if (seconds < 60) assert.deepEqual(step.problems, []);
    else assert.ok(step.problems.some((entry) => entry.includes("averaged 3600000 bps")));
  }

  current.courts[2].paths.raw.inboundBitrateBps = 5_250_001;
  const extreme = sourceBitrateWindowStep({}, current, constrainedVenue, startedMs);
  assert.ok(extreme.problems.some((entry) => entry.includes("extreme spike")));
});

test("requires an isolated compositor normalizer for an admitted browser-unsafe camera", () => {
  const hevcProfile = structuredClone(venueProfile);
  hevcProfile.cameras[2].sourcePathMode = "isolated-browser-normalizer";
  hevcProfile.cameras[2].sourceCodec = "H265";
  const hevcVenue = { ...evaluateVenueAdmission(hevcProfile), sha256: "e".repeat(64) };
  const hevcProfiles = structuredClone(profiles);
  hevcProfiles[3].sourcePathMode = "isolated-browser-normalizer";
  hevcProfiles[3].source.codec = "H265";
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  for (const value of [before, after]) {
    const court = value.courts[2];
    court.paths.raw.videoCodec = "H265";
    court.paths.normalized = {
      ...path("normalized", 1),
      audioCodec: "AAC"
    };
    court.ffmpeg.normalizer = ffmpeg(30, 1);
  }
  assert.deepEqual(productionSnapshotProblems(after, hevcProfiles, hevcVenue, before, startedMs + 5_000), []);

  delete after.courts[2].paths.normalized;
  assert.ok(productionSnapshotProblems(after, hevcProfiles, hevcVenue, before, startedMs + 5_000).some((entry) => entry.includes("normalized browser path")));
  after.courts[2].paths.normalized = { ...path("normalized", 1), audioCodec: "AAC" };
  after.courts[0].paths.normalized = { ...path("normalized", 1), audioCodec: "AAC" };
  assert.ok(productionSnapshotProblems(after, hevcProfiles, hevcVenue, before, startedMs + 5_000).some((entry) => entry.includes("Camera 1 direct-H264")));
});

test("detects source, overlay, browser continuity, and inactive-camera contamination", () => {
  const before = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const after = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  after.courts[0].paths.raw.videoHeight = 720;
  after.courts[0].browser.scoreRender.stale = true;
  after.courts[1].browser.video.framesDropped = 1;
  after.courts[6].paths.raw = path("raw", 1);
  const problems = productionSnapshotProblems(after, profiles, venue, before, startedMs + 5_000);
  assert.ok(problems.some((entry) => entry.includes("Camera 1 raw video does not match")));
  assert.ok(problems.some((entry) => entry.includes("Camera 1 scoreboard overlay")));
  assert.ok(problems.some((entry) => entry.includes("Camera 2 browser framesDropped changed")));
  assert.ok(problems.some((entry) => entry.includes("Camera 7 raw is unexpectedly active")));
});

test("requires six healthy variable-profile live YouTube broadcasts", () => {
  const provider = providerEvidence();
  assert.deepEqual(productionProviderProblems(provider, venue.activeCameras), []);
  provider.cameras[2].stream.configurationIssues.push("bitrateHigh");
  assert.deepEqual(productionProviderProblems(provider, venue.activeCameras), []);
  provider.cameras[2].stream.healthStatus = "ok";
  provider.cameras[4].broadcast.lifeCycleStatus = "ready";
  const problems = productionProviderProblems(provider, venue.activeCameras);
  assert.ok(problems.includes("Camera 3 YouTube ingest is not active and healthy"));
  assert.ok(problems.includes("Camera 5 YouTube broadcast is not live, recording, unlisted, and correctly bound"));
});

test("keeps persistent outputs admitted while a camera renderer shows its interruption slate", () => {
  const monitored = snapshot({ active: true });
  monitored.courts[0].paths = {};
  monitored.courts[0].ffmpeg = {};
  monitored.courts[0].browser.video.state = "waiting";
  monitored.courts[0].browser.video.connectionState = "disconnected";
  assert.deepEqual(persistentOutputProblems(monitored, providerEvidence(), venue, startedMs), []);
});

test("requires six idle variable-profile destinations before arming", () => {
  const provider = providerEvidence({ active: false });
  assert.deepEqual(productionProviderIdleProblems(provider, venue.activeCameras), []);
  provider.cameras[0].stream.streamStatus = "active";
  provider.cameras[1].broadcast.lifeCycleStatus = "live";
  assert.ok(productionProviderIdleProblems(provider, venue.activeCameras).includes("Camera 1 YouTube ingest is not idle"));
  assert.ok(productionProviderIdleProblems(provider, venue.activeCameras).includes("Camera 2 YouTube broadcast is not ready, unlisted, and correctly bound"));
});

test("qualifies reset-safe aggregate cadence and fails on any sample defect", () => {
  const first = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const last = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  const state = {
    event: "six-camera-soak",
    runId: "run-12345678",
    startedAt: new Date(startedMs).toISOString(),
    maximumGapMs: 5_000,
    profiles,
    activeCameras: venue.activeCameras,
    runBinding,
    venueAdmission: venue,
    outputConformance: outputConformanceEvidence(),
    egress: {},
    notifications: []
  };
  const samples = [
    { runId: state.runId, slot: 0, monitor: first, problems: [] },
    { runId: state.runId, slot: 1, monitor: last, problems: [] }
  ];
  const pass = evaluateProductionSoak({ state, samples, hostEvidence: { passed: true, problems: [] }, routerEvidence: { passed: true, problems: [] }, sentinelEvidence: { passed: true, problems: [] }, criticalLogEvidence: { passed: true, problems: [] }, endedMs: startedMs + 5_000, minimumDurationMs: 5_000, maximumDurationMs: 10_000 });
  assert.equal(pass.classification, "PASS");
  samples[1].problems.push("Camera 1 YouTube ingest is not active and healthy");
  const fail = evaluateProductionSoak({ state, samples, hostEvidence: { passed: true, problems: [] }, routerEvidence: { passed: true, problems: [] }, sentinelEvidence: { passed: true, problems: [] }, criticalLogEvidence: { passed: true, problems: [] }, endedMs: startedMs + 5_000, minimumDurationMs: 5_000, maximumDurationMs: 10_000 });
  assert.equal(fail.classification, "FAIL");
  samples[1].problems.length = 0;
  const missingSentinel = evaluateProductionSoak({ state, samples, hostEvidence: { passed: true, problems: [] }, routerEvidence: { passed: true, problems: [] }, criticalLogEvidence: { passed: true, problems: [] }, endedMs: startedMs + 5_000, minimumDurationMs: 5_000, maximumDurationMs: 10_000 });
  assert.ok(missingSentinel.problems.includes("external platform sentinel evidence is missing"));
});

test("fails qualification when an operator notification could not be delivered", () => {
  const first = snapshot({ sampledMs: startedMs, framesMultiplier: 0 });
  const last = snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 });
  const state = {
    event: "six-camera-soak",
    runId: "run-12345678",
    startedAt: new Date(startedMs).toISOString(),
    maximumGapMs: 5_000,
    profiles,
    activeCameras: venue.activeCameras,
    runBinding,
    venueAdmission: venue,
    outputConformance: outputConformanceEvidence(),
    egress: {},
    notifications: [{ kind: "FAILURE", title: "ScoreCheck needs attention" }]
  };
  const samples = [
    { runId: state.runId, slot: 0, monitor: first, problems: [] },
    { runId: state.runId, slot: 1, monitor: last, problems: [] }
  ];

  const report = evaluateProductionSoak({ state, samples, hostEvidence: { passed: true, problems: [] }, routerEvidence: { passed: true, problems: [] }, sentinelEvidence: { passed: true, problems: [] }, criticalLogEvidence: { passed: true, problems: [] }, endedMs: startedMs + 5_000, minimumDurationMs: 5_000, maximumDurationMs: 10_000 });

  assert.equal(report.classification, "FAIL");
  assert.ok(report.problems.includes("one or more Pushover notifications failed"));
});

test("records bounded HLS runtime evidence and rejects buffer or instance fan-out", () => {
  const samples = [
    { monitor: snapshot({ sampledMs: startedMs, framesMultiplier: 0 }) },
    { monitor: snapshot({ sampledMs: startedMs + 5_000, framesMultiplier: 5 }) }
  ];
  const accepted = evaluateHlsRuntimeEvidence(samples, venue.activeCameras);
  assert.equal(accepted.passed, true);
  assert.equal(accepted.cameras[0].maximumBufferedAheadMs, 12_000);
  assert.equal(accepted.cameras[0].minimumPlayoutDelayMs, 12_000);
  assert.equal(accepted.cameras[0].maximumPlayoutDelayMs, 12_000);
  assert.ok(Number.isFinite(accepted.cameras[0].retainedHeapGrowthBytes));
  assert.ok(Number.isFinite(accepted.cameras[0].retainedEgressCgroupGrowthBytes));
  assert.equal(accepted.cameras[0].peakEgressCgroupMemoryBytes, 2_000_000_000);

  const transient = [samples[0], structuredClone(samples[1]), structuredClone(samples[1])];
  transient[1].monitor.agents.find((agent) => agent.assignedCourts?.includes(1)).nativeServices.egress.cgroupMemoryBytes = 3_000_000_000;
  const transientAccepted = evaluateHlsRuntimeEvidence(transient, venue.activeCameras);
  assert.equal(transientAccepted.passed, true);
  assert.equal(transientAccepted.cameras[0].peakEgressCgroupMemoryBytes, 3_000_000_000);
  assert.equal(transientAccepted.cameras[0].retainedEgressCgroupGrowthBytes, 0);

  const broken = structuredClone(samples);
  const video = broken[1].monitor.courts[0].browser.video;
  video.bufferedAheadMs = 30_000;
  video.hlsCreatedInstances = 2;
  video.hlsActiveInstances = 2;
  const rejected = evaluateHlsRuntimeEvidence(broken, venue.activeCameras);
  assert.equal(rejected.passed, false);
  assert.ok(rejected.problems.some((problem) => problem.includes("Camera 1 HLS runtime evidence exceeded")));
  assert.ok(rejected.problems.some((problem) => problem.includes("Camera 1 HLS instance generation changed")));

  const growing = structuredClone(samples);
  growing[1].monitor.agents.find((agent) => agent.assignedCourts?.includes(1)).nativeServices.egress.cgroupMemoryBytes = 3_000_000_000;
  const growthRejected = evaluateHlsRuntimeEvidence(growing, venue.activeCameras);
  assert.equal(growthRejected.passed, false);
  assert.ok(growthRejected.problems.some((problem) => problem.includes("Camera 1 HLS Egress cgroup retained")));

  const missing = structuredClone(samples);
  missing[1].monitor.agents.find((agent) => agent.assignedCourts?.includes(1)).nativeServices.egress.cgroupMemoryBytes = null;
  const missingRejected = evaluateHlsRuntimeEvidence(missing, venue.activeCameras);
  assert.equal(missingRejected.passed, false);
  assert.ok(missingRejected.problems.some((problem) => problem.includes("Camera 1 HLS Egress memory evidence")));

  const latency = structuredClone(samples);
  latency[1].monitor.courts[0].browser.video.playoutDelayMs = 30_000;
  const latencyRejected = evaluateHlsRuntimeEvidence(latency, venue.activeCameras);
  assert.equal(latencyRejected.passed, false);
  assert.ok(latencyRejected.problems.some((problem) => problem.includes("Camera 1 HLS runtime evidence exceeded")));
});

test("qualifies continuous fail-closed Speedify evidence and rejects route drift", () => {
  const good = evaluateSpeedifyEvidence({ content: routerEvidence(), startMs: startedMs, endMs: startedMs + 5_000, activeCameras: 6, intervalMs: 1_000 });
  assert.equal(good.passed, true);
  assert.equal(good.observedRows, 6);
  assert.ok(good.connectifyTxBitrateBps.average > 0);

  const drift = routerEvidence().replace("CONNECTED\tconnectify0\tconnectify0\t2\t2\tactive\t6", "CONNECTED\teth0\tconnectify0\t2\t2\tinactive\t5");
  const failed = evaluateSpeedifyEvidence({ content: drift, startMs: startedMs, endMs: startedMs + 5_000, activeCameras: 6, intervalMs: 1_000 });
  assert.equal(failed.passed, false);
  assert.ok(failed.problems.includes("camera ingest routes did not remain on Speedify"));
  assert.ok(failed.problems.includes("camera fail-closed kill switch was not continuously active"));
  assert.ok(failed.problems.includes("fewer than 6 camera flows reached the ingest endpoint"));
});

test("qualifies fresh Peplink SpeedFusion monitor evidence and rejects failed tunnel members", () => {
  const first = peplinkRouter(startedMs, 43_200);
  const second = peplinkRouter(startedMs + 30_000, 43_230);
  assert.deepEqual(productionPeplinkRouterProblems(first, { nowMs: startedMs, activeCameras: 7, minimumUploadMbps: 32 }), []);

  const accepted = evaluatePeplinkRouterEvidence({
    samples: [
      { observedAt: new Date(startedMs).toISOString(), monitor: { router: first } },
      { observedAt: new Date(startedMs + 30_000).toISOString(), monitor: { router: second } }
    ],
    startMs: startedMs,
    endMs: startedMs + 30_000,
    activeCameras: 7,
    minimumUploadMbps: 32
  });
  assert.equal(accepted.passed, true);
  assert.equal(accepted.source, "peplink-monitor");
  assert.equal(accepted.observedRows, 2);
  assert.equal(accepted.maximumCpuUtilizationPct, 20);

  const failedLink = structuredClone(second);
  failedLink.speedFusion.links[1].state = "REMOTE_FAILURE";
  const linkProblems = productionPeplinkRouterProblems(failedLink, { nowMs: startedMs + 30_000, activeCameras: 7, minimumUploadMbps: 32 });
  assert.ok(linkProblems.includes("Peplink SpeedFusion link Cellular is not active"));

  const restarted = peplinkRouter(startedMs + 30_000, 5);
  const rejected = evaluatePeplinkRouterEvidence({
    samples: [
      { observedAt: new Date(startedMs).toISOString(), monitor: { router: first } },
      { observedAt: new Date(startedMs + 30_000).toISOString(), monitor: { router: restarted } }
    ],
    startMs: startedMs,
    endMs: startedMs + 30_000,
    activeCameras: 7,
    minimumUploadMbps: 32
  });
  assert.equal(rejected.passed, false);
  assert.ok(rejected.problems.includes("Peplink router restarted during the soak"));
});

test("requires each selected output profile to be bound to encoder, renderer, and YouTube evidence", () => {
  const evidence = outputConformanceEvidence();
  assert.deepEqual(outputConformanceProblems(evidence, profiles, venue.activeCameras, runBinding), []);
  delete evidence[3];
  evidence[4].destination.broadcastId = null;
  evidence[5].renderer.gitSha = "old";
  const problems = outputConformanceProblems(evidence, profiles, venue.activeCameras, runBinding);
  assert.ok(problems.includes("Camera 3 encoded output is not qualified for 1080p30"));
  assert.ok(problems.includes("Camera 4 output qualification is not bound to its YouTube destination"));
  assert.ok(problems.includes("Camera 5 output qualification is not bound to its renderer"));

  const staleBinding = structuredClone(runBinding);
  staleBinding.destinations[1].broadcastId = "another-broadcast";
  staleBinding.renderer.gitSha = "b".repeat(40);
  const staleProblems = outputConformanceProblems(outputConformanceEvidence(), profiles, venue.activeCameras, staleBinding);
  assert.ok(staleProblems.includes("Camera 1 output qualification is not bound to its YouTube destination"));
  assert.ok(staleProblems.includes("Camera 1 output qualification is not bound to its renderer"));
});

test("requires at least one successful external viewer playback observation per active camera", () => {
  const evidence = venue.activeCameras.map((camera) => ({ camera, broadcastId: `broadcast-${camera}`, observedAt: new Date(startedMs).toISOString(), passed: true }));
  const outputConformance = outputConformanceEvidence();
  assert.deepEqual(viewerEvidenceProblems(evidence, venue.activeCameras, outputConformance), []);
  evidence[2].passed = false;
  evidence[3].broadcastId = "another_broadcast";
  evidence.pop();
  const problems = viewerEvidenceProblems(evidence, venue.activeCameras, outputConformance);
  assert.ok(problems.includes("Camera 3 has a failed external viewer playback observation"));
  assert.ok(problems.includes("Camera 4 external viewer evidence does not match its qualified broadcast"));
  assert.ok(problems.includes("Camera 6 has no external viewer playback evidence"));
});

test("arms only when Speedify and every fail-closed router control are active", () => {
  const healthy = `Enabled: yes
Speedify state: CONNECTED
Ingest IP: 138.197.236.201
Runtime status: CONNECTED_ROUTED
Policy rules:
700: from all to 138.197.236.201 ipproto udp dport 8890 lookup 900
701: from all to 138.197.236.201 ipproto tcp dport 1935 lookup 900
710: from all to 138.197.236.201 ipproto udp dport 8890 lookup 901
711: from all to 138.197.236.201 ipproto tcp dport 1935 lookup 901
Primary route table 900:
default dev connectify0 scope link src 10.202.0.2
Guard route table 901:
blackhole default
Firewall kill switch: active
Validated state:
validated_upload_mbps=31
minimum_upload_mbps=31
ingest_ip=138.197.236.201
Watchdog lock owner: 19180
`;
  assert.deepEqual(productionRouterPreflightProblems(healthy, 31), []);

  const disconnected = healthy
    .replace("Speedify state: CONNECTED", "Speedify state: AUTO_CONNECTING")
    .replace("Runtime status: CONNECTED_ROUTED", "Runtime status: SPEEDIFY_UNAVAILABLE_BLOCKED")
    .replace(/700:.*\n701:.*\n710:.*\n711:.*\n/, "none\n")
    .replace("default dev connectify0 scope link src 10.202.0.2", "")
    .replace("Watchdog lock owner: 19180", "Watchdog lock owner: none");
  const problems = productionRouterPreflightProblems(disconnected, 31);
  assert.ok(problems.includes("Speedify is not connected"));
  assert.ok(problems.includes("camera traffic is not routed through Speedify"));
  assert.ok(problems.includes("the two primary camera routing rules are not exact"));
  assert.ok(problems.includes("the primary camera route is not on Speedify"));
  assert.ok(problems.includes("the fail-closed routing watchdog is not active"));
});

function snapshot({ active = true, sampledMs = startedMs, framesMultiplier = 0 } = {}) {
  const fixed = ["commentary", "observability", "ingest"].map((role) => agent(`bvm-${role}`, role, null, false, sampledMs));
  const compositors = Array.from({ length: 8 }, (_, index) => agent(`bvm-compositor-${index + 1}`, "compositor", index + 1, active && index < 6, sampledMs));
  const spare = agent("bvm-compositor-spare", "worker", null, false, sampledMs);
  return {
    version: 6,
    generatedAt: new Date(sampledMs).toISOString(),
    collector: { state: "HEALTHY", agentsExpected: 12, agentsFresh: 12 },
    notifications: { pushover: { configured: true } },
    incidents: [],
    faultGates: [],
    agents: [...fixed, ...compositors, spare],
    courts: Array.from({ length: 8 }, (_, index) => {
      const camera = index + 1;
      const running = active && camera <= 6;
      const fps = profiles[camera]?.framesPerSecond ?? 30;
      return {
        courtNumber: camera,
        paths: running ? { raw: path("raw", 2, camera <= 2 ? 8_000_000 : 5_000_000), preview: path("preview", 1), program: path("program", 1) } : {},
        ffmpeg: running ? { preview: ffmpeg(fps, null), program: ffmpeg(fps, 1) } : {},
        browser: running ? browser(camera, sampledMs, framesMultiplier * fps) : null
      };
    })
  };
}

function peplinkRouter(sampledMs, uptimeSeconds) {
  return {
    state: "HEALTHY",
    required: true,
    configured: true,
    apiReachable: true,
    sampledAt: new Date(sampledMs).toISOString(),
    lastSuccessAt: new Date(sampledMs).toISOString(),
    lastFailureAt: null,
    identity: {
      name: "scorecheck-event-router",
      productName: "Peplink MAX BR1 Pro 5G",
      productCode: "MAX-BR1-PRO-5GK-T-PRM",
      hardwareVersion: "3",
      firmwareVersion: "8.6.0 build 6450",
      online: true,
      uptimeSeconds
    },
    resources: { cpuUtilizationPct: 20, memoryUtilizationPct: 30 },
    speedFusion: {
      profileName: "SFC-SFO",
      connected: true,
      profileStatus: "CONNECTED",
      peerStatus: "CONNECTED",
      transport: "UDP",
      rateLimitMbps: 200,
      quotaMb: 1_000_000,
      usageMb: 100_000,
      suspended: false,
      linksAvailable: true,
      links: [
        { name: "WAN", state: "ACTIVE", transmitBitrateBps: 12_000_000, transmitPacketLossPct: 0 },
        { name: "Cellular", state: "ACTIVE", transmitBitrateBps: 9_000_000, transmitPacketLossPct: 0 }
      ]
    },
    clients: { cameraWlanConnected: 7 },
    wans: [
      { id: "1", name: "WAN", required: true, enabled: true, connected: true },
      { id: "2", name: "Cellular", required: true, enabled: true, connected: true }
    ],
    problems: []
  };
}

function path(branch, readerCount, inboundBitrateBps = 5_000_000) {
  return {
    branch,
    ready: true,
    readerCount,
    inboundBitrateBps,
    frameErrors: 0,
    videoCodec: "H264",
    videoWidth: 1920,
    videoHeight: 1080,
    audioCodec: "AAC",
    audioSampleRateHz: 48_000,
    audioChannelCount: 2
  };
}

function ffmpeg(framesPerSecond, speedRatio) {
  return { framesPerSecond, droppedFrames: 0, duplicatedFrames: 0, speedRatio };
}

function browser(camera, sampledMs, framesRendered) {
  return {
    heartbeatSeq: Math.floor((sampledMs - startedMs) / 1_000) + 1,
    receivedAt: new Date(sampledMs).toISOString(),
    pageLoadedAt: "2026-07-21T11:59:00Z",
    pageBuildVersion: "build-1080",
    video: {
      state: "playing",
      connectionState: "connected",
      transport: "hls",
      networkPath: "unknown",
      playoutDelayMs: 12_000,
      width: 1920,
      height: 1080,
      framesRendered,
      framesDropped: 0,
      freezeCount: 0,
      totalFreezesDurationMs: 0,
      packetsLost: 0,
      bufferedAheadMs: 12_000,
      bufferedRangeCount: 1,
      hlsCreatedInstances: 1,
      hlsDestroyedInstances: 0,
      hlsActiveInstances: 1,
      jsHeapUsedBytes: 64_000_000 + framesRendered,
      reconnectCount: 0,
      reloadCount: 0
    },
    commentary: { cameraTrackPresent: true },
    scoreRender: { loaded: true, connected: true, stale: false, frozen: false, domMismatchReason: null, camera }
  };
}

function agent(agentId, role, assignedCourt = null, outputActive = false, sampledMs = startedMs) {
  return {
    agentId,
    role,
    assignedCourts: assignedCourt === null ? [] : [assignedCourt],
    state: "HEALTHY",
    host: { memoryTotalBytes: 8_000_000_000, memoryAvailableBytes: 6_000_000_000, diskTotalBytes: 100_000_000_000, diskFreeBytes: 80_000_000_000 },
    services: [],
    egressSupervisor: ["compositor", "worker"].includes(role) ? {
      schemaVersion: 1,
      generationKey: outputActive ? "a".repeat(64) : null,
      missingCount: 0,
      recoveryAttempts: 0,
      status: outputActive ? "HEALTHY" : "IDLE",
      detail: outputActive ? "The exact owned Egress is active." : "No owned or active Egress exists.",
      court: outputActive ? assignedCourt : null,
      egressId: outputActive ? `EG_Camera${assignedCourt}` : null,
      observedAt: new Date(sampledMs).toISOString()
    } : null,
    nativeServices: ["compositor", "worker"].includes(role) ? {
      egress: {
        idle: !outputActive,
        activeWebRequests: outputActive ? 1 : 0,
        maximumWebRequests: 1,
        canAcceptRequest: !outputActive,
        cgroupMemoryBytes: outputActive ? 2_000_000_000 : 100_000_000,
        cpuLoadRatio: outputActive ? 0.35 : 0.02,
        memoryLoadRatio: outputActive ? 0.25 : 0.02
      }
    } : null
  };
}

function providerEvidence({ active = true } = {}) {
  return {
    observedAt: new Date(startedMs).toISOString(),
    cameras: Array.from({ length: 6 }, (_, index) => {
      const camera = index + 1;
      const id = `stream-${camera}`;
      return {
        camera,
        stream: { id, court: camera, resolution: "variable", frameRate: "variable", streamStatus: active ? "active" : "inactive", healthStatus: active ? "good" : null, configurationIssues: [] },
        broadcast: { court: camera, privacyStatus: "unlisted", lifeCycleStatus: active ? "live" : "ready", recordingStatus: active ? "recording" : "notRecording", streamId: id }
      };
    })
  };
}

function outputConformanceEvidence() {
  return Object.fromEntries(Array.from({ length: 6 }, (_, index) => {
    const camera = index + 1;
    return [camera, {
      status: "QUALIFIED",
      court: camera,
      profile: profiles[camera].profile,
      renderer: { gitSha: "a".repeat(40), deploymentId: "dpl_renderer123" },
      sample: { sha256: String(camera).repeat(64), durationSeconds: 20 },
      destination: { streamId: `stream-${camera}`, broadcastId: `broadcast-${camera}` }
    }];
  }));
}

function routerEvidence() {
  const header = "timestamp\tspeedify_state\tsrt_route_dev\trtmp_route_dev\tprimary_rule_count\tguard_rule_count\tkill_switch\tcamera_flow_count\tconnectify_rx_bytes\tconnectify_tx_bytes\teth0_rx_bytes\teth0_tx_bytes\trmnet_rx_bytes\trmnet_tx_bytes\twireguard_handshake_age_seconds\tload1\tmem_available_kb\tspeedify_rss_kb\tstreaming_stats_process_count";
  const rows = Array.from({ length: 6 }, (_, index) => {
    const counter = 1_000_000 + index * 1_000_000;
    return [new Date(startedMs + index * 1_000).toISOString(), "CONNECTED", "connectify0", "connectify0", 2, 2, "active", 6, counter, counter, counter, counter, counter, counter, -1, 0.5, 170_000, 47_000, 0].join("\t");
  });
  return `${header}\n${rows.join("\n")}\n`;
}
