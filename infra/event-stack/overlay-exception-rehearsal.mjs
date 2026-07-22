#!/usr/bin/env node

import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { validateProfile } from "./eventctl.mjs";
import { loadManifestInputs, validateEventManifest } from "./event-manifest.mjs";
import { FileStateStore } from "./event-lifecycle.mjs";
import { OverlayExceptionDebugRuntime } from "./overlay-exception-debug-runtime.mjs";
import { evaluateOverlayExceptionRehearsal, overlayExceptionSnapshotProblems } from "./overlay-exception-evidence.mjs";
import { loadRendererBinding } from "./renderer-binding.mjs";
import { ProductionSyntheticPublisherStateStore } from "./production-synthetic-publishers.mjs";
import { withQualificationGateLock } from "./qualification-gate-lock.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { loadVenueAdmission } from "./venue-admission.mjs";

const SAMPLE_INTERVAL_MS = 5_000;
const PHASE_TIMEOUT_MS = 3 * 60_000;
const STATE_FILE = "overlay-exception-rehearsal-state.json";

if (isDirectInvocation()) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  if (options.command === "status") {
    const state = await readStateOrNull(join(options.evidence, STATE_FILE));
    const report = await readStateOrNull(join(options.evidence, "overlay-exception-rehearsal-report.json"));
    process.stdout.write(`${JSON.stringify(report ? publicReport(report) : publicState(state), null, 2)}\n`);
    return;
  }
  if (options.command === "prepare") {
    const runtime = await createPrepareRuntime(options);
    const result = await withQualificationGateLock(
      { ...runtime, gate: "overlay-exception prepare" },
      () => prepareOverlayExceptionRehearsal(runtime)
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.command === "cleanup") {
    const runtime = await createCleanupRuntime(options);
    const result = await withQualificationGateLock(
      { ...runtime, gate: "overlay-exception cleanup" },
      () => cleanupOverlayExceptionRehearsal(runtime)
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const runtime = await createRunRuntime(options);
  const report = await withQualificationGateLock(
    { ...runtime, gate: "overlay-exception run" },
    () => runOverlayExceptionRehearsal(runtime)
  );
  process.stdout.write(`${JSON.stringify(publicReport(report), null, 2)}\n`);
}

export async function prepareOverlayExceptionRehearsal(runtime) {
  const { options, manifest, lifecycleState, renderer, venue, compositorHost, egressConfig, debug, now = () => Date.now() } = runtime;
  if (!new Set(["ready", "live"]).has(lifecycleState.phase)) throw new Error("overlay-exception preparation requires a ready or live event stack");
  if (!venue.passed || venue.activeCameras.length !== 8 || !venue.activeCameras.includes(options.camera)) throw new Error("overlay-exception rehearsal requires eight admitted synthetic cameras including the target");
  await prepareEvidenceDirectory(options.evidence);
  const target = debug.plan({ host: compositorHost, event: manifest.event, generationId: lifecycleState.generationId, camera: options.camera, renderer, egressConfig });
  let state = {
    schemaVersion: 1,
    event: manifest.event,
    generationId: lifecycleState.generationId,
    camera: options.camera,
    phase: "PLANNED",
    target,
    prepared: null,
    activation: null,
    installed: null,
    armed: null,
    baseline: null,
    fault: null,
    completed: null,
    cleanup: null,
    classification: null,
    startedAt: new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString()
  };
  const statePath = join(options.evidence, STATE_FILE);
  await writeState(statePath, state);
  try {
    state.prepared = await debug.prepare({ target, confirmation: options.confirmPrepare });
    state.phase = "PREPARED";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    return publicState(state);
  } catch (error) {
    state.phase = "PREPARE_FAILED";
    state.classification = "FAIL";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state).catch(() => {});
    await writeProtected(join(options.evidence, "overlay-exception-rehearsal-failure.json"), failureRecord(state, error)).catch(() => {});
    throw error;
  }
}

export async function runOverlayExceptionRehearsal(runtime) {
  const { options, manifest, lifecycleState, renderer, venue, soakState, publisherState, state: initialState, monitor, debug, now = () => Date.now(), sleep = delay } = runtime;
  requireConfirmation(options.confirmArm, `ARM-OVERLAY-EXCEPTION:${manifest.event}:CAMERA-${initialState.camera}`);
  requireConfirmation(options.confirmFault, `FAULT-OVERLAY:${manifest.event}:CAMERA-${initialState.camera}`);
  validateRunBindings({ manifest, lifecycleState, renderer, venue, soakState, publisherState, state: initialState });
  const owner = {
    event: manifest.event,
    camera: initialState.camera,
    rendererGitSha: renderer.gitSha,
    rendererDeploymentId: renderer.deploymentId,
    egressId: soakState.egress?.[initialState.camera]?.id,
    destinationId: soakState.runBinding?.destinations?.[initialState.camera]?.broadcastId,
    outputGeneration: soakState.runId
  };
  const statePath = join(options.evidence, STATE_FILE);
  const samplesPath = join(options.evidence, "overlay-exception-rehearsal-samples.jsonl");
  const handle = await open(samplesPath, "wx", 0o600);
  await chmod(samplesPath, 0o600);
  let state = structuredClone(initialState);
  let session = null;
  try {
    state.activation = await debug.activate({ target: state.target, owner, confirmation: options.confirmArm });
    state.phase = "ACTIVE";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    session = await debug.connect(state.target, state.activation);
    state.installed = await session.install();
    state.baseline = await captureStablePhase({ label: "baseline", requiredStableSamples: 6, monitor, session, profiles: soakState.profiles, venue, camera: state.camera, renderer, handle, now, sleep });
    state.phase = "BASELINE_COMPLETE";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);

    state.armed = await session.arm(options.confirmFault);
    state.phase = "FAULTED";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    state.fault = await captureStablePhase({
      label: "fault", requiredStableSamples: 6, monitor, session, profiles: soakState.profiles, venue, camera: state.camera, renderer,
      baseline: state.baseline.final.monitor, initialPrevious: state.baseline.final.monitor, handle, now, sleep
    });
    state.completed = await debug.complete({ target: state.target });
    const report = evaluateOverlayExceptionRehearsal({
      event: state.event,
      generationId: state.generationId,
      camera: state.camera,
      renderer,
      profile: soakState.profiles[state.camera],
      target: state.target,
      owner,
      prepared: state.prepared,
      activation: state.activation,
      installed: state.installed,
      armed: state.armed,
      baseline: state.baseline,
      fault: state.fault,
      completed: state.completed,
      completedAt: new Date(now()).toISOString()
    });
    await writeProtected(join(options.evidence, "overlay-exception-rehearsal-report.json"), report);
    state.phase = "COMPLETE";
    state.classification = report.classification;
    state.updatedAt = report.completedAt;
    await writeState(statePath, state);
    return report;
  } catch (error) {
    state.phase = "FAILED";
    state.classification = "FAIL";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state).catch(() => {});
    await writeProtected(join(options.evidence, "overlay-exception-rehearsal-failure.json"), failureRecord(state, error)).catch(() => {});
    throw error;
  } finally {
    await session?.close().catch(() => {});
    await handle.close();
  }
}

export async function cleanupOverlayExceptionRehearsal(runtime) {
  const { options, manifest, lifecycleState, state, debug, now = () => Date.now() } = runtime;
  if (state.event !== manifest.event || state.generationId !== lifecycleState.generationId) throw new Error("overlay-exception cleanup state does not match the event generation");
  requireConfirmation(options.confirmCleanup, `CLEANUP-OVERLAY-DEBUG:${state.event}:CAMERA-${state.camera}`);
  const cleanup = await debug.cleanup({ target: state.target, confirmation: options.confirmCleanup });
  const next = { ...state, phase: "CLEANED", cleanup, updatedAt: new Date(now()).toISOString() };
  await writeState(join(options.evidence, STATE_FILE), next);
  return publicState(next);
}

export function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["prepare", "run", "status", "cleanup"]).has(command)) throw new Error("first argument must be prepare, run, status, or cleanup");
  const options = { command, profile: null, soakEvidence: null, publisherState: null, evidence: null, camera: null, confirmPrepare: null, confirmArm: null, confirmFault: null, confirmCleanup: null };
  const mapping = new Map([
    ["--profile", "profile"], ["--soak-evidence", "soakEvidence"], ["--publisher-state", "publisherState"], ["--evidence", "evidence"], ["--camera", "camera"],
    ["--confirm-prepare", "confirmPrepare"], ["--confirm-arm", "confirmArm"], ["--confirm-fault", "confirmFault"], ["--confirm-cleanup", "confirmCleanup"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const raw = argv[++index];
    if (!key || !raw || raw.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    if (options[key] !== null) throw new Error(`${flag} may be specified only once`);
    options[key] = key === "camera" ? Number(raw) : key.startsWith("confirm") ? raw : normalizedAbsolute(raw, flag);
  }
  if (!options.evidence) throw new Error("--evidence is required");
  if (command === "status") {
    if (Object.entries(options).some(([key, value]) => !["command", "evidence"].includes(key) && value !== null)) throw new Error("status accepts only --evidence");
    return options;
  }
  if (!options.profile) throw new Error("--profile is required");
  const allowed = {
    prepare: new Set(["command", "profile", "evidence", "camera", "confirmPrepare"]),
    run: new Set(["command", "profile", "soakEvidence", "publisherState", "evidence", "confirmArm", "confirmFault"]),
    cleanup: new Set(["command", "profile", "evidence", "confirmCleanup"])
  }[command];
  for (const [key, value] of Object.entries(options)) if (!allowed.has(key) && value !== null) throw new Error(`${command} does not accept --${kebab(key)}`);
  const required = command === "prepare" ? ["camera", "confirmPrepare"] : command === "run" ? ["soakEvidence", "publisherState", "confirmArm", "confirmFault"] : ["confirmCleanup"];
  for (const key of required) if (options[key] === null) throw new Error(`--${kebab(key)} is required`);
  if (command === "prepare" && (!Number.isInteger(options.camera) || options.camera < 1 || options.camera > 8)) throw new Error("--camera must be 1-8");
  return options;
}

async function createPrepareRuntime(options) {
  const base = await loadBaseRuntime(options);
  return { ...base, options, egressConfig: await readFile(new URL("../compositor/egress.yaml", import.meta.url), "utf8"), debug: newDebug(base), compositorHost: compositorHost(base.manifest, base.lifecycleState, options.camera) };
}

async function createRunRuntime(options) {
  const base = await loadBaseRuntime(options);
  const state = await readProtectedJson(join(options.evidence, STATE_FILE), "overlay-exception rehearsal state");
  const soakState = await readProtectedJson(join(options.soakEvidence, "production-soak-state.json"), "production soak state");
  const publisherState = await new ProductionSyntheticPublisherStateStore(options.publisherState).load();
  return { ...base, options, state, soakState, publisherState, monitor: new MonitorSnapshotRuntime({ origin: `https://${onlyEndpoint(base.manifest, "observability")}`, token: base.monitorToken }), debug: newDebug(base) };
}

async function createCleanupRuntime(options) {
  const base = await loadBaseRuntime(options);
  const state = await readProtectedJson(join(options.evidence, STATE_FILE), "overlay-exception rehearsal state");
  return { ...base, options, state, debug: newDebug(base) };
}

async function loadBaseRuntime(options) {
  const profile = validateProfile(await readProtectedJson(options.profile, "event operator profile"));
  const manifest = await readProtectedJson(profile.manifest, "event manifest");
  validateEventManifest(manifest, await loadManifestInputs({ networkFromManifest: manifest.network }));
  if (manifest.kind !== "production" || manifest.droplets.length !== 12) throw new Error("overlay-exception rehearsal requires the exact production manifest");
  const lifecycleState = await new FileStateStore(profile.state).load();
  if (!lifecycleState || lifecycleState.event !== manifest.event) throw new Error("overlay-exception rehearsal lifecycle state is missing");
  const renderer = await loadRendererBinding(profile.rendererBinding);
  const venue = await loadVenueAdmission(profile.venueProfile, manifest.event);
  const observability = await loadProtectedEnv(join(profile.secrets, "observability.env"));
  const monitorToken = required(observability.MONITOR_API_TOKEN, "monitor API token");
  return { profile, manifest, lifecycleState, renderer, venue, monitorToken };
}

function newDebug(base) {
  return new OverlayExceptionDebugRuntime({ sshKey: base.profile.sshKey, knownHosts: base.profile.knownHosts });
}

function validateRunBindings({ manifest, lifecycleState, renderer, venue, soakState, publisherState, state }) {
  if (lifecycleState.phase !== "live") throw new Error("overlay-exception run requires lifecycle phase live");
  if (state.phase !== "PREPARED" || state.event !== manifest.event || state.generationId !== lifecycleState.generationId) throw new Error("overlay-exception prepared state does not match the event generation");
  if (!venue.passed || venue.activeCameras.length !== 8 || !venue.activeCameras.includes(state.camera)) throw new Error("overlay-exception run requires eight admitted synthetic cameras including the target");
  if (soakState?.phase !== "RUNNING" || soakState.event !== manifest.event || JSON.stringify(soakState.activeCameras) !== JSON.stringify(venue.activeCameras)) throw new Error("overlay-exception run requires the exact running production soak");
  if (soakState.runBinding?.renderer?.gitSha !== renderer.gitSha || soakState.runBinding?.renderer?.deploymentId !== renderer.deploymentId) throw new Error("overlay-exception soak renderer binding is stale");
  if (publisherState?.phase !== "RUNNING" || publisherState.event !== manifest.event || publisherState.generationId !== lifecycleState.generationId || Object.keys(publisherState.publishers ?? {}).length !== 8) throw new Error("overlay-exception synthetic publisher binding is invalid");
}

async function captureStablePhase({ label, requiredStableSamples, timeoutMs = PHASE_TIMEOUT_MS, monitor, session, profiles, venue, camera, renderer, baseline = null, initialPrevious = null, handle, now, sleep }) {
  const startedMs = now();
  let previous = initialPrevious;
  let stable = 0;
  let firstStable = null;
  let latest = null;
  let sampleCount = 0;
  while (now() - startedMs <= timeoutMs) {
    const [snapshot, page] = await Promise.all([monitor.snapshot(), session.status()]);
    const problems = overlayExceptionSnapshotProblems({ phase: label, snapshot, page, previous, baseline, profiles, venue, camera, renderer, nowMs: now() });
    const sample = { label, observedAt: snapshot.generatedAt, monitor: snapshot, page, problems };
    await handle.write(`${JSON.stringify(sample)}\n`);
    await handle.sync();
    sampleCount += 1;
    latest = sample;
    if (problems.length === 0) {
      stable += 1;
      if (stable === 1) firstStable = sample;
      if (stable >= requiredStableSamples) return { label, passed: true, startedAt: firstStable.observedAt, completedAt: sample.observedAt, stableSamples: requiredStableSamples, sampleCount, first: firstStable, final: sample };
    } else {
      stable = 0;
      firstStable = null;
    }
    previous = snapshot;
    await sleep(SAMPLE_INTERVAL_MS);
  }
  throw new Error(`${label} overlay-exception evidence did not stabilize: ${(latest?.problems ?? ["no sample"]).slice(0, 8).join("; ")}`);
}

class MonitorSnapshotRuntime {
  constructor({ origin, token, fetchImpl = globalThis.fetch }) { Object.assign(this, { origin, token, fetchImpl }); }
  async snapshot() {
    const response = await this.fetchImpl(`${this.origin}/v1/snapshot`, { headers: { authorization: `Bearer ${this.token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`monitor snapshot returned HTTP ${response.status}`);
    const value = await response.json();
    if (value?.version !== 5 || !Array.isArray(value.courts) || !Array.isArray(value.agents)) throw new Error("monitor snapshot contract is invalid");
    return value;
  }
}

async function prepareEvidenceDirectory(path) {
  try {
    await lstat(path);
    throw new Error("overlay-exception evidence directory already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function readProtectedJson(path, label) {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected regular file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readStateOrNull(path) {
  try { return await readProtectedJson(path, "overlay-exception evidence"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function writeState(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function writeProtected(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

function failureRecord(state, error) {
  return { schemaVersion: 1, classification: "FAIL", event: state.event, generationId: state.generationId, camera: state.camera, phase: state.phase, observedAt: state.updatedAt, error: safeError(error) };
}

function compositorHost(manifest, lifecycleState, camera) {
  const spec = manifest.droplets.find((entry) => entry.role === "compositor" && entry.court === camera);
  const host = spec ? lifecycleState.droplets?.[spec.name]?.publicIpv4 : null;
  if (!host) throw new Error(`overlay-exception rehearsal has no Camera ${camera} compositor IPv4`);
  return host;
}

function onlyEndpoint(manifest, role) {
  const values = manifest.endpoints.filter((entry) => entry.role === role);
  if (values.length !== 1 || typeof values[0].hostname !== "string") throw new Error(`production manifest requires exactly one ${role} endpoint`);
  return values[0].hostname;
}

function publicState(state) {
  if (!state) return { status: "NOT_STARTED" };
  return { event: state.event, generationId: state.generationId, camera: state.camera, phase: state.phase, classification: state.classification, updatedAt: state.updatedAt };
}

function publicReport(report) {
  return { classification: report.classification, event: report.event, generationId: report.generationId, camera: report.camera, gateId: report.gateId, browser: report.browser, fault: report.fault, problems: report.problems };
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`);
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function kebab(value) { return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`); }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]+/gu, " ").slice(0, 500); }
function isDirectInvocation() { return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url; }

function usage() {
  process.stdout.write("Usage:\n  node infra/event-stack/overlay-exception-rehearsal.mjs prepare --profile FILE --evidence DIR --camera N --confirm-prepare PREPARE-OVERLAY-DEBUG:EVENT:CAMERA-N\n  node infra/event-stack/overlay-exception-rehearsal.mjs run --profile FILE --soak-evidence DIR --publisher-state FILE --evidence DIR --confirm-arm ARM-OVERLAY-EXCEPTION:EVENT:CAMERA-N --confirm-fault FAULT-OVERLAY:EVENT:CAMERA-N\n  node infra/event-stack/overlay-exception-rehearsal.mjs cleanup --profile FILE --evidence DIR --confirm-cleanup CLEANUP-OVERLAY-DEBUG:EVENT:CAMERA-N\n  node infra/event-stack/overlay-exception-rehearsal.mjs status --evidence DIR\n");
}
