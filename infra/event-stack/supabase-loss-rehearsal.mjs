#!/usr/bin/env node

import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { validateProfile } from "./eventctl.mjs";
import { loadManifestInputs, validateEventManifest } from "./event-manifest.mjs";
import { FileStateStore } from "./event-lifecycle.mjs";
import { ProductionSyntheticPublisherStateStore } from "./production-synthetic-publishers.mjs";
import { loadRendererBinding } from "./renderer-binding.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { evaluateSupabaseLossRehearsal, supabaseLossSnapshotProblems } from "./supabase-loss-evidence.mjs";
import { SupabaseLossFaultRuntime } from "./supabase-loss-fault-runtime.mjs";
import { loadVenueAdmission } from "./venue-admission.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
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
    const state = await readStateOrNull(join(options.evidence, "supabase-loss-rehearsal-state.json"));
    const report = await readStateOrNull(join(options.evidence, "supabase-loss-rehearsal-report.json"));
    process.stdout.write(`${JSON.stringify(report ? publicReport(report) : publicState(state), null, 2)}\n`);
    return;
  }
  if (options.command === "restore") {
    const result = await restoreInterruptedSupabaseLoss(await createRestoreRuntime(options));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const report = await runSupabaseLossRehearsal(await createRuntime(options));
  process.stdout.write(`${JSON.stringify(publicReport(report), null, 2)}\n`);
}

export async function runSupabaseLossRehearsal(runtime) {
  const { options, manifest, lifecycleState, renderer, venue, soakState, publisherState, monitor, fault, target, now = () => Date.now(), sleep = delay } = runtime;
  requireConfirmation(options.confirmPrepare, `PREPARE-SUPABASE-FAULT:${manifest.event}`);
  requireConfirmation(options.confirmFault, `FAULT-SUPABASE:${lifecycleState.generationId}`);
  requireConfirmation(options.confirmRestore, `RESTORE-SUPABASE:${lifecycleState.generationId}`);
  requireConfirmation(options.confirmCleanup, `CLEANUP-SUPABASE-FAULT:${manifest.event}`);
  if (lifecycleState.phase !== "live") throw new Error("Supabase-loss rehearsal requires lifecycle phase live");
  if (soakState.phase !== "RUNNING") throw new Error("Supabase-loss rehearsal requires a running production soak");
  if (publisherState.phase !== "RUNNING") throw new Error("Supabase-loss rehearsal requires active synthetic publishers");
  await prepareEvidenceDirectory(options.evidence);
  const statePath = join(options.evidence, "supabase-loss-rehearsal-state.json");
  const samplesPath = join(options.evidence, "supabase-loss-rehearsal-samples.jsonl");
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
    prepare: null,
    baseline: null,
    fault: null,
    outage: null,
    restore: null,
    recovery: null,
    cleanup: null,
    classification: null
  };
  await writeState(statePath, state);
  try {
    state.prepare = await fault.prepare({ target, confirmation: options.confirmPrepare });
    state.phase = "PREPARED";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    state.baseline = await captureStablePhase({
      label: "baseline", requiredStableSamples: 6, monitor, fault, target, profiles: soakState.profiles, venue, camera: options.camera, renderer, handle, now, sleep
    });
    state.phase = "BASELINE_COMPLETE";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);

    state.fault = await fault.fault({ target, confirmation: options.confirmFault });
    state.phase = "FAULTED";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    state.outage = await captureStablePhase({
      label: "outage", requiredStableSamples: 3, timeoutMs: 90_000, monitor, fault, target, profiles: soakState.profiles, venue, camera: options.camera, renderer,
      baseline: state.baseline.final.monitor, baselineDependency: state.baseline.final.dependency, initialPrevious: state.baseline.final.monitor, handle, now, sleep
    });
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);

    state.restore = await fault.restore({ target, confirmation: options.confirmRestore });
    state.phase = "RESTORED";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    state.recovery = await captureStablePhase({
      label: "recovery", requiredStableSamples: 6, monitor, fault, target, profiles: soakState.profiles, venue, camera: options.camera, renderer,
      baseline: state.baseline.final.monitor, baselineDependency: state.baseline.final.dependency, initialPrevious: state.outage.final.monitor, handle, now, sleep
    });
    state.cleanup = await fault.cleanup({ target, confirmation: options.confirmCleanup });
    state.phase = "CLEANED";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);

    const report = evaluateSupabaseLossRehearsal({
      event: manifest.event,
      generationId: lifecycleState.generationId,
      camera: options.camera,
      renderer,
      profile: soakState.profiles[options.camera],
      target,
      prepare: state.prepare,
      fault: state.fault,
      restore: state.restore,
      cleanup: state.cleanup,
      baseline: state.baseline,
      outage: state.outage,
      recovery: state.recovery,
      completedAt: new Date(now()).toISOString()
    });
    await writeProtected(join(options.evidence, "supabase-loss-rehearsal-report.json"), report);
    state.phase = "COMPLETE";
    state.classification = report.classification;
    state.updatedAt = report.completedAt;
    await writeState(statePath, state);
    return report;
  } catch (error) {
    const safety = await safetyRestoreAndCleanup({ fault, target, restoreConfirmation: options.confirmRestore, cleanupConfirmation: options.confirmCleanup });
    state.phase = "FAILED";
    state.classification = "FAIL";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state).catch(() => {});
    await writeProtected(join(options.evidence, "supabase-loss-rehearsal-failure.json"), {
      schemaVersion: 1,
      classification: "FAIL",
      event: manifest.event,
      generationId: lifecycleState.generationId,
      camera: options.camera,
      observedAt: state.updatedAt,
      error: safeError(error),
      safety
    }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

export async function restoreInterruptedSupabaseLoss(runtime) {
  const { options, manifest, lifecycleState, state, fault } = runtime;
  if (state.event !== manifest.event || state.generationId !== lifecycleState.generationId) throw new Error("Supabase-loss recovery state does not match the event generation");
  if (["COMPLETE", "RESTORED_AFTER_INTERRUPT"].includes(state.phase)) throw new Error(`Supabase-loss rehearsal is already ${state.phase.toLowerCase()}`);
  requireConfirmation(options.confirmRestore, `RESTORE-SUPABASE:${state.generationId}`);
  requireConfirmation(options.confirmCleanup, `CLEANUP-SUPABASE-FAULT:${state.event}`);
  const result = await safetyRestoreAndCleanup({ fault, target: state.target, restoreConfirmation: options.confirmRestore, cleanupConfirmation: options.confirmCleanup });
  if (result.cleanup?.status !== "CLEAN") throw new Error("Supabase-loss interrupted recovery did not clean the host");
  const next = { ...state, phase: "RESTORED_AFTER_INTERRUPT", cleanup: result.cleanup, updatedAt: new Date().toISOString() };
  await writeState(join(options.evidence, "supabase-loss-rehearsal-state.json"), next);
  return { status: "CLEAN", event: state.event, camera: state.camera, phase: next.phase };
}

export function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["run", "status", "restore"]).has(command)) throw new Error("first argument must be run, status, or restore");
  const options = {
    command, profile: null, soakEvidence: null, publisherState: null, rendererBinding: null, evidence: null, camera: null,
    confirmPrepare: null, confirmFault: null, confirmRestore: null, confirmCleanup: null
  };
  const mapping = new Map([
    ["--profile", "profile"], ["--soak-evidence", "soakEvidence"], ["--publisher-state", "publisherState"], ["--renderer-binding", "rendererBinding"],
    ["--evidence", "evidence"], ["--camera", "camera"], ["--confirm-prepare", "confirmPrepare"], ["--confirm-fault", "confirmFault"],
    ["--confirm-restore", "confirmRestore"], ["--confirm-cleanup", "confirmCleanup"]
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
  for (const key of ["profile", "confirmRestore", "confirmCleanup"]) if (!options[key]) throw new Error(`--${kebab(key)} is required`);
  if (command === "restore") {
    const extras = ["soakEvidence", "publisherState", "rendererBinding", "camera", "confirmPrepare", "confirmFault"].filter((key) => options[key] !== null);
    if (extras.length) throw new Error("restore accepts only --profile, --evidence, --confirm-restore, and --confirm-cleanup");
    return options;
  }
  for (const key of ["soakEvidence", "publisherState", "rendererBinding", "camera", "confirmPrepare", "confirmFault"]) if (options[key] === null) throw new Error(`--${kebab(key)} is required`);
  if (!Number.isInteger(options.camera) || options.camera < 1 || options.camera > 8) throw new Error("--camera must be 1-8");
  return options;
}

async function createRuntime(options) {
  const base = await loadBaseRuntime(options);
  const renderer = await loadRendererBinding(options.rendererBinding);
  const venue = await loadVenueAdmission(base.profile.venueProfile, base.manifest.event);
  if (!venue.passed || venue.activeCameras.length !== 8 || !venue.activeCameras.includes(options.camera)) throw new Error("Supabase-loss rehearsal requires eight admitted active synthetic cameras including the target");
  const soakState = await readProtectedJson(join(options.soakEvidence, "production-soak-state.json"), "production soak state");
  if (soakState.event !== base.manifest.event || soakState.phase !== "RUNNING" || JSON.stringify(soakState.activeCameras) !== JSON.stringify(venue.activeCameras)) throw new Error("Supabase-loss rehearsal production soak binding is invalid");
  if (soakState.runBinding?.renderer?.gitSha !== renderer.gitSha || soakState.runBinding?.renderer?.deploymentId !== renderer.deploymentId) throw new Error("Supabase-loss rehearsal soak renderer binding is stale");
  const publisherState = await new ProductionSyntheticPublisherStateStore(options.publisherState).load();
  if (!publisherState || publisherState.event !== base.manifest.event || publisherState.generationId !== base.lifecycleState.generationId || publisherState.phase !== "RUNNING" || Object.keys(publisherState.publishers ?? {}).length !== 8) throw new Error("Supabase-loss rehearsal synthetic publisher binding is invalid");
  const observability = await loadProtectedEnv(join(base.profile.secrets, "observability.env"));
  const publicHost = onlyEndpoint(base.manifest, "observability");
  const host = hostForRole(base.manifest, base.lifecycleState, "observability");
  const caddyfile = await readFile(resolve(REPO_ROOT, "infra/monitoring/Caddyfile"), "utf8");
  const proxyScript = await readFile(resolve(REPO_ROOT, "infra/event-stack/supabase-fault-proxy.mjs"), "utf8");
  const serviceScript = await readFile(resolve(REPO_ROOT, "infra/event-stack/supabase-fault-proxy-service.mjs"), "utf8");
  const fault = new SupabaseLossFaultRuntime({ sshKey: base.profile.sshKey, knownHosts: base.profile.knownHosts });
  const target = fault.plan({
    host,
    publicHost,
    event: base.manifest.event,
    generationId: base.lifecycleState.generationId,
    upstreamOrigin: required(observability.SUPABASE_URL, "Supabase origin"),
    caddyfile,
    proxyScript,
    serviceScript
  });
  return {
    ...base,
    options,
    renderer,
    venue,
    soakState,
    publisherState,
    target,
    monitor: new MonitorSnapshotRuntime({ origin: `https://${publicHost}`, token: required(observability.MONITOR_API_TOKEN, "monitor API token") }),
    fault
  };
}

async function createRestoreRuntime(options) {
  const base = await loadBaseRuntime(options);
  const state = await readProtectedJson(join(options.evidence, "supabase-loss-rehearsal-state.json"), "Supabase-loss rehearsal state");
  return { ...base, options, state, fault: new SupabaseLossFaultRuntime({ sshKey: base.profile.sshKey, knownHosts: base.profile.knownHosts }) };
}

async function loadBaseRuntime(options) {
  const profile = validateProfile(await readProtectedJson(options.profile, "event operator profile"));
  const manifest = await readProtectedJson(profile.manifest, "event manifest");
  validateEventManifest(manifest, await loadManifestInputs({ networkFromManifest: manifest.network }));
  if (manifest.kind !== "production" || manifest.droplets.length !== 12) throw new Error("Supabase-loss rehearsal requires the exact production manifest");
  const lifecycleState = await new FileStateStore(profile.state).load();
  if (!lifecycleState || lifecycleState.event !== manifest.event) throw new Error("Supabase-loss rehearsal lifecycle state is missing");
  return { profile, manifest, lifecycleState };
}

async function captureStablePhase({ label, requiredStableSamples, timeoutMs = PHASE_TIMEOUT_MS, monitor, fault, target, profiles, venue, camera, renderer, baseline = null, baselineDependency = null, initialPrevious = null, handle, now, sleep }) {
  const startedMs = now();
  let previous = initialPrevious;
  let stable = 0;
  let firstStable = null;
  let latest = null;
  let sampleCount = 0;
  while (now() - startedMs <= timeoutMs) {
    const [snapshot, dependency] = await Promise.all([monitor.snapshot(), fault.inspect(target)]);
    const problems = supabaseLossSnapshotProblems({ phase: label, snapshot, dependency, previous, baseline, baselineDependency, profiles, venue, camera, renderer, nowMs: now() });
    const sample = { label, observedAt: snapshot.generatedAt, monitor: snapshot, dependency, problems };
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
  throw new Error(`${label} Supabase-loss evidence did not stabilize: ${(latest?.problems ?? ["no sample"]).slice(0, 8).join("; ")}`);
}

async function safetyRestoreAndCleanup({ fault, target, restoreConfirmation, cleanupConfirmation }) {
  const result = { inspect: null, restore: null, cleanup: null };
  try {
    result.inspect = await fault.inspect(target);
    if (result.inspect.status === "FAULTED") result.restore = await fault.restore({ target, confirmation: restoreConfirmation });
    result.cleanup = await fault.cleanup({ target, confirmation: cleanupConfirmation });
  } catch (error) {
    result.error = safeError(error);
  }
  return result;
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
    throw new Error("Supabase-loss evidence directory already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path, { recursive: false, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writeState(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function writeProtected(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function readProtectedJson(path, label) {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a non-symlink mode-0600 file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readStateOrNull(path) {
  try { return await readProtectedJson(path, "Supabase-loss state"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function publicState(value) {
  if (!value) return { status: "ABSENT" };
  return { status: value.phase, event: value.event, generationId: value.generationId, camera: value.camera, startedAt: value.startedAt, updatedAt: value.updatedAt, classification: value.classification };
}

function publicReport(value) {
  return { classification: value.classification, event: value.event, generationId: value.generationId, camera: value.camera, startedAt: value.startedAt, completedAt: value.completedAt, transitions: value.transitions, browser: value.browser, dependency: value.dependency, problems: value.problems };
}

function hostForRole(manifest, lifecycleState, role) {
  const specs = manifest.droplets.filter((entry) => entry.role === role);
  if (specs.length !== 1) throw new Error(`manifest must contain exactly one ${role} host`);
  const host = lifecycleState.droplets?.[specs[0].name]?.publicIpv4;
  if (typeof host !== "string") throw new Error(`${role} host has no public IPv4 address`);
  return host;
}

function onlyEndpoint(manifest, role) {
  const values = manifest.endpoints.filter((entry) => entry.role === role);
  if (values.length !== 1) throw new Error(`manifest must contain exactly one ${role} endpoint`);
  return values[0].hostname;
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`);
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) throw new Error(`${label} is required`);
  return value.trim();
}

function safeError(error) {
  return { name: error instanceof Error ? error.name : "Error", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
}

function kebab(value) {
  return value.replace(/[A-Z]/gu, (match) => `-${match.toLowerCase()}`);
}

function isDirectInvocation() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function usage() {
  process.stdout.write("usage:\n  supabase-loss-rehearsal.mjs run --profile <event-profile> --soak-evidence <dir> --publisher-state <file> --renderer-binding <file> --evidence <new-dir> --camera <1-8> --confirm-prepare <token> --confirm-fault <token> --confirm-restore <token> --confirm-cleanup <token>\n  supabase-loss-rehearsal.mjs status --evidence <dir>\n  supabase-loss-rehearsal.mjs restore --profile <event-profile> --evidence <dir> --confirm-restore <token> --confirm-cleanup <token>\n");
}
