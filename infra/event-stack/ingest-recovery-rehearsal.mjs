#!/usr/bin/env node

import { chmod, lstat, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateProfile } from "./eventctl.mjs";
import { loadManifestInputs, validateEventManifest } from "./event-manifest.mjs";
import { FileStateStore, validateAnchorConfig } from "./event-lifecycle.mjs";
import { FileIngestRecoveryStateStore, IngestRecoveryController, recoveryTopology, validateRecoveryState } from "./ingest-recovery.mjs";
import { IngestRecoveryFaultRuntime } from "./ingest-recovery-fault-runtime.mjs";
import { LocalIngestRecoveryPlatform } from "./ingest-recovery-platform.mjs";
import { assertNetworkContractDeployable } from "./network-contract.mjs";
import { productionProviderProblems, productionSnapshotProblems } from "./production-soak.mjs";
import { ProductionSyntheticPublisherStateStore } from "./production-synthetic-publishers.mjs";
import { ProductionYouTubeProvider, readProductionDestinations } from "./production-youtube.mjs";
import { DigitalOceanProvider } from "./providers.mjs";
import { SyntheticPublisherManager } from "./rehearsal/synthetic-publishers.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { loadVenueAdmission } from "./venue-admission.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const MAX_RTO_MS = 5 * 60_000;
const STABLE_SAMPLES = 6;
const SAMPLE_INTERVAL_MS = 5_000;
const MAX_SYNTHETIC_RESTARTS = 30;

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
    const report = await readReportOrNull(join(options.evidence, "ingest-recovery-rehearsal-report.json"));
    process.stdout.write(`${JSON.stringify(report ?? { status: "NOT_COMPLETE" }, null, 2)}\n`);
    return;
  }
  const runtime = await createRuntime(options);
  const report = await runIngestRecoveryRehearsal(runtime);
  process.stdout.write(`${JSON.stringify(publicReport(report), null, 2)}\n`);
}

export async function runIngestRecoveryRehearsal(runtime) {
  const { options, manifest, lifecycleState, venue, destinations, recoveryStore, publisherStore, publishers, platform, fault, youtube, monitor, now = () => Date.now(), sleep = delay } = runtime;
  requireConfirmation(options.confirmFault, `FAULT-PRIMARY-INGEST:${manifest.event}`);
  requireConfirmation(options.confirmTakeover, `TAKEOVER-INGEST:${manifest.event}`);
  requireConfirmation(options.confirmRestore, `RESTORE-PRIMARY-INGEST:${manifest.event}`);
  requireConfirmation(options.confirmRollback, `ROLLBACK-INGEST:${manifest.event}`);
  if (lifecycleState.phase !== "live") throw new Error("ingest recovery rehearsal requires live lifecycle state");
  if (JSON.stringify(venue.activeCameras) !== JSON.stringify(Array.from({ length: 8 }, (_, index) => index + 1))) throw new Error("ingest recovery rehearsal requires eight active synthetic cameras");
  await prepareEvidenceDirectory(options.evidence);
  const samplePath = join(options.evidence, "ingest-recovery-rehearsal-samples.jsonl");
  const handle = await open(samplePath, "a", 0o600);
  await chmod(samplePath, 0o600);
  const publisherState = await publisherStore.load();
  if (!publisherState || publisherState.phase !== "RUNNING" || publisherState.event !== manifest.event || publisherState.generationId !== lifecycleState.generationId) throw new Error("eight production synthetic publishers are not running for this generation");
  const baselinePublisherHealth = await publishers.waitForHealthy(Object.values(publisherState.publishers));
  const controller = new IngestRecoveryController({ platform, checkpoint: (state) => recoveryStore.save(state) });
  let recovery = await recoveryStore.load();
  let faultStartedAt = null;
  let faultEvidence = null;
  let restoreStartedAt = null;
  let restoreEvidence = null;
  try {
    recovery = await recoveryStore.withLock(() => controller.prepare({ manifest, lifecycleState, anchors: runtime.anchors, state: recovery }));
    const baseline = await captureStableEvidence({ label: "baseline", monitor, youtube, destinations, venue, profiles: runtime.soakState.profiles, handle, now, sleep });
    faultStartedAt = new Date(now()).toISOString();
    faultEvidence = await fault.inject({
      host: recovery.topology.primary.publicIpv4,
      event: manifest.event,
      recoveryId: recovery.recoveryId,
      confirmation: options.confirmFault
    });
    recovery = await recoveryStore.withLock(async () => controller.takeover({ state: await recoveryStore.load(), confirmation: options.confirmTakeover }));
    const activeOnSpare = await captureStableEvidence({ label: "active-on-spare", monitor, youtube, destinations, venue, profiles: runtime.soakState.profiles, handle, now, sleep });
    restoreStartedAt = new Date(now()).toISOString();
    restoreEvidence = await fault.restore({
      host: recovery.topology.primary.publicIpv4,
      event: manifest.event,
      recoveryId: recovery.recoveryId,
      confirmation: options.confirmRestore
    });
    recovery = await recoveryStore.withLock(async () => controller.rollback({ state: await recoveryStore.load(), confirmation: options.confirmRollback }));
    const rolledBack = await captureStableEvidence({ label: "rolled-back", monitor, youtube, destinations, venue, profiles: runtime.soakState.profiles, handle, now, sleep });
    const finalPublisherHealth = await publishers.waitForHealthy(Object.values(publisherState.publishers), { maximumRestartCount: MAX_SYNTHETIC_RESTARTS });
    const report = evaluateIngestRecoveryRehearsal({
      manifest,
      lifecycleState,
      recovery,
      faultStartedAt,
      faultEvidence,
      restoreStartedAt,
      restoreEvidence,
      baseline,
      activeOnSpare,
      rolledBack,
      baselinePublisherHealth,
      finalPublisherHealth,
      completedAt: new Date(now()).toISOString()
    });
    await writeProtected(join(options.evidence, "ingest-recovery-rehearsal-report.json"), report);
    return report;
  } catch (error) {
    const safetyRecovery = faultStartedAt
      ? await restorePrimaryAfterFailedRehearsal({ recoveryStore, controller, fault, manifest, options })
      : null;
    const state = safetyRecovery?.state ?? await recoveryStore.load().catch(() => recovery);
    const safetyEvidence = safetyRecovery
      ? { passed: safetyRecovery.passed, actions: safetyRecovery.actions, recovery: safetyRecovery.recovery, error: safetyRecovery.error }
      : null;
    const failure = {
      schemaVersion: 1,
      classification: "FAIL",
      event: manifest.event,
      observedAt: new Date(now()).toISOString(),
      error: safeError(error),
      recovery: state ? recoverySummary(state) : null,
      fault: faultStartedAt ? { faultStartedAt, faultEvidence, restoreStartedAt, restoreEvidence } : null,
      safetyRecovery: safetyEvidence
    };
    await writeProtected(join(options.evidence, "ingest-recovery-rehearsal-failure.json"), failure).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

export async function restorePrimaryAfterFailedRehearsal({ recoveryStore, controller, fault, manifest, options }) {
  const actions = [];
  try {
    let recovery = await recoveryStore.load();
    if (!recovery) throw new Error("recovery state is missing");
    const resumeTakeover = recovery.phase === "TAKING_OVER" || (recovery.phase === "FAILED" && recovery.resumePhase === "TAKING_OVER");
    if (resumeTakeover) {
      recovery = await recoveryStore.withLock(async () => controller.takeover({
        state: await recoveryStore.load(),
        confirmation: options.confirmTakeover
      }));
      actions.push("takeover-resumed");
    }
    const resumeRollback = recovery.phase === "ROLLING_BACK" || (recovery.phase === "FAILED" && recovery.resumePhase === "ROLLING_BACK");
    if (recovery.phase === "ACTIVE_ON_SPARE" || resumeRollback) {
      await fault.restore({
        host: recovery.topology.primary.publicIpv4,
        event: manifest.event,
        recoveryId: recovery.recoveryId,
        confirmation: options.confirmRestore
      });
      actions.push("primary-services-restored");
      recovery = await recoveryStore.withLock(async () => controller.rollback({
        state: await recoveryStore.load(),
        confirmation: options.confirmRollback
      }));
      actions.push("rollback-completed");
    } else if (new Set(["PREPARING", "PREPARED"]).has(recovery.phase)) {
      await fault.restore({
        host: recovery.topology.primary.publicIpv4,
        event: manifest.event,
        recoveryId: recovery.recoveryId,
        confirmation: options.confirmRestore
      });
      actions.push("primary-services-restored");
    } else if (recovery.phase !== "ROLLED_BACK") {
      throw new Error(`cannot safely restore from recovery phase ${recovery.phase}`);
    }
    return {
      passed: recovery.phase === "ROLLED_BACK" || new Set(["PREPARING", "PREPARED"]).has(recovery.phase),
      actions,
      state: recovery,
      recovery: recoverySummary(recovery),
      error: null
    };
  } catch (error) {
    const recovery = await recoveryStore.load().catch(() => null);
    return {
      passed: false,
      actions,
      state: recovery,
      recovery: recovery ? recoverySummary(recovery) : null,
      error: safeError(error)
    };
  }
}

export function evaluateIngestRecoveryRehearsal({ manifest, lifecycleState, recovery, faultStartedAt, faultEvidence, restoreStartedAt, restoreEvidence, baseline, activeOnSpare, rolledBack, baselinePublisherHealth, finalPublisherHealth, completedAt }) {
  validateRecoveryState(recovery);
  const takeoverQualifiedAt = timelineAt(recovery, "takeover-qualified");
  const rollbackQualifiedAt = timelineAt(recovery, "rollback-qualified");
  const takeoverRtoMs = Date.parse(takeoverQualifiedAt) - Date.parse(faultStartedAt);
  const rollbackRtoMs = Date.parse(rollbackQualifiedAt) - Date.parse(restoreStartedAt);
  const problems = [];
  if (manifest?.kind !== "production" || lifecycleState?.event !== manifest.event) problems.push("production event binding is invalid");
  if (recovery.phase !== "ROLLED_BACK" || recovery.activeHost !== "primary") problems.push("recovery did not return to the primary ingest");
  if (faultEvidence?.status !== "FAULTED") problems.push("primary ingest fault was not durably observed");
  if (restoreEvidence?.status !== "HEALTHY") problems.push("primary ingest restoration was not durably observed");
  if (!Number.isFinite(takeoverRtoMs) || takeoverRtoMs < 0 || takeoverRtoMs > MAX_RTO_MS) problems.push(`takeover RTO ${takeoverRtoMs}ms exceeds ${MAX_RTO_MS}ms`);
  if (!Number.isFinite(rollbackRtoMs) || rollbackRtoMs < 0 || rollbackRtoMs > MAX_RTO_MS) problems.push(`rollback RTO ${rollbackRtoMs}ms exceeds ${MAX_RTO_MS}ms`);
  for (const evidence of [baseline, activeOnSpare, rolledBack]) if (evidence?.passed !== true) problems.push(`${evidence?.label ?? "unknown"} stable evidence did not pass`);
  if (baselinePublisherHealth?.passed !== true) problems.push("synthetic publishers were not healthy before the fault");
  if (finalPublisherHealth?.passed !== true) problems.push("synthetic publishers did not recover within their bounded restart budget");
  return {
    schemaVersion: 1,
    classification: problems.length ? "FAIL" : "PASS",
    event: manifest.event,
    generationId: lifecycleState.generationId,
    recoveryId: recovery.recoveryId,
    startedAt: faultStartedAt,
    completedAt,
    takeover: { qualifiedAt: takeoverQualifiedAt, rtoMs: takeoverRtoMs, maximumRtoMs: MAX_RTO_MS },
    rollback: { qualifiedAt: rollbackQualifiedAt, rtoMs: rollbackRtoMs, maximumRtoMs: MAX_RTO_MS },
    recovery: recoverySummary(recovery),
    stableEvidence: { baseline, activeOnSpare, rolledBack },
    publishers: { baseline: baselinePublisherHealth, final: finalPublisherHealth },
    problems
  };
}

async function createRuntime(options) {
  const profile = validateProfile(await readProtectedJson(options.profile, "event operator profile"));
  const manifest = await readProtectedJson(profile.manifest, "event manifest");
  validateEventManifest(manifest, await loadManifestInputs({ networkFromManifest: manifest.network }));
  assertNetworkContractDeployable(manifest.network);
  if (manifest.kind !== "production" || manifest.droplets.length !== 12) throw new Error("ingest recovery rehearsal requires the exact production manifest");
  const lifecycleState = await new FileStateStore(profile.state).load();
  if (!lifecycleState || lifecycleState.event !== manifest.event) throw new Error("ingest recovery rehearsal lifecycle state is missing");
  const anchors = validateAnchorConfig(await readProtectedJson(profile.anchors, "endpoint anchors"), manifest);
  recoveryTopology(manifest, lifecycleState, anchors);
  const venue = await loadVenueAdmission(profile.venueProfile, manifest.event);
  if (!venue.passed) throw new Error(`venue profile is not admitted: ${venue.problems.join("; ")}`);
  const soakState = await readProtectedJson(join(options.soakEvidence, "production-soak-state.json"), "production soak state");
  if (soakState?.phase !== "RUNNING" || soakState.event !== manifest.event || JSON.stringify(soakState.activeCameras) !== JSON.stringify(venue.activeCameras)) throw new Error("production soak workload is not running for this event");
  const destinations = await readProductionDestinations(options.destinations, { event: manifest.event, activeCameras: venue.activeCameras });
  const credentials = { ...process.env, ...await loadProtectedEnv(profile.credentialsEnv) };
  const observability = await loadProtectedEnv(join(profile.secrets, "observability.env"));
  const cloud = new DigitalOceanProvider({ token: required(credentials, "DIGITALOCEAN_TOKEN"), sshKeys: [], cloudInitPaths: {} });
  const platform = new LocalIngestRecoveryPlatform({
    repoRoot: REPO_ROOT,
    manifest,
    lifecycleState,
    anchors,
    secretsDirectory: profile.secrets,
    sshPrivateKey: profile.sshKey,
    knownHostsPath: profile.knownHosts,
    ingestTlsStateDirectory: profile.ingestTlsState,
    acmeEmail: required(credentials, "SCORECHECK_ACME_EMAIL"),
    cloud
  });
  await platform.assertProtectedInputs();
  return {
    options,
    profile,
    manifest,
    lifecycleState,
    anchors,
    venue,
    destinations,
    soakState,
    platform,
    recoveryStore: new FileIngestRecoveryStateStore(options.recoveryState),
    publisherStore: new ProductionSyntheticPublisherStateStore(options.publisherState),
    publishers: new SyntheticPublisherManager(),
    fault: new IngestRecoveryFaultRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts }),
    youtube: new ProductionYouTubeProvider({
      clientId: required(credentials, "YOUTUBE_CLIENT_ID"),
      clientSecret: required(credentials, "YOUTUBE_CLIENT_SECRET"),
      refreshToken: required(credentials, "YOUTUBE_REFRESH_TOKEN")
    }),
    monitor: new MonitorSnapshotRuntime({ origin: `https://${onlyEndpoint(manifest, "observability")}`, token: required(observability, "MONITOR_API_TOKEN") })
  };
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

async function captureStableEvidence({ label, monitor, youtube, destinations, venue, profiles, handle, now, sleep }) {
  const startedAt = now();
  let previous = null;
  let stable = 0;
  let latest = null;
  const samples = [];
  while (now() - startedAt <= 3 * 60_000) {
    const snapshot = await monitor.snapshot();
    const provider = await providerEvidence(youtube, destinations, venue.activeCameras, now());
    const problems = [
      ...productionSnapshotProblems(snapshot, profiles, venue, previous, now()),
      ...productionProviderProblems(provider, venue.activeCameras),
      ...recoverySnapshotProblems(snapshot)
    ];
    const sample = { label, observedAt: snapshot.generatedAt, monitor: snapshot, provider, problems: [...new Set(problems)] };
    samples.push(sample);
    await handle.write(`${JSON.stringify(sample)}\n`);
    await handle.sync();
    latest = sample;
    if (sample.problems.length === 0) {
      stable += 1;
      if (stable >= STABLE_SAMPLES) return { label, passed: true, startedAt: samples.at(-STABLE_SAMPLES).observedAt, completedAt: sample.observedAt, stableSamples: STABLE_SAMPLES, sampleCount: samples.length, final: sample };
    } else stable = 0;
    previous = snapshot;
    await sleep(SAMPLE_INTERVAL_MS);
  }
  throw new Error(`${label} did not stabilize: ${(latest?.problems ?? ["no sample"]).slice(0, 8).join("; ")}`);
}

async function providerEvidence(youtube, destinations, cameras, nowMs) {
  const output = [];
  for (const camera of cameras) output.push({ camera, stream: await youtube.getStream(destinations.streams[camera].id), broadcast: await youtube.getBroadcast(destinations.broadcasts[camera].id) });
  return { observedAt: new Date(nowMs).toISOString(), cameras: output };
}

function recoverySnapshotProblems(snapshot) {
  const problems = [];
  if (snapshot.collector?.state !== "HEALTHY" || snapshot.collector?.agentsExpected !== 12 || snapshot.collector?.agentsFresh !== 12) problems.push("monitor collector does not have twelve healthy agents");
  if ((snapshot.faultGates ?? []).length) problems.push("monitor has an unexpected fault gate");
  if ((snapshot.incidents ?? []).some((incident) => !incident.resolvedAt && incident.status !== "RESOLVED")) problems.push("monitor retains an active incident after stabilization");
  return problems;
}

export function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["run", "status"]).has(command)) throw new Error("first argument must be run or status");
  const options = { command, profile: null, destinations: null, soakEvidence: null, publisherState: null, recoveryState: null, evidence: null, confirmFault: null, confirmTakeover: null, confirmRestore: null, confirmRollback: null };
  const mappings = new Map([
    ["--profile", "profile"], ["--destinations", "destinations"], ["--soak-evidence", "soakEvidence"], ["--publisher-state", "publisherState"], ["--recovery-state", "recoveryState"], ["--evidence", "evidence"],
    ["--confirm-fault", "confirmFault"], ["--confirm-takeover", "confirmTakeover"], ["--confirm-restore", "confirmRestore"], ["--confirm-rollback", "confirmRollback"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mappings.get(flag);
    const raw = argv[++index];
    if (!key || !raw || raw.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    if (options[key] !== null) throw new Error(`${flag} may be specified only once`);
    options[key] = key.startsWith("confirm") ? raw : normalizedAbsolute(raw, flag);
  }
  if (command === "status") {
    if (!options.evidence) throw new Error("--evidence is required for status");
    if (Object.entries(options).some(([key, value]) => !["command", "evidence"].includes(key) && value !== null)) throw new Error("status accepts only --evidence");
    return options;
  }
  for (const key of ["profile", "destinations", "soakEvidence", "publisherState", "recoveryState", "evidence", "confirmFault", "confirmTakeover", "confirmRestore", "confirmRollback"]) if (!options[key]) throw new Error(`--${kebab(key)} is required for run`);
  return options;
}

function timelineAt(state, event) {
  const matches = state.timeline.filter((entry) => entry.event === event);
  if (matches.length !== 1) throw new Error(`recovery timeline requires exactly one ${event}`);
  return matches[0].at;
}

function recoverySummary(state) {
  return { phase: state.phase, activeHost: state.activeHost, startedAt: state.startedAt, preparedAt: state.preparedAt, updatedAt: state.updatedAt, completedSteps: state.timeline.map((entry) => entry.event) };
}

async function prepareEvidenceDirectory(path) {
  try {
    const information = await stat(path);
    if (!information.isDirectory() || (information.mode & 0o077) !== 0) throw new Error("recovery rehearsal evidence directory must be protected");
    if (await readReportOrNull(join(path, "ingest-recovery-rehearsal-report.json"))) throw new Error("recovery rehearsal evidence is already complete");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await chmod(path, 0o700);
}

async function readReportOrNull(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readProtectedJson(path, label) {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected regular file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeProtected(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

function publicReport(report) {
  return { classification: report.classification, event: report.event, generationId: report.generationId, recoveryId: report.recoveryId, takeover: report.takeover, rollback: report.rollback, problems: report.problems };
}

function onlyEndpoint(manifest, role) {
  const values = manifest.endpoints.filter((entry) => entry.role === role);
  if (values.length !== 1 || typeof values[0].hostname !== "string") throw new Error(`production manifest requires exactly one ${role} endpoint`);
  return values[0].hostname;
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`);
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}

function kebab(value) { return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`); }

function isDirectInvocation() { return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url; }

function usage() {
  process.stdout.write(`Usage:\n  node infra/event-stack/ingest-recovery-rehearsal.mjs run --profile FILE --destinations FILE --soak-evidence DIR --publisher-state FILE --recovery-state FILE --evidence DIR --confirm-fault FAULT-PRIMARY-INGEST:EVENT --confirm-takeover TAKEOVER-INGEST:EVENT --confirm-restore RESTORE-PRIMARY-INGEST:EVENT --confirm-rollback ROLLBACK-INGEST:EVENT\n  node infra/event-stack/ingest-recovery-rehearsal.mjs status --evidence DIR\n`);
}
