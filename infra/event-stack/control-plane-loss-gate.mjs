#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { ControlPlaneLossFaultRuntime, validateTarget } from "./control-plane-loss-fault-runtime.mjs";
import { withQualificationGateLock } from "./qualification-gate-lock.mjs";
import { ProductionYouTubeProvider } from "./production-youtube.mjs";
import { EgressRuntime } from "./rehearsal/egress-runtime.mjs";
import { loadProtectedEnv, runCommand } from "./stack-deployer.mjs";
import { YouTubeViewerProbe } from "./youtube-viewer-probe.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CAMERA_STATES = new Set(["HEALTHY", "EXPECTED_OFF"]);
const VIEWER_MARKERS = [
  "baseline-start",
  "baseline-ready",
  "control-plane-faulted",
  "worker-recycle-requested",
  "replacement-active",
  "cold-browser-healthy",
  "control-plane-restored",
  "recovery-stable",
  "complete"
];

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const statePath = join(options.evidence, "control-plane-loss-state.json");
  if (options.command === "status") {
    const value = await readOptionalJson(statePath);
    process.stdout.write(`${JSON.stringify(value?.report ?? value ?? { phase: "NOT_STARTED" }, null, 2)}\n`);
    return;
  }
  const context = await createContext(options);
  if (options.command === "restore") {
    const state = await readOptionalJson(statePath);
    if (!state?.target || state.event !== context.lifecycleState.event || state.generationId !== context.lifecycleState.generationId) {
      throw new Error("control-plane-loss restore evidence does not match the active event generation");
    }
    const target = validateTarget(state.target);
    const result = await context.fault.restore({ target, confirmation: `RESTORE-CONTROL-PLANE:${target.event}:CAMERA-${target.camera}` });
    await writeProtected(statePath, { ...state, phase: "RESTORED", restoration: result, updatedAt: new Date().toISOString() });
    process.stdout.write(`${JSON.stringify({ phase: "RESTORED", restoration: result }, null, 2)}\n`);
    return;
  }
  if (context.lifecycleState.phase !== "ready") throw new Error("physical control-plane-loss gate requires a ready event stack outside an accepted soak");
  const expectedConfirmation = `CONTROL-PLANE-LOSS:${context.lifecycleState.event}:CAMERA-${options.camera}`;
  if (options.confirm !== expectedConfirmation) throw new Error(`confirmation must be exactly ${expectedConfirmation}`);
  await mkdir(options.evidence, { recursive: true, mode: 0o700 });
  await chmod(options.evidence, 0o700);
  const report = await withQualificationGateLock(
    { profile: context.profile, lifecycleState: context.lifecycleState, gate: `physical control-plane loss Camera ${options.camera}` },
    () => runGate({ ...context, options, statePath })
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.classification !== "PASS") throw new Error("physical control-plane-loss gate classified FAIL");
}

export async function runGate(context) {
  const { options, manifest, lifecycleState, host, monitor, egress, fault, youtube, viewer, renderer, supabaseOrigin, statePath } = context;
  const existing = await readOptionalJson(statePath);
  if (existing) throw new Error("control-plane-loss evidence directory already contains state");
  const owner = await egress.readOwnership(host, options.camera);
  if (owner.event !== lifecycleState.event || owner.court !== options.camera || owner.destinationRole !== "primary") throw new Error("Camera Egress owner is not the expected primary event output");
  await egress.reconcileOwned({ host, court: options.camera, profile: owner.outputProfile, owner, expectedId: owner.egressId });
  const providerBaseline = await providerState(youtube, owner.destinationId, options.camera, lifecycleState.event);
  const baseline = await monitor.snapshot();
  const baselineProblems = healthySnapshotProblems(baseline, { camera: options.camera, owner, requireControlPlane: true });
  if (baselineProblems.length) throw new Error(`control-plane-loss baseline is not healthy: ${baselineProblems.join("; ")}`);

  const gateId = `physical-control-plane-${Date.now()}`;
  const target = await fault.plan({ host, event: lifecycleState.event, camera: options.camera, gateId, renderer, supabaseOrigin, egressOwner: owner });
  const viewerSession = await viewer.startContinuity({ camera: options.camera, broadcastId: owner.destinationId, markers: VIEWER_MARKERS });
  let viewerFinished = false;
  let restoration = null;
  let phase = "BASELINE_READY";
  let faultEvidence = null;
  let recycle = null;
  let replacement = null;
  let cold = null;
  let recovery = null;
  let viewerEvidence = null;
  let failure = null;
  await writeProtected(statePath, stateRecord({ phase, lifecycleState, options, target, baseline, providerBaseline }));

  try {
    faultEvidence = await fault.inject({ target, confirmation: `FAULT-CONTROL-PLANE:${target.event}:CAMERA-${target.camera}` });
    phase = "CONTROL_PLANE_FAULTED";
    await viewerSession.mark("control-plane-faulted");
    const dnsDuringFault = await fault.verifyDns(target);
    if (!dnsDuringFault.passed) throw new Error("provider DNS changed during the control-plane-loss fault");
    await writeProtected(statePath, stateRecord({ phase, lifecycleState, options, target, baseline, providerBaseline, faultEvidence, dnsDuringFault }));

    recycle = await fault.recycleEgress({ target, confirmation: `RECYCLE-EGRESS:${target.event}:CAMERA-${target.camera}` });
    phase = "WORKER_RECYCLE_REQUESTED";
    await viewerSession.mark("worker-recycle-requested");
    await writeProtected(statePath, stateRecord({ phase, lifecycleState, options, target, baseline, providerBaseline, faultEvidence, recycle }));

    replacement = await waitForReplacement({ egress, monitor, fault, host, camera: options.camera, target, baseline });
    phase = "REPLACEMENT_ACTIVE";
    await viewerSession.mark("replacement-active");
    await writeProtected(statePath, stateRecord({ phase, lifecycleState, options, target, baseline, providerBaseline, faultEvidence, recycle, replacement }));

    cold = await waitForColdBrowser({ monitor, camera: options.camera, baseline, owner: replacement.owner });
    phase = "COLD_BROWSER_HEALTHY";
    await viewerSession.mark("cold-browser-healthy");
    await writeProtected(statePath, stateRecord({ phase, lifecycleState, options, target, baseline, providerBaseline, faultEvidence, recycle, replacement, cold }));

    restoration = await fault.restore({ target, confirmation: `RESTORE-CONTROL-PLANE:${target.event}:CAMERA-${target.camera}` });
    phase = "CONTROL_PLANE_RESTORED";
    await viewerSession.mark("control-plane-restored");
    await writeProtected(statePath, stateRecord({ phase, lifecycleState, options, target, baseline, providerBaseline, faultEvidence, recycle, replacement, cold, restoration }));

    recovery = await waitForRecoveredBrowser({ monitor, camera: options.camera, cold, owner: replacement.owner });
    const providerFinal = await providerState(youtube, owner.destinationId, options.camera, lifecycleState.event);
    const finalFaultStatus = await fault.inspect(target);
    if (finalFaultStatus.status !== "HEALTHY") throw new Error(`control-plane-loss final fault status is ${finalFaultStatus.status}`);
    phase = "RECOVERY_STABLE";
    await viewerSession.mark("recovery-stable");
    viewerEvidence = await viewerSession.finish();
    viewerFinished = true;
    if (!viewerEvidence.passed) throw new Error(`external viewer continuity failed: ${viewerEvidence.problems.join("; ")}`);
    const finalSnapshot = await monitor.snapshot();
    const finalProblems = healthySnapshotProblems(finalSnapshot, { camera: options.camera, owner: replacement.owner, requireControlPlane: true });
    if (finalProblems.length) throw new Error(`control-plane-loss final state is not healthy: ${finalProblems.join("; ")}`);
    const report = {
      schemaVersion: 1,
      event: lifecycleState.event,
      generationId: lifecycleState.generationId,
      camera: options.camera,
      classification: "PASS",
      completedAt: new Date().toISOString(),
      initialEgressId: owner.egressId,
      replacementEgressId: replacement.owner.egressId,
      renderer: { gitSha: renderer.gitSha, deploymentId: renderer.deploymentId, origin: renderer.origin },
      providerBaseline,
      providerFinal,
      fault: faultEvidence,
      recycle,
      replacement,
      cold,
      restoration,
      recovery,
      viewer: viewerSummary(viewerEvidence),
      finalFaultStatus,
      problems: []
    };
    await writeProtected(join(options.evidence, "control-plane-loss-report.json"), report);
    await writeProtected(statePath, { ...stateRecord({ phase: "COMPLETE", lifecycleState, options, target, report }), report });
    return report;
  } catch (error) {
    failure = safeError(error);
    throw error;
  } finally {
    if (!restoration) {
      try { restoration = await fault.restore({ target, confirmation: `RESTORE-CONTROL-PLANE:${target.event}:CAMERA-${target.camera}` }); }
      catch (error) { failure = `${failure ?? "gate interrupted"}; restoration failed: ${safeError(error)}`; }
    }
    if (!viewerFinished) {
      try { viewerEvidence = await viewerSession.finish(); viewerFinished = true; }
      catch (error) { failure = `${failure ?? "gate interrupted"}; viewer cleanup failed: ${safeError(error)}`; }
    }
    if (failure) {
      const failed = {
        ...stateRecord({ phase: "FAILED", lifecycleState, options, target, baseline, providerBaseline, faultEvidence, recycle, replacement, cold, restoration, recovery }),
        failure,
        viewer: viewerEvidence ? viewerSummary(viewerEvidence) : null,
        updatedAt: new Date().toISOString()
      };
      await writeProtected(statePath, failed).catch(() => undefined);
      await writeProtected(join(options.evidence, "control-plane-loss-report.json"), { schemaVersion: 1, event: lifecycleState.event, camera: options.camera, classification: "FAIL", completedAt: new Date().toISOString(), problems: [failure], viewer: failed.viewer }).catch(() => undefined);
    }
  }
}

export function healthySnapshotProblems(snapshot, { camera, owner, requireControlPlane }) {
  const problems = commonSnapshotProblems(snapshot);
  const court = snapshot?.courts?.find((entry) => entry.courtNumber === camera);
  const agent = snapshot?.agents?.find((entry) => entry.agentId === court?.egressHost);
  if (!court) return [...problems, `Camera ${camera} is missing`];
  for (const branch of ["raw", "program"]) {
    const path = court.paths?.[branch];
    if (!path?.ready || path.frameErrors !== 0 || !(path.inboundBitrateBps > 0) || path.readerCount !== 2) problems.push(`Camera ${camera} ${branch} path is not healthy with exactly two coverage readers`);
  }
  const browser = court.browser;
  const browserAgeMs = browser ? Date.now() - Date.parse(browser.receivedAt) : Infinity;
  if (!browser || !Number.isFinite(browserAgeMs) || browserAgeMs < 0 || browserAgeMs > 15_000
    || browser.pageBuildVersion !== owner.rendererGitSha || browser.video?.state !== "playing" || browser.video?.connectionState !== "connected"
    || browser.video?.transport !== "hls" || !validBrowserQualityCounters(browser)
    || browser.video?.hlsActiveInstances !== 1 || browser.scoreRender?.loaded !== true) {
    problems.push(`Camera ${camera} browser is not fresh, pinned, and quality-valid`);
  }
  if (requireControlPlane && (browser?.scoreRender?.connected !== true || browser?.scoreRender?.stale !== false)) problems.push(`Camera ${camera} score control plane is not current`);
  if (court.youtube?.videoId !== owner.destinationId || court.youtube?.streamStatus !== "active" || court.youtube?.healthStatus !== "good"
    || court.youtube?.broadcastLifecycle !== "live" || court.youtube?.configurationIssues?.length !== 0) problems.push(`Camera ${camera} YouTube output is not live and healthy`);
  if (agent?.state !== "HEALTHY" || agent.nativeServices?.egress?.activeWebRequests !== 1 || agent.nativeServices?.egress?.maximumWebRequests !== 1
    || agent.egressSupervisor?.status !== "HEALTHY" || agent.egressSupervisor?.egressId !== owner.egressId) problems.push(`Camera ${camera} Egress host is not exactly owned and healthy`);
  for (const peer of snapshot?.courts ?? []) if (peer.courtNumber !== camera && !CAMERA_STATES.has(peer.overallState)) problems.push(`Camera ${peer.courtNumber} has unexpected state ${peer.overallState}`);
  return problems;
}

export function coldBrowserProblems(snapshot, { camera, baseline, owner }) {
  const problems = commonSnapshotProblems(snapshot, { allowIncidents: true });
  const court = snapshot?.courts?.find((entry) => entry.courtNumber === camera);
  const browser = court?.browser;
  const baselineBrowser = baseline?.courts?.find((entry) => entry.courtNumber === camera)?.browser;
  if (!court || !browser || !baselineBrowser) return [...problems, `Camera ${camera} browser evidence is missing`];
  if (browser.credentialId === baselineBrowser.credentialId || browser.pageLoadedAt === baselineBrowser.pageLoadedAt) problems.push("replacement browser did not cold-start a new page identity");
  if (browser.pageBuildVersion !== owner.rendererGitSha || browser.configurationVersion !== baselineBrowser.configurationVersion) problems.push("replacement browser build or configuration changed");
  if (browser.video?.state !== "playing" || browser.video?.connectionState !== "connected" || browser.video?.transport !== "hls"
    || !validBrowserQualityCounters(browser) || browser.video?.hlsActiveInstances !== 1) problems.push("replacement browser media is not clean");
  if (browser.scoreRender?.loaded !== true || browser.scoreRender?.connected !== false || browser.scoreRender?.stale !== true
    || browser.scoreRender?.renderedSignature !== baselineBrowser.scoreRender?.renderedSignature) problems.push("replacement browser did not retain the last-good score from local cache");
  for (const branch of ["raw", "program"]) {
    const path = court.paths?.[branch];
    if (!path?.ready || path.frameErrors !== 0 || path.readerCount !== 2 || !(path.inboundBitrateBps > 0)) problems.push(`Camera ${camera} ${branch} path changed during cold start`);
  }
  if (court.youtube?.streamStatus !== "active" || court.youtube?.healthStatus !== "good" || court.youtube?.broadcastLifecycle !== "live") problems.push("YouTube output changed during cold start");
  return problems;
}

async function waitForReplacement({ egress, monitor, fault, host, camera, target, baseline, sleep = delay }) {
  const deadline = Date.now() + 120_000;
  let maxActive = 0;
  while (Date.now() < deadline) {
    let active = [];
    try { active = await egress.listActive(host); } catch { await sleep(1_000); continue; }
    maxActive = Math.max(maxActive, active.length);
    if (active.length > 1) throw new Error("Egress supervisor admitted more than one active output");
    if (active.length === 1 && active[0].id !== target.egressOwner.egressId) {
      let owner;
      try { owner = await egress.readOwnership(host, camera); } catch { await sleep(1_000); continue; }
      if (!sameGenerationOwner(owner, target.egressOwner) || owner.egressId !== active[0].id) throw new Error("replacement Egress changed the immutable output generation");
      const snapshot = await monitor.snapshot();
      const court = snapshot.courts?.find((entry) => entry.courtNumber === camera);
      const agent = snapshot.agents?.find((entry) => entry.agentId === court?.egressHost);
      if (agent?.egressSupervisor?.status !== "HEALTHY" || agent.egressSupervisor.egressId !== owner.egressId) { await sleep(1_000); continue; }
      const faultStatus = await fault.inspect(target);
      const connectivity = await fault.connectivity(target);
      if (faultStatus.status !== "FAULTED" || Object.values(connectivity.results).some(Boolean)) throw new Error("provider fault did not survive Egress worker replacement");
      const baselinePeers = peerStates(baseline, camera);
      if (JSON.stringify(peerStates(snapshot, camera)) !== JSON.stringify(baselinePeers)) throw new Error("a peer camera changed during Egress replacement");
      return { observedAt: new Date().toISOString(), active, owner, maxActive, supervisor: agent.egressSupervisor, faultStatus, connectivity };
    }
    await sleep(1_000);
  }
  throw new Error("replacement Egress did not converge within 120 seconds");
}

async function waitForColdBrowser({ monitor, camera, baseline, owner, sleep = delay }) {
  const deadline = Date.now() + 90_000;
  let first = null;
  while (Date.now() < deadline) {
    const snapshot = await monitor.snapshot();
    const problems = coldBrowserProblems(snapshot, { camera, baseline, owner });
    const browser = snapshot.courts?.find((entry) => entry.courtNumber === camera)?.browser;
    if (!problems.length && browser) {
      if (!first) first = snapshot;
      else {
        const before = first.courts.find((entry) => entry.courtNumber === camera).browser;
        const elapsedMs = Date.parse(browser.receivedAt) - Date.parse(before.receivedAt);
        const frames = browser.video.framesRendered - before.video.framesRendered;
        if (elapsedMs >= 5_000 && frames >= elapsedMs / 1_000 * 25 && browserQualityCountersStable(before, browser)) {
          return { first, final: snapshot, elapsedMs, frames, aggregateFps: frames / (elapsedMs / 1_000) };
        }
      }
    } else first = null;
    await sleep(1_000);
  }
  throw new Error("cold local-renderer browser did not stabilize from cache within 90 seconds");
}

async function waitForRecoveredBrowser({ monitor, camera, cold, owner, sleep = delay }) {
  const deadline = Date.now() + 90_000;
  const coldBrowser = cold.final.courts.find((entry) => entry.courtNumber === camera).browser;
  let first = null;
  while (Date.now() < deadline) {
    const snapshot = await monitor.snapshot();
    const problems = healthySnapshotProblems(snapshot, { camera, owner, requireControlPlane: true });
    const browser = snapshot.courts?.find((entry) => entry.courtNumber === camera)?.browser;
    if (browser && (browser.credentialId !== coldBrowser.credentialId || browser.pageLoadedAt !== coldBrowser.pageLoadedAt)) problems.push("browser reloaded while the control plane recovered");
    if (!problems.length && browser) {
      if (!first) first = snapshot;
      else {
        const before = first.courts.find((entry) => entry.courtNumber === camera).browser;
        const elapsedMs = Date.parse(browser.receivedAt) - Date.parse(before.receivedAt);
        const frames = browser.video.framesRendered - before.video.framesRendered;
        if (elapsedMs >= 10_000 && frames >= elapsedMs / 1_000 * 25 && browserQualityCountersStable(before, browser)) {
          return { first, final: snapshot, elapsedMs, frames, aggregateFps: frames / (elapsedMs / 1_000) };
        }
      }
    } else first = null;
    await sleep(1_000);
  }
  throw new Error("restored control plane did not stabilize on the same browser page within 90 seconds");
}

function commonSnapshotProblems(snapshot, { allowIncidents = false } = {}) {
  const problems = [];
  const ageMs = Date.now() - Date.parse(snapshot?.generatedAt ?? "");
  if (snapshot?.version !== 6 || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15_000) problems.push("monitor snapshot is stale or invalid");
  if (snapshot?.collector?.state !== "HEALTHY" || snapshot.collector.agentsFresh !== 12 || snapshot.collector.agentsExpected !== 12) problems.push("monitor collector is not healthy 12/12");
  if (!allowIncidents && (snapshot?.incidents ?? []).some((entry) => entry.status !== "resolved")) problems.push("an active incident exists");
  if ((snapshot?.faultGates ?? []).length) problems.push("a monitoring fault gate is active");
  return problems;
}

function validBrowserQualityCounters(browser) {
  return [browser?.video?.framesDropped, browser?.video?.freezeCount, browser?.video?.totalFreezesDurationMs]
    .every((value) => Number.isFinite(value) && value >= 0);
}

export function browserQualityCountersStable(before, after) {
  return validBrowserQualityCounters(before)
    && validBrowserQualityCounters(after)
    && after.video.framesDropped === before.video.framesDropped
    && after.video.freezeCount === before.video.freezeCount
    && after.video.totalFreezesDurationMs === before.video.totalFreezesDurationMs;
}

async function createContext(options) {
  const profile = await readProtectedJson(options.profile, "event operator profile");
  if (profile.schemaVersion !== 9) throw new Error("control-plane-loss gate requires event operator profile schema 9");
  const manifest = await readProtectedJson(profile.manifest, "event manifest");
  const lifecycleState = await readProtectedJson(profile.state, "event lifecycle state");
  if (manifest.kind !== "production" || manifest.droplets?.length !== 12 || lifecycleState.event !== manifest.event
    || !["ready", "live"].includes(lifecycleState.phase) || Object.values(lifecycleState.droplets ?? {}).filter((entry) => entry.status === "active").length !== 12) {
    throw new Error("control-plane-loss gate requires the matching active 12-host production stack");
  }
  const droplet = manifest.droplets.find((entry) => entry.role === "compositor" && entry.court === options.camera);
  const host = droplet ? lifecycleState.droplets?.[droplet.name]?.publicIpv4 : null;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host ?? "")) throw new Error(`Camera ${options.camera} compositor has no live IPv4`);
  const observabilityEnv = await loadProtectedEnv(join(profile.secrets, "observability.env"));
  const rendererEnv = await loadProtectedEnv(join(profile.secrets, "renderer.env"));
  const credentials = await loadProtectedEnv(profile.credentialsEnv);
  const monitorEndpoint = manifest.endpoints.find((entry) => entry.role === "observability");
  if (!monitorEndpoint?.hostname) throw new Error("event manifest has no observability endpoint");
  const remote = await runCommand("ssh", sshArgs(profile, host, "curl -fsS --max-time 5 http://127.0.0.1:3000/api/program/renderer-binding"));
  const renderer = JSON.parse(remote.stdout);
  return {
    options,
    profile,
    manifest,
    lifecycleState,
    host,
    renderer,
    supabaseOrigin: required(rendererEnv.NEXT_PUBLIC_SUPABASE_URL, "Supabase origin"),
    monitor: new MonitorRuntime({ origin: `https://${monitorEndpoint.hostname}`, token: required(observabilityEnv.MONITOR_API_TOKEN, "monitor token") }),
    egress: new EgressRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts }),
    fault: new ControlPlaneLossFaultRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts }),
    youtube: new ProductionYouTubeProvider({
      clientId: required(credentials.YOUTUBE_CLIENT_ID, "YouTube client id"),
      clientSecret: required(credentials.YOUTUBE_CLIENT_SECRET, "YouTube client secret"),
      refreshToken: required(credentials.YOUTUBE_REFRESH_TOKEN, "YouTube refresh token")
    }),
    viewer: new YouTubeViewerProbe()
  };
}

class MonitorRuntime {
  constructor({ origin, token, fetchImpl = globalThis.fetch }) { this.origin = origin; this.token = token; this.fetchImpl = fetchImpl; }
  async snapshot() {
    const response = await this.fetchImpl(`${this.origin}/v1/snapshot`, { headers: { authorization: `Bearer ${this.token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`monitor snapshot returned HTTP ${response.status}`);
    return response.json();
  }
}

async function providerState(youtube, broadcastId, camera, event) {
  const broadcast = await youtube.getBroadcast(broadcastId);
  if (broadcast.event !== event || broadcast.court !== camera || broadcast.privacyStatus !== "unlisted" || broadcast.autoStart !== false
    || broadcast.autoStop !== false || broadcast.lifeCycleStatus !== "live" || broadcast.recordingStatus !== "recording" || !broadcast.streamId) {
    throw new Error("YouTube broadcast is not the exact unlisted manually controlled live destination");
  }
  const stream = await youtube.getStream(broadcast.streamId);
  if (stream.court !== camera || stream.streamStatus !== "active" || stream.healthStatus !== "good" || stream.configurationIssues.length !== 0) {
    throw new Error("YouTube stream is not active and healthy");
  }
  return { observedAt: new Date().toISOString(), broadcast, stream: { id: stream.id, court: stream.court, streamStatus: stream.streamStatus, healthStatus: stream.healthStatus, configurationIssues: stream.configurationIssues } };
}

function sameGenerationOwner(current, expected) {
  for (const field of ["event", "court", "destinationId", "destinationRole", "outputGeneration", "outputProfile", "rendererGitSha", "rendererDeploymentId", "rendererRuntimeOrigin", "rendererReleaseOrigin", "rendererBundleSha256", "requestSha256"]) {
    if (current?.[field] !== expected?.[field]) return false;
  }
  return true;
}
function peerStates(snapshot, camera) { return (snapshot.courts ?? []).filter((entry) => entry.courtNumber !== camera).map((entry) => [entry.courtNumber, entry.overallState]); }
function viewerSummary(value) { return { passed: value.passed, status: value.status, sampledForMs: value.sampledForMs, sampleCount: value.sampleCount, droppedSamples: value.droppedSamples, maximumSampleGapMs: value.maximumSampleGapMs, maximumStallMs: value.maximumStallMs, playheadDeltaSeconds: value.playheadDeltaSeconds, audioDecodedBytes: value.audioDecodedBytes, audioCounterResets: value.audioCounterResets, videoDimensions: value.videoDimensions, markers: value.markers, problems: value.problems }; }
function stateRecord(values) { return { schemaVersion: 1, event: values.lifecycleState.event, generationId: values.lifecycleState.generationId, camera: values.options.camera, updatedAt: new Date().toISOString(), ...values, lifecycleState: undefined, options: undefined }; }

async function readProtectedJson(path, label) {
  requireAbsolute(path, label);
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected file`);
  return JSON.parse(await readFile(path, "utf8"));
}
async function readOptionalJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function writeProtected(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const command = argv[0];
  if (!new Set(["run", "restore", "status"]).has(command)) return null;
  const options = { command, profile: null, evidence: null, camera: null, confirm: null };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => argv[++index] ?? "";
    if (value === "--profile") options.profile = next();
    else if (value === "--evidence") options.evidence = next();
    else if (value === "--camera") options.camera = Number(next());
    else if (value === "--confirm") options.confirm = next();
    else throw new Error(`unknown argument ${value}`);
  }
  requireAbsolute(options.evidence, "evidence directory");
  if (command !== "status") requireAbsolute(options.profile, "event operator profile");
  if (command === "run") {
    if (!Number.isInteger(options.camera) || options.camera < 1 || options.camera > 8) throw new Error("camera must be from 1 through 8");
    if (!options.confirm) throw new Error("explicit confirmation is required");
  }
  if (command === "restore" && (!Number.isInteger(options.camera) || options.camera < 1 || options.camera > 8)) throw new Error("camera must be from 1 through 8");
  return options;
}

function sshArgs(profile, host, command) { return ["-i", profile.sshKey, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${profile.knownHosts}`, "-o", "ConnectTimeout=10", `root@${host}`, command]; }
function requireAbsolute(value, label) { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`); }
function required(value, label) { if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) throw new Error(`${label} is required`); return value.trim(); }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]+/gu, " ").slice(0, 500); }
function usage() { process.stdout.write("Usage:\n  node infra/event-stack/control-plane-loss-gate.mjs run --profile /PROTECTED/event-profile.json --evidence /PROTECTED/gate --camera 5 --confirm CONTROL-PLANE-LOSS:<event>:CAMERA-5\n  node infra/event-stack/control-plane-loss-gate.mjs restore --profile /PROTECTED/event-profile.json --evidence /PROTECTED/gate --camera 5\n  node infra/event-stack/control-plane-loss-gate.mjs status --evidence /PROTECTED/gate\n"); }
