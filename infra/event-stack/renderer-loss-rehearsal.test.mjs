import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RendererLossFaultRuntime, injectCommand, inspectCommand, restoreCommand, validateTarget } from "./renderer-loss-fault-runtime.mjs";
import { evaluateRendererLossRehearsal, rendererLossSnapshotProblems } from "./renderer-loss-evidence.mjs";
import { parseArgs, restoreInterruptedRendererLoss, runRendererLossRehearsal } from "./renderer-loss-rehearsal.mjs";
import { createSyntheticRehearsalVenueProfile, evaluateVenueAdmission } from "./venue-admission.mjs";

const startedMs = Date.parse("2026-07-22T12:00:00Z");
const renderer = {
  schemaVersion: 1,
  provider: "vercel",
  origin: "https://scorecheck-abc123-team.vercel.app",
  deploymentId: "dpl_renderer123",
  gitSha: "a".repeat(40),
  assetNamespace: "dpl_renderer123",
  contracts: {
    programSession: "program-session-v1",
    overlayState: "overlay-state-v1",
    commentary: "commentary-v1",
    browserHeartbeat: "browser-heartbeat-v5"
  }
};
const venueProfile = createSyntheticRehearsalVenueProfile("renderer-loss-event");
venueProfile.uploadMeasurement.sustainedUploadMbps = 100;
const venue = { ...evaluateVenueAdmission(venueProfile), sha256: "f".repeat(64) };
const egressOwner = { egressId: "EG_renderer123", destinationId: "broadcast-1", outputGeneration: "run-12345678" };
const profiles = Object.fromEntries(venue.activeCameras.map((camera) => [camera, {
  profile: "1080p30",
  width: 1920,
  height: 1080,
  framesPerSecond: 30,
  videoBitrateKbps: 10_000,
  sourcePathMode: "direct-h264",
  source: { codec: "H264", frameRateMode: "30/1" },
  browserInput: { codec: "H264", hasBFrames: 0, pixelFormat: "yuv420p" }
}]));

test("renderer-loss fault owns one exact destination-scoped chain and restores it", async () => {
  let status = "HEALTHY";
  const commands = [];
  const runner = async (_command, args) => {
    const remote = args.at(-1);
    commands.push(remote);
    if (remote.includes("scorecheck_renderer_loss_inject=1")) status = "FAULTED";
    if (remote.includes("scorecheck_renderer_loss_restore=1")) status = "HEALTHY";
    return { stdout: remote.includes("scorecheck_renderer_loss_inspect=1") ? `${status}\n` : "", stderr: "" };
  };
  const runtime = new RendererLossFaultRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    runner,
    resolver: async () => ["203.0.113.20", "203.0.113.10", "203.0.113.20"]
  });
  const target = await runtime.plan({ host: "198.51.100.10", event: "renderer-loss-event", camera: 1, gateId: "renderer-loss-12345678", renderer, egressOwner });
  assert.deepEqual(target.destinations, ["203.0.113.10", "203.0.113.20"]);
  assert.equal((await runtime.inject({ target, confirmation: "FAULT-RENDERER:renderer-loss-event:CAMERA-1" })).status, "FAULTED");
  assert.equal((await runtime.restore({ target, confirmation: "RESTORE-RENDERER:renderer-loss-event:CAMERA-1" })).status, "HEALTHY");
  const injected = commands.find((command) => command.includes("scorecheck_renderer_loss_inject=1"));
  assert.match(injected, /iptables -I DOCKER-USER 1 -s "\$container_ip\/32"/u);
  assert.match(injected, /-d "\$destination\/32" -p tcp --dport 443/u);
  assert.match(injected, /-d "\$destination\/32" -p udp --dport 443/u);
  assert.doesNotMatch(injected, /iptables -[AI] (?:OUTPUT|FORWARD)/u);
  assert.doesNotMatch(injected, /docker (?:stop|restart)|systemctl|reboot/u);
  assert.ok(commands.some((command) => command.includes("iptables -X \"$chain\"")));
  await assert.rejects(() => runtime.inject({ target, confirmation: "yes" }), /confirmation must be exactly/u);
});

test("renderer-loss fault resumes its exact partial state and fails closed on container drift", async () => {
  let status = "PARTIAL";
  const runtime = new RendererLossFaultRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    resolver: async () => ["203.0.113.10"],
    runner: async (_command, args) => {
      const remote = args.at(-1);
      if (remote.includes("scorecheck_renderer_loss_inject=1")) status = "FAULTED";
      return { stdout: remote.includes("scorecheck_renderer_loss_inspect=1") ? `${status}\n` : "", stderr: "" };
    }
  });
  const target = await runtime.plan({ host: "198.51.100.10", event: "renderer-loss-event", camera: 1, gateId: "renderer-loss-12345678", renderer, egressOwner });
  assert.equal((await runtime.inject({ target, confirmation: "FAULT-RENDERER:renderer-loss-event:CAMERA-1" })).status, "FAULTED");
  status = "CONTAINER_DRIFT";
  await assert.rejects(() => runtime.inject({ target, confirmation: "FAULT-RENDERER:renderer-loss-event:CAMERA-1" }), /cannot be faulted from CONTAINER_DRIFT/u);
});

test("renderer-loss target and commands reject broad or ambiguous identity", async () => {
  const runtime = new RendererLossFaultRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known_hosts", resolver: async () => ["203.0.113.10"] });
  const target = await runtime.plan({ host: "198.51.100.10", event: "renderer-loss-event", camera: 1, gateId: "renderer-loss-12345678", renderer, egressOwner });
  assert.equal(validateTarget(target).camera, 1);
  assert.match(inspectCommand(target), /GlobalIPv6Address/u);
  assert.match(inspectCommand(target), /rendererDeploymentId/u);
  assert.match(injectCommand(target), /rendererGitSha/u);
  assert.match(restoreCommand(target), /scorecheck-renderer-loss/u);
  assert.throws(() => validateTarget({ ...target, destinations: ["203.0.113.10", "203.0.113.10"] }), /unique sorted IPv4/u);
  assert.throws(() => validateTarget({ ...target, chain: "INPUT" }), /identity-bound/u);
  const changed = new RendererLossFaultRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known_hosts", resolver: async () => ["203.0.113.11"] });
  assert.equal((await changed.verifyDns(target)).passed, false);
});

test("renderer-loss remote commands are valid POSIX shell programs", async () => {
  const runtime = new RendererLossFaultRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known_hosts", resolver: async () => ["203.0.113.10", "203.0.113.20"] });
  const target = await runtime.plan({ host: "198.51.100.10", event: "renderer-loss-event", camera: 1, gateId: "renderer-loss-12345678", renderer, egressOwner });
  for (const command of [inspectCommand(target), injectCommand(target), restoreCommand(target)]) {
    const result = spawnSync("sh", ["-n"], { input: command, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("renderer-loss CLI requires a synthetic soak and separate fault and restore confirmations", () => {
  const run = parseArgs([
    "run",
    "--profile", "/tmp/profile.json",
    "--soak-evidence", "/tmp/soak",
    "--publisher-state", "/tmp/publishers.json",
    "--evidence", "/tmp/evidence",
    "--camera", "1",
    "--confirm-fault", "FAULT-RENDERER:event:CAMERA-1",
    "--confirm-restore", "RESTORE-RENDERER:event:CAMERA-1"
  ]);
  assert.equal(run.camera, 1);
  assert.throws(() => parseArgs(["run", "--evidence", "/tmp/evidence"]), /--profile and --confirm-restore are required/u);
  assert.equal(parseArgs(["restore", "--profile", "/tmp/profile.json", "--evidence", "/tmp/evidence", "--confirm-restore", "RESTORE-RENDERER:event:CAMERA-1"]).command, "restore");
  assert.equal(parseArgs(["status", "--evidence", "/tmp/evidence"]).command, "status");
});

test("renderer-loss phase accepts last-good score retention while media and peers continue", () => {
  const baseline = snapshot(startedMs + 10_000);
  const outage = snapshot(startedMs + 25_000, { disconnectedCamera: 1, incident: true });
  const recovery = snapshot(startedMs + 60_000);
  assert.deepEqual(rendererLossSnapshotProblems({ phase: "baseline", snapshot: baseline, profiles, venue, camera: 1, renderer, nowMs: startedMs + 10_000 }), []);
  assert.deepEqual(rendererLossSnapshotProblems({ phase: "outage", snapshot: outage, previous: baseline, baseline, profiles, venue, camera: 1, renderer, nowMs: startedMs + 25_000 }), []);
  assert.deepEqual(rendererLossSnapshotProblems({ phase: "recovery", snapshot: recovery, previous: outage, baseline, profiles, venue, camera: 1, renderer, nowMs: startedMs + 60_000 }), []);
});

test("renderer-loss evidence passes only with same-page reset-safe media continuity", () => {
  const baselineFirst = sample("baseline", snapshot(startedMs));
  const baselineFinal = sample("baseline", snapshot(startedMs + 10_000));
  const outageFirst = sample("outage", snapshot(startedMs + 20_000, { disconnectedCamera: 1, incident: true }));
  const outageFinal = sample("outage", snapshot(startedMs + 30_000, { disconnectedCamera: 1, incident: true }));
  const recoveryFirst = sample("recovery", snapshot(startedMs + 40_000));
  const recoveryFinal = sample("recovery", snapshot(startedMs + 60_000));
  const input = {
    event: "renderer-loss-event",
    generationId: "generation-12345678",
    camera: 1,
    renderer,
    profile: profiles[1],
    target: {
      schemaVersion: 1,
      event: "renderer-loss-event",
      camera: 1,
      gateId: "renderer-loss-12345678",
      origin: renderer.origin,
      rendererGitSha: renderer.gitSha,
      rendererDeploymentId: renderer.deploymentId,
      ...egressOwner
    },
    fault: { status: "FAULTED", injectedAt: new Date(startedMs + 12_000).toISOString() },
    dnsDuringFault: { passed: true },
    restore: { status: "HEALTHY", restoredAt: new Date(startedMs + 35_000).toISOString() },
    baseline: phase("baseline", baselineFirst, baselineFinal),
    outage: phase("outage", outageFirst, outageFinal),
    recovery: phase("recovery", recoveryFirst, recoveryFinal),
    completedAt: new Date(startedMs + 60_000).toISOString()
  };
  const report = evaluateRendererLossRehearsal(input);
  assert.equal(report.classification, "PASS");
  assert.equal(report.browser.aggregateFramesPerSecond, 30);
  assert.equal(report.transitions.rendererUnavailableMs, 8_000);
  assert.equal(report.transitions.rendererRecoveredMs, 5_000);

  const reloaded = structuredClone(input);
  reloaded.recovery.final.monitor.courts[0].browser.video.reloadCount = 1;
  const failed = evaluateRendererLossRehearsal(reloaded);
  assert.equal(failed.classification, "FAIL");
  assert.ok(failed.problems.some((problem) => problem.includes("reloadCount")));
});

test("renderer-loss evidence rejects score mutation, peer impact, and DNS drift", () => {
  const baseline = snapshot(startedMs + 10_000);
  const outage = snapshot(startedMs + 20_000, { disconnectedCamera: 1, incident: true });
  outage.courts[0].browser.scoreRender.renderedSignature = "changed";
  outage.courts[1].paths.program.ready = false;
  const problems = rendererLossSnapshotProblems({ phase: "outage", snapshot: outage, previous: baseline, baseline, profiles, venue, camera: 1, renderer, nowMs: startedMs + 20_000 });
  assert.ok(problems.some((problem) => problem.includes("last-good score DOM")));
  assert.ok(problems.some((problem) => problem.includes("Camera 2 program path")));
});

test("renderer-loss runner captures all phases and restores the exact fault", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-renderer-loss-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = startedMs;
  let faulted = false;
  const actions = [];
  const evidence = join(root, "evidence");
  const report = await runRendererLossRehearsal({
    options: {
      evidence,
      camera: 1,
      confirmFault: "FAULT-RENDERER:renderer-loss-event:CAMERA-1",
      confirmRestore: "RESTORE-RENDERER:renderer-loss-event:CAMERA-1"
    },
    manifest: { event: "renderer-loss-event" },
    lifecycleState: { phase: "live", generationId: "generation-12345678" },
    renderer,
    venue,
    soakState: {
      phase: "RUNNING",
      profiles,
      runId: egressOwner.outputGeneration,
      egress: { 1: { id: egressOwner.egressId } },
      runBinding: { destinations: { 1: { broadcastId: egressOwner.destinationId } } }
    },
    publisherState: { phase: "RUNNING" },
    compositorHost: "198.51.100.10",
    monitor: {
      snapshot: async () => {
        clock += 5_000;
        return snapshot(clock, { disconnectedCamera: faulted ? 1 : null, incident: faulted });
      }
    },
    fault: {
      plan: async ({ host, event, camera, gateId, renderer: binding, egressOwner: owner }) => ({ schemaVersion: 1, host, event, camera, gateId, origin: binding.origin, rendererGitSha: binding.gitSha, rendererDeploymentId: binding.deploymentId, ...owner }),
      inject: async () => { actions.push("inject"); faulted = true; return { status: "FAULTED", injectedAt: new Date(clock).toISOString() }; },
      verifyDns: async () => ({ passed: true, expected: ["203.0.113.10"], current: ["203.0.113.10"] }),
      restore: async () => { actions.push("restore"); faulted = false; return { status: "HEALTHY", restoredAt: new Date(clock).toISOString() }; },
      inspect: async () => ({ status: faulted ? "FAULTED" : "HEALTHY" })
    },
    now: () => clock,
    sleep: async () => {}
  });
  assert.equal(report.classification, "PASS");
  assert.deepEqual(actions, ["inject", "restore"]);
  const state = JSON.parse(await readFile(join(evidence, "renderer-loss-rehearsal-state.json"), "utf8"));
  assert.equal(state.phase, "COMPLETE");
  assert.equal(state.classification, "PASS");
});

test("renderer-loss runner invokes safety restoration when outage evidence cannot qualify", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-renderer-loss-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = startedMs;
  let faulted = false;
  let restoreCount = 0;
  await assert.rejects(() => runRendererLossRehearsal({
    options: {
      evidence: join(root, "evidence"),
      camera: 1,
      confirmFault: "FAULT-RENDERER:renderer-loss-event:CAMERA-1",
      confirmRestore: "RESTORE-RENDERER:renderer-loss-event:CAMERA-1"
    },
    manifest: { event: "renderer-loss-event" },
    lifecycleState: { phase: "live", generationId: "generation-12345678" },
    renderer,
    venue,
    soakState: { phase: "RUNNING", profiles, runId: egressOwner.outputGeneration, egress: { 1: { id: egressOwner.egressId } }, runBinding: { destinations: { 1: { broadcastId: egressOwner.destinationId } } } },
    publisherState: { phase: "RUNNING" },
    compositorHost: "198.51.100.10",
    monitor: { snapshot: async () => { clock += 5_000; return snapshot(clock); } },
    fault: {
      plan: async ({ host, event, camera, gateId, renderer: binding, egressOwner: owner }) => ({ schemaVersion: 1, host, event, camera, gateId, origin: binding.origin, rendererGitSha: binding.gitSha, rendererDeploymentId: binding.deploymentId, ...owner }),
      inject: async () => { faulted = true; return { status: "FAULTED", injectedAt: new Date(clock).toISOString() }; },
      verifyDns: async () => ({ passed: true }),
      inspect: async () => ({ status: faulted ? "FAULTED" : "HEALTHY" }),
      restore: async () => { restoreCount += 1; faulted = false; return { status: "HEALTHY", restoredAt: new Date(clock).toISOString() }; }
    },
    now: () => clock,
    sleep: async () => {}
  }), /outage renderer-loss evidence did not stabilize/u);
  assert.equal(restoreCount, 1);
});

test("renderer-loss manual restore refuses to rewrite completed evidence", async () => {
  let restoreCount = 0;
  await assert.rejects(() => restoreInterruptedRendererLoss({
    options: { evidence: "/tmp/evidence", confirmRestore: "RESTORE-RENDERER:renderer-loss-event:CAMERA-1" },
    manifest: { event: "renderer-loss-event" },
    lifecycleState: { generationId: "generation-12345678" },
    state: { event: "renderer-loss-event", generationId: "generation-12345678", camera: 1, phase: "COMPLETE", target: {} },
    fault: { restore: async () => { restoreCount += 1; } }
  }), /already complete/u);
  assert.equal(restoreCount, 0);
});

function snapshot(sampledMs, { disconnectedCamera = null, incident = false } = {}) {
  const agents = [
    agent("bvm-commentary", "commentary"),
    agent("bvm-observability", "observability"),
    agent("bvm-ingest", "ingest"),
    ...Array.from({ length: 8 }, (_, index) => agent(`bvm-compositor-${index + 1}`, "compositor", index + 1, true)),
    agent("bvm-compositor-spare", "worker")
  ];
  return {
    version: 5,
    generatedAt: new Date(sampledMs).toISOString(),
    collector: { state: "HEALTHY", agentsExpected: 12, agentsFresh: 12 },
    notifications: { pushover: { configured: true } },
    incidents: incident ? [{ id: "incident-1", status: "open", courtNumber: 1, stage: "SCORE_RENDER", issueCode: "SCOREBUG_STATE_UNAVAILABLE" }] : [],
    faultGates: [],
    agents,
    courts: Array.from({ length: 8 }, (_, index) => {
      const camera = index + 1;
      const disconnected = camera === disconnectedCamera;
      return {
        courtNumber: camera,
        paths: { raw: path("raw", 2), preview: path("preview", 1), program: path("program", 1) },
        ffmpeg: { preview: ffmpeg(null), program: ffmpeg(1) },
        browser: browser(sampledMs, disconnected),
        youtube: { courtNumber: camera, state: "HEALTHY", streamStatus: "active", healthStatus: "good", configurationIssues: [], broadcastLifecycle: "live" }
      };
    })
  };
}

function browser(sampledMs, disconnected) {
  const framesRendered = Math.round((sampledMs - startedMs) / 1_000 * 30);
  return {
    heartbeatSeq: Math.round((sampledMs - startedMs) / 5_000) + 1,
    receivedAt: new Date(sampledMs).toISOString(),
    pageLoadedAt: "2026-07-22T11:59:00Z",
    pageBuildVersion: renderer.gitSha,
    configurationVersion: "configuration-1234",
    video: {
      state: "playing", connectionState: "connected", transport: "whep", networkPath: "private-vpc", width: 1920, height: 1080,
      framesRendered, framesDropped: 0, freezeCount: 0, totalFreezesDurationMs: 0, packetsLost: 0, reconnectCount: 0, reloadCount: 0
    },
    commentary: { cameraTrackPresent: true },
    scoreRender: {
      loaded: true,
      connected: !disconnected,
      stale: false,
      frozen: false,
      matchId: "match-1",
      phase: "LIVE",
      sourceSignature: "match-1:LIVE:1:0:0",
      renderedSignature: "match-1:LIVE:1:0:0",
      domMismatchReason: null,
      stateUpdatedAt: "2026-07-22T11:59:30Z"
    }
  };
}

function path(branch, readerCount) {
  return { branch, ready: true, readerCount, inboundBitrateBps: 8_000_000, frameErrors: 0, videoCodec: "H264", videoWidth: 1920, videoHeight: 1080, audioCodec: "AAC", audioSampleRateHz: 48_000, audioChannelCount: 2 };
}

function ffmpeg(speedRatio) {
  return { framesPerSecond: 30, droppedFrames: 0, duplicatedFrames: 0, speedRatio };
}

function agent(agentId, role, assignedCourt = null, outputActive = false) {
  return {
    agentId,
    role,
    assignedCourts: assignedCourt === null ? [] : [assignedCourt],
    state: "HEALTHY",
    host: { memoryTotalBytes: 8_000_000_000, memoryAvailableBytes: 6_000_000_000, diskTotalBytes: 100_000_000_000, diskFreeBytes: 80_000_000_000 },
    services: [],
    nativeServices: ["compositor", "worker"].includes(role) ? {
      egress: { idle: !outputActive, activeWebRequests: outputActive ? 1 : 0, maximumWebRequests: 1, canAcceptRequest: !outputActive, cpuLoadRatio: outputActive ? 0.35 : 0.02, memoryLoadRatio: outputActive ? 0.25 : 0.02 }
    } : null
  };
}

function sample(label, monitor) { return { label, observedAt: monitor.generatedAt, monitor, problems: [] }; }
function phase(label, first, final) { return { label, passed: true, startedAt: first.observedAt, completedAt: final.observedAt, stableSamples: 3, sampleCount: 3, first, final }; }
