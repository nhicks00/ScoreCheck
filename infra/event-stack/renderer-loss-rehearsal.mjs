#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { validateProfile } from "./eventctl.mjs";
import { loadManifestInputs, validateEventManifest } from "./event-manifest.mjs";
import { FileStateStore } from "./event-lifecycle.mjs";
import { RendererLossFaultRuntime } from "./renderer-loss-fault-runtime.mjs";
import { evaluateRendererLossRehearsal, rendererLossSnapshotProblems } from "./renderer-loss-evidence.mjs";
import { loadRendererBinding } from "./renderer-binding.mjs";
import { ProductionSyntheticPublisherStateStore } from "./production-synthetic-publishers.mjs";
import { withQualificationGateLock } from "./qualification-gate-lock.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { loadVenueAdmission } from "./venue-admission.mjs";

const SAMPLE_INTERVAL_MS = 5_000;
const PHASE_TIMEOUT_MS = 3 * 60_000;

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
    const state = await readStateOrNull(join(options.evidence, "renderer-loss-rehearsal-state.json"));
    const report = await readStateOrNull(join(options.evidence, "renderer-loss-rehearsal-report.json"));
    process.stdout.write(`${JSON.stringify(report ? publicReport(report) : publicState(state), null, 2)}\n`);
    return;
  }
  if (options.command === "restore") {
    const runtime = await createRestoreRuntime(options);
    const result = await withQualificationGateLock(
      { ...runtime, gate: "renderer-loss restore" },
      () => restoreInterruptedRendererLoss(runtime)
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const runtime = await createRuntime(options);
  const report = await withQualificationGateLock(
    { ...runtime, gate: "renderer-loss run" },
    () => runRendererLossRehearsal(runtime)
  );
  process.stdout.write(`${JSON.stringify(publicReport(report), null, 2)}\n`);
}

export async function runRendererLossRehearsal(runtime) {
  const { options, manifest, lifecycleState, renderer, venue, soakState, publisherState, monitor, fault, now = () => Date.now(), sleep = delay } = runtime;
  requireConfirmation(options.confirmFault, `FAULT-RENDERER:${manifest.event}:CAMERA-${options.camera}`);
  requireConfirmation(options.confirmRestore, `RESTORE-RENDERER:${manifest.event}:CAMERA-${options.camera}`);
  if (lifecycleState.phase !== "live") throw new Error("renderer-loss rehearsal requires lifecycle phase live");
  if (soakState.phase !== "RUNNING") throw new Error("renderer-loss rehearsal requires a running production soak");
  if (publisherState.phase !== "RUNNING") throw new Error("renderer-loss rehearsal requires active synthetic publishers");
  const gateId = `renderer-loss-${randomUUID()}`;
  const target = await fault.plan({
    host: runtime.compositorHost,
    event: manifest.event,
    camera: options.camera,
    gateId,
    renderer,
    egressOwner: {
      egressId: soakState.egress?.[options.camera]?.id,
      destinationId: soakState.runBinding?.destinations?.[options.camera]?.broadcastId,
      outputGeneration: soakState.runId
    }
  });
  await prepareEvidenceDirectory(options.evidence);
  const statePath = join(options.evidence, "renderer-loss-rehearsal-state.json");
  const samplesPath = join(options.evidence, "renderer-loss-rehearsal-samples.jsonl");
  const handle = await open(samplesPath, "wx", 0o600);
  await chmod(samplesPath, 0o600);
  let state = {
    schemaVersion: 1,
    event: manifest.event,
    generationId: lifecycleState.generationId,
    camera: options.camera,
    phase: "PLANNED",
    target,
    startedAt: new Date(now()).toISOString(),
    updatedAt: new Date(now()).toISOString(),
    baseline: null,
    fault: null,
    outage: null,
    dnsDuringFault: null,
    restore: null,
    recovery: null,
    classification: null
  };
  await writeState(statePath, state);
  try {
    state.baseline = await captureStablePhase({
      label: "baseline", requiredStableSamples: 6, monitor, profiles: soakState.profiles, venue, camera: options.camera, renderer, handle, now, sleep
    });
    state.phase = "BASELINE_COMPLETE";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);

    state.fault = await fault.inject({ target, confirmation: options.confirmFault });
    state.phase = "FAULTED";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    state.outage = await captureStablePhase({
      label: "outage", requiredStableSamples: 3, timeoutMs: 90_000, monitor, profiles: soakState.profiles, venue, camera: options.camera, renderer,
      baseline: state.baseline.final.monitor, initialPrevious: state.baseline.final.monitor, handle, now, sleep
    });
    state.dnsDuringFault = await fault.verifyDns(target);
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);

    state.restore = await fault.restore({ target, confirmation: options.confirmRestore });
    state.phase = "RESTORED";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    state.recovery = await captureStablePhase({
      label: "recovery", requiredStableSamples: 6, monitor, profiles: soakState.profiles, venue, camera: options.camera, renderer,
      baseline: state.baseline.final.monitor, initialPrevious: state.outage.final.monitor, handle, now, sleep
    });

    const report = evaluateRendererLossRehearsal({
      event: manifest.event,
      generationId: lifecycleState.generationId,
      camera: options.camera,
      renderer,
      profile: soakState.profiles[options.camera],
      target,
      fault: state.fault,
      dnsDuringFault: state.dnsDuringFault,
      restore: state.restore,
      baseline: state.baseline,
      outage: state.outage,
      recovery: state.recovery,
      completedAt: new Date(now()).toISOString()
    });
    await writeProtected(join(options.evidence, "renderer-loss-rehearsal-report.json"), report);
    state.phase = "COMPLETE";
    state.classification = report.classification;
    state.updatedAt = report.completedAt;
    await writeState(statePath, state);
    return report;
  } catch (error) {
    const safetyRestore = await safetyRestoreRenderer({ fault, target, confirmation: options.confirmRestore });
    state.phase = "FAILED";
    state.classification = "FAIL";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state).catch(() => {});
    await writeProtected(join(options.evidence, "renderer-loss-rehearsal-failure.json"), {
      schemaVersion: 1,
      classification: "FAIL",
      event: manifest.event,
      generationId: lifecycleState.generationId,
      camera: options.camera,
      observedAt: state.updatedAt,
      error: safeError(error),
      safetyRestore
    }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

export async function restoreInterruptedRendererLoss(runtime) {
  const { options, manifest, lifecycleState, state, fault } = runtime;
  if (state.event !== manifest.event || state.generationId !== lifecycleState.generationId) throw new Error("renderer-loss recovery state does not match the event generation");
  if (["COMPLETE", "RESTORED_AFTER_INTERRUPT"].includes(state.phase)) throw new Error(`renderer-loss rehearsal is already ${state.phase.toLowerCase()}`);
  requireConfirmation(options.confirmRestore, `RESTORE-RENDERER:${state.event}:CAMERA-${state.camera}`);
  const result = await fault.restore({ target: state.target, confirmation: options.confirmRestore });
  const next = { ...state, phase: "RESTORED_AFTER_INTERRUPT", restore: result, updatedAt: new Date().toISOString() };
  await writeState(join(options.evidence, "renderer-loss-rehearsal-state.json"), next);
  return { status: result.status, event: state.event, camera: state.camera, phase: next.phase };
}

export function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["run", "status", "restore"]).has(command)) throw new Error("first argument must be run, status, or restore");
  const options = { command, profile: null, soakEvidence: null, publisherState: null, evidence: null, camera: null, confirmFault: null, confirmRestore: null };
  const mapping = new Map([
    ["--profile", "profile"], ["--soak-evidence", "soakEvidence"], ["--publisher-state", "publisherState"], ["--evidence", "evidence"],
    ["--camera", "camera"], ["--confirm-fault", "confirmFault"], ["--confirm-restore", "confirmRestore"]
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
  if (!options.profile || !options.confirmRestore) throw new Error("--profile and --confirm-restore are required");
  if (command === "restore") {
    if ([options.soakEvidence, options.publisherState, options.camera, options.confirmFault].some((value) => value !== null)) throw new Error("restore accepts only --profile, --evidence, and --confirm-restore");
    return options;
  }
  for (const key of ["soakEvidence", "publisherState", "camera", "confirmFault"]) if (options[key] === null) throw new Error(`--${kebab(key)} is required`);
  if (!Number.isInteger(options.camera) || options.camera < 1 || options.camera > 8) throw new Error("--camera must be 1-8");
  return options;
}

async function createRuntime(options) {
  const base = await loadBaseRuntime(options);
  const venue = await loadVenueAdmission(base.profile.venueProfile, base.manifest.event);
  if (!venue.passed || venue.activeCameras.length !== 8 || !venue.activeCameras.includes(options.camera)) throw new Error("renderer-loss rehearsal requires eight admitted active synthetic cameras including the target");
  const soakState = await readProtectedJson(join(options.soakEvidence, "production-soak-state.json"), "production soak state");
  if (soakState.event !== base.manifest.event || soakState.phase !== "RUNNING" || JSON.stringify(soakState.activeCameras) !== JSON.stringify(venue.activeCameras)) throw new Error("renderer-loss rehearsal production soak binding is invalid");
  if (soakState.runBinding?.renderer?.gitSha !== base.renderer.gitSha || soakState.runBinding?.renderer?.deploymentId !== base.renderer.deploymentId) throw new Error("renderer-loss rehearsal soak renderer binding is stale");
  const publisherState = await new ProductionSyntheticPublisherStateStore(options.publisherState).load();
  if (!publisherState || publisherState.event !== base.manifest.event || publisherState.generationId !== base.lifecycleState.generationId || Object.keys(publisherState.publishers ?? {}).length !== 8) throw new Error("renderer-loss rehearsal synthetic publisher binding is invalid");
  return {
    ...base,
    options,
    venue,
    soakState,
    publisherState,
    compositorHost: compositorHost(base.manifest, base.lifecycleState, options.camera),
    monitor: new MonitorSnapshotRuntime({ origin: `https://${onlyEndpoint(base.manifest, "observability")}`, token: base.monitorToken }),
    fault: new RendererLossFaultRuntime({ sshKey: base.profile.sshKey, knownHosts: base.profile.knownHosts })
  };
}

async function createRestoreRuntime(options) {
  const base = await loadBaseRuntime(options);
  const state = await readProtectedJson(join(options.evidence, "renderer-loss-rehearsal-state.json"), "renderer-loss rehearsal state");
  return { ...base, options, state, fault: new RendererLossFaultRuntime({ sshKey: base.profile.sshKey, knownHosts: base.profile.knownHosts }) };
}

async function loadBaseRuntime(options) {
  const profile = validateProfile(await readProtectedJson(options.profile, "event operator profile"));
  const manifest = await readProtectedJson(profile.manifest, "event manifest");
  validateEventManifest(manifest, await loadManifestInputs({ networkFromManifest: manifest.network }));
  if (manifest.kind !== "production" || manifest.droplets.length !== 12) throw new Error("renderer-loss rehearsal requires the exact production manifest");
  const lifecycleState = await new FileStateStore(profile.state).load();
  if (!lifecycleState || lifecycleState.event !== manifest.event) throw new Error("renderer-loss rehearsal lifecycle state is missing");
  const renderer = await loadRendererBinding(profile.rendererBinding);
  const observability = await loadProtectedEnv(join(profile.secrets, "observability.env"));
  const monitorToken = required(observability.MONITOR_API_TOKEN, "monitor API token");
  return { profile, manifest, lifecycleState, renderer, monitorToken };
}

async function captureStablePhase({ label, requiredStableSamples, timeoutMs = PHASE_TIMEOUT_MS, monitor, profiles, venue, camera, renderer, baseline = null, initialPrevious = null, handle, now, sleep }) {
  const startedMs = now();
  let previous = initialPrevious;
  let stable = 0;
  let firstStable = null;
  let latest = null;
  let sampleCount = 0;
  while (now() - startedMs <= timeoutMs) {
    const snapshot = await monitor.snapshot();
    const problems = rendererLossSnapshotProblems({ phase: label, snapshot, previous, baseline, profiles, venue, camera, renderer, nowMs: now() });
    const sample = { label, observedAt: snapshot.generatedAt, monitor: snapshot, problems };
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
  throw new Error(`${label} renderer-loss evidence did not stabilize: ${(latest?.problems ?? ["no sample"]).slice(0, 8).join("; ")}`);
}

async function safetyRestoreRenderer({ fault, target, confirmation }) {
  try {
    const before = await fault.inspect(target);
    if (before.status === "HEALTHY") return { passed: true, before, restore: null };
    const restore = await fault.restore({ target, confirmation });
    return { passed: restore.status === "HEALTHY", before, restore };
  } catch (error) {
    return { passed: false, error: safeError(error) };
  }
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
    throw new Error("renderer-loss evidence directory already exists");
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
  try { return await readProtectedJson(path, "renderer-loss evidence"); }
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

function compositorHost(manifest, lifecycleState, camera) {
  const spec = manifest.droplets.find((entry) => entry.role === "compositor" && entry.court === camera);
  const host = spec ? lifecycleState.droplets?.[spec.name]?.publicIpv4 : null;
  if (!host) throw new Error(`renderer-loss rehearsal has no Camera ${camera} compositor IPv4`);
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
  return { classification: report.classification, event: report.event, generationId: report.generationId, camera: report.camera, gateId: report.gateId, transitions: report.transitions, browser: report.browser, problems: report.problems };
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

function kebab(value) { return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`); }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]+/gu, " ").slice(0, 500); }
function isDirectInvocation() { return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url; }

function usage() {
  process.stdout.write("Usage:\n  node infra/event-stack/renderer-loss-rehearsal.mjs run --profile FILE --soak-evidence DIR --publisher-state FILE --evidence DIR --camera N --confirm-fault FAULT-RENDERER:EVENT:CAMERA-N --confirm-restore RESTORE-RENDERER:EVENT:CAMERA-N\n  node infra/event-stack/renderer-loss-rehearsal.mjs restore --profile FILE --evidence DIR --confirm-restore RESTORE-RENDERER:EVENT:CAMERA-N\n  node infra/event-stack/renderer-loss-rehearsal.mjs status --evidence DIR\n");
}
