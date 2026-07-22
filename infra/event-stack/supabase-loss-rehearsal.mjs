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
import { withQualificationGateLock } from "./qualification-gate-lock.mjs";
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
  if (options.command === "prepare") {
    const runtime = await createPrepareRuntime(options);
    const result = await withQualificationGateLock(
      { ...runtime, gate: "Supabase-loss prepare" },
      () => prepareSupabaseLossRehearsal(runtime)
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.command === "restore") {
    const runtime = await createRestoreRuntime(options);
    const result = await withQualificationGateLock(
      { ...runtime, gate: "Supabase-loss restore" },
      () => restoreInterruptedSupabaseLoss(runtime)
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.command === "cleanup") {
    const runtime = await createCleanupRuntime(options);
    const result = await withQualificationGateLock(
      { ...runtime, gate: "Supabase-loss cleanup" },
      () => cleanupSupabaseLossRehearsal(runtime)
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const runtime = await createRuntime(options);
  const result = await withQualificationGateLock(
    { ...runtime, gate: "Supabase-loss run" },
    () => runSupabaseLossRehearsal(runtime)
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function prepareSupabaseLossRehearsal(runtime) {
  const { options, manifest, lifecycleState, renderer, monitor, fault, target, now = () => Date.now() } = runtime;
  requireConfirmation(options.confirmPrepare, `PREPARE-SUPABASE-FAULT:${manifest.event}`);
  if (lifecycleState.phase !== "live") throw new Error("Supabase-loss preparation requires lifecycle phase live");
  assertAllEgressIdle(await monitor.snapshot());
  await prepareEvidenceDirectory(options.evidence);
  const statePath = join(options.evidence, "supabase-loss-rehearsal-state.json");
  let state = {
    schemaVersion: 1,
    event: manifest.event,
    generationId: lifecycleState.generationId,
    camera: options.camera,
    renderer,
    phase: "PREPARING",
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
    return publicState(state);
  } catch (error) {
    state.phase = "PREPARE_FAILED";
    state.classification = "FAIL";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state).catch(() => {});
    throw error;
  }
}

export async function runSupabaseLossRehearsal(runtime) {
  const { options, manifest, lifecycleState, renderer, venue, soakState, publisherState, preparedState, monitor, fault, target, now = () => Date.now(), sleep = delay } = runtime;
  requireConfirmation(options.confirmPrepare, `PREPARE-SUPABASE-FAULT:${manifest.event}`);
  requireConfirmation(options.confirmFault, `FAULT-SUPABASE:${lifecycleState.generationId}`);
  requireConfirmation(options.confirmRestore, `RESTORE-SUPABASE:${lifecycleState.generationId}`);
  if (lifecycleState.phase !== "live") throw new Error("Supabase-loss rehearsal requires lifecycle phase live");
  if (soakState.phase !== "RUNNING") throw new Error("Supabase-loss rehearsal requires a running production soak");
  if (publisherState.phase !== "RUNNING") throw new Error("Supabase-loss rehearsal requires active synthetic publishers");
  const statePath = join(options.evidence, "supabase-loss-rehearsal-state.json");
  const samplesPath = join(options.evidence, "supabase-loss-rehearsal-samples.jsonl");
  const handle = await open(samplesPath, "wx", 0o600);
  await chmod(samplesPath, 0o600);
  let state = {
    ...preparedState,
    phase: "PLANNED",
    profile: soakState.profiles[options.camera],
    updatedAt: new Date(now()).toISOString(),
    baseline: null,
    fault: null,
    outage: null,
    restore: null,
    recovery: null,
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
    state.phase = "RECOVERED_PENDING_CLEANUP";
    state.updatedAt = new Date(now()).toISOString();
    await writeState(statePath, state);
    return publicState(state);
  } catch (error) {
    const safety = await safetyRestore({ fault, target, restoreConfirmation: options.confirmRestore });
    state.phase = safety.restore?.status === "HEALTHY" || safety.inspect?.status === "HEALTHY"
      ? "FAILED_RESTORED_PENDING_CLEANUP"
      : "FAILED_FAULTED";
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
  if (["COMPLETE", "RECOVERED_PENDING_CLEANUP", "RESTORED_AFTER_INTERRUPT_PENDING_CLEANUP"].includes(state.phase)) throw new Error(`Supabase-loss rehearsal is already ${state.phase.toLowerCase()}`);
  requireConfirmation(options.confirmRestore, `RESTORE-SUPABASE:${state.generationId}`);
  const result = await safetyRestore({ fault, target: state.target, restoreConfirmation: options.confirmRestore });
  if (result.restore?.status !== "HEALTHY" && result.inspect?.status !== "HEALTHY") throw new Error("Supabase-loss interrupted recovery did not restore the dependency");
  const next = { ...state, phase: "RESTORED_AFTER_INTERRUPT_PENDING_CLEANUP", updatedAt: new Date().toISOString() };
  await writeState(join(options.evidence, "supabase-loss-rehearsal-state.json"), next);
  return { status: "HEALTHY", event: state.event, camera: state.camera, phase: next.phase };
}

export async function cleanupSupabaseLossRehearsal(runtime) {
  const { options, manifest, lifecycleState, state, monitor, fault, now = () => Date.now() } = runtime;
  if (state.event !== manifest.event || state.generationId !== lifecycleState.generationId) throw new Error("Supabase-loss cleanup state does not match the event generation");
  if (state.phase === "COMPLETE") throw new Error("Supabase-loss rehearsal is already complete");
  if (state.phase === "FAILED_FAULTED") throw new Error("Supabase-loss dependency must be restored before cleanup");
  if (!["PREPARED", "RECOVERED_PENDING_CLEANUP", "FAILED_RESTORED_PENDING_CLEANUP", "RESTORED_AFTER_INTERRUPT_PENDING_CLEANUP"].includes(state.phase)) {
    throw new Error(`Supabase-loss cleanup cannot run from ${state.phase}`);
  }
  requireConfirmation(options.confirmCleanup, `CLEANUP-SUPABASE-FAULT:${state.event}`);
  assertAllEgressIdle(await monitor.snapshot());
  const cleanup = await fault.cleanup({ target: state.target, confirmation: options.confirmCleanup });
  const completedAt = new Date(now()).toISOString();
  let next = { ...state, cleanup, updatedAt: completedAt };
  let report = null;
  if (state.phase === "RECOVERED_PENDING_CLEANUP") {
    report = evaluateSupabaseLossRehearsal({
      event: state.event,
      generationId: state.generationId,
      camera: state.camera,
      renderer: state.renderer,
      profile: state.profile,
      target: state.target,
      prepare: state.prepare,
      fault: state.fault,
      restore: state.restore,
      cleanup,
      baseline: state.baseline,
      outage: state.outage,
      recovery: state.recovery,
      completedAt
    });
    await writeProtected(join(options.evidence, "supabase-loss-rehearsal-report.json"), report);
    next = { ...next, phase: "COMPLETE", classification: report.classification };
  } else {
    next = { ...next, phase: "COMPLETE", classification: "FAIL" };
  }
  await writeState(join(options.evidence, "supabase-loss-rehearsal-state.json"), next);
  return report ?? publicState(next);
}

export function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["prepare", "run", "status", "restore", "cleanup"]).has(command)) throw new Error("first argument must be prepare, run, status, restore, or cleanup");
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
  if (!options.profile) throw new Error("--profile is required");
  if (command === "prepare") {
    for (const key of ["rendererBinding", "camera", "confirmPrepare"]) if (options[key] === null) throw new Error(`--${kebab(key)} is required`);
    const extras = ["soakEvidence", "publisherState", "confirmFault", "confirmRestore", "confirmCleanup"].filter((key) => options[key] !== null);
    if (extras.length) throw new Error("prepare accepts only --profile, --renderer-binding, --evidence, --camera, and --confirm-prepare");
    if (!Number.isInteger(options.camera) || options.camera < 1 || options.camera > 8) throw new Error("--camera must be 1-8");
    return options;
  }
  if (command === "restore") {
    if (!options.confirmRestore) throw new Error("--confirm-restore is required");
    const extras = ["soakEvidence", "publisherState", "rendererBinding", "camera", "confirmPrepare", "confirmFault", "confirmCleanup"].filter((key) => options[key] !== null);
    if (extras.length) throw new Error("restore accepts only --profile, --evidence, and --confirm-restore");
    return options;
  }
  if (command === "cleanup") {
    if (!options.confirmCleanup) throw new Error("--confirm-cleanup is required");
    const extras = ["soakEvidence", "publisherState", "rendererBinding", "camera", "confirmPrepare", "confirmFault", "confirmRestore"].filter((key) => options[key] !== null);
    if (extras.length) throw new Error("cleanup accepts only --profile, --evidence, and --confirm-cleanup");
    return options;
  }
  for (const key of ["soakEvidence", "publisherState", "rendererBinding", "camera", "confirmPrepare", "confirmFault", "confirmRestore"]) if (options[key] === null) throw new Error(`--${kebab(key)} is required`);
  if (options.confirmCleanup !== null) throw new Error("run does not accept --confirm-cleanup; cleanup is a separate post-output command");
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
  const preparedState = await readProtectedJson(join(options.evidence, "supabase-loss-rehearsal-state.json"), "Supabase-loss prepared state");
  const assets = await createFaultAssets(base);
  assertPreparedState(preparedState, base, renderer, options.camera, assets.target);
  return {
    ...base,
    options,
    renderer,
    venue,
    soakState,
    publisherState,
    preparedState,
    target: preparedState.target,
    monitor: assets.monitor,
    fault: assets.fault
  };
}

async function createPrepareRuntime(options) {
  const base = await loadBaseRuntime(options);
  const renderer = await loadRendererBinding(options.rendererBinding);
  return { ...base, options, renderer, ...await createFaultAssets(base) };
}

async function createFaultAssets(base) {
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

async function createCleanupRuntime(options) {
  const base = await loadBaseRuntime(options);
  const state = await readProtectedJson(join(options.evidence, "supabase-loss-rehearsal-state.json"), "Supabase-loss rehearsal state");
  const assets = await createFaultAssets(base);
  assertTargetCompatible(state.target, assets.target);
  return { ...base, options, state, monitor: assets.monitor, fault: assets.fault };
}

function assertPreparedState(state, base, renderer, camera, currentTarget) {
  if (state?.phase !== "PREPARED") throw new Error("Supabase-loss rehearsal requires an explicit prepared proxy state");
  if (state.event !== base.manifest.event || state.generationId !== base.lifecycleState.generationId || state.camera !== camera) throw new Error("Supabase-loss prepared state does not match the event generation and camera");
  if (state.renderer?.gitSha !== renderer.gitSha || state.renderer?.deploymentId !== renderer.deploymentId || state.renderer?.origin !== renderer.origin) throw new Error("Supabase-loss prepared renderer binding is stale");
  assertTargetCompatible(state.target, currentTarget);
}

function assertTargetCompatible(target, current) {
  const fields = ["host", "publicHost", "event", "generationId", "upstreamOrigin", "pathPrefix", "publicOrigin", "baselineConfigSha256", "proxyScriptSha256", "serviceScriptSha256"];
  for (const field of fields) if (target?.[field] !== current?.[field]) throw new Error(`Supabase-loss prepared target ${field} is stale`);
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

async function safetyRestore({ fault, target, restoreConfirmation }) {
  const result = { inspect: null, restore: null };
  try {
    result.inspect = await fault.inspect(target);
    if (result.inspect.status === "FAULTED") result.restore = await fault.restore({ target, confirmation: restoreConfirmation });
  } catch (error) {
    result.error = safeError(error);
  }
  return result;
}

function assertAllEgressIdle(snapshot) {
  const agents = snapshot?.agents?.filter((agent) => agent.nativeServices?.egress) ?? [];
  if (agents.length === 0 || agents.some((agent) => agent.state !== "HEALTHY")) throw new Error("Supabase-loss route mutation requires current healthy Egress agent telemetry");
  if (agents.some((agent) => agent.nativeServices.egress.idle !== true || agent.nativeServices.egress.activeWebRequests !== 0)) {
    throw new Error("Supabase-loss route mutation is blocked while any Egress output is active");
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
  process.stdout.write("usage:\n  supabase-loss-rehearsal.mjs prepare --profile <event-profile> --renderer-binding <file> --evidence <new-dir> --camera <1-8> --confirm-prepare <token>\n  supabase-loss-rehearsal.mjs run --profile <event-profile> --soak-evidence <dir> --publisher-state <file> --renderer-binding <file> --evidence <prepared-dir> --camera <1-8> --confirm-prepare <token> --confirm-fault <token> --confirm-restore <token>\n  supabase-loss-rehearsal.mjs status --evidence <dir>\n  supabase-loss-rehearsal.mjs restore --profile <event-profile> --evidence <dir> --confirm-restore <token>\n  supabase-loss-rehearsal.mjs cleanup --profile <event-profile> --evidence <dir> --confirm-cleanup <token>\n");
}
