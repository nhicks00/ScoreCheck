#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateProfile } from "./eventctl.mjs";
import { loadManifestInputs, validateEventManifest } from "./event-manifest.mjs";
import { FileStateStore } from "./event-lifecycle.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { COURTS, SyntheticPublisherManager, buildSyntheticPublisherConfig } from "./rehearsal/synthetic-publishers.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MAX_RECOVERY_RESTARTS = 30;

if (isDirectInvocation()) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const context = await loadContext(options.profile);
  const store = new ProductionSyntheticPublisherStateStore(options.state);
  const manager = new SyntheticPublisherManager();
  const result = options.command === "start"
    ? await startProductionSyntheticPublishers({ options, context, store, manager })
    : options.command === "status"
      ? await statusProductionSyntheticPublishers({ context, store, manager })
      : await stopProductionSyntheticPublishers({ options, context, store, manager });
  process.stdout.write(`${JSON.stringify(publicState(result), null, 2)}\n`);
}

export async function startProductionSyntheticPublishers({ options, context, store, manager, fetchImpl = globalThis.fetch }) {
  requireConfirmation(options.confirm, `START-SYNTHETIC-PUBLISHERS:${context.manifest.event}`);
  requireLifecycle(context, ["live"]);
  let state = await store.load();
  const configurations = buildConfigurations(options, context);
  if (state) {
    validateStateBinding(state, context, options);
    if (state.phase === "RUNNING") return { ...state, health: await manager.observeHealth(Object.values(state.publishers), { maximumRestartCount: MAX_RECOVERY_RESTARTS }) };
    if (state.phase !== "STARTING") throw new Error(`production synthetic publisher state is ${state.phase}`);
  } else {
    await assertRawPathsIdle(context, fetchImpl);
    state = validatePublisherState({
      schemaVersion: 1,
      event: context.manifest.event,
      generationId: context.lifecycleState.generationId,
      phase: "STARTING",
      profile: options.profile,
      evidenceDirectory: options.evidence,
      runtimeDirectory: options.runtime,
      ffmpegPath: options.ffmpeg,
      startedAt: null,
      stoppedAt: null,
      publishers: Object.fromEntries(COURTS.map((court) => [court, { ...configurations[court].redacted, status: "planned" }]))
    });
    await store.save(state);
  }
  await manager.preflight(options.ffmpeg);
  for (const court of COURTS) await manager.prepare(configurations[court]);
  for (const court of COURTS) {
    const running = await manager.ensure(configurations[court]);
    state.publishers[court] = { ...running, status: "running" };
    await store.save(state);
  }
  const health = await manager.waitForHealthy(Object.values(state.publishers));
  state.phase = "RUNNING";
  state.startedAt ??= new Date().toISOString();
  await store.save(state);
  return { ...state, health };
}

export async function statusProductionSyntheticPublishers({ context, store, manager }) {
  requireLifecycle(context, ["ready", "live", "closed"]);
  const state = await store.load();
  if (!state) return null;
  validateStateEvent(state, context);
  const health = state.phase === "RUNNING"
    ? await manager.observeHealth(Object.values(state.publishers), { maximumRestartCount: MAX_RECOVERY_RESTARTS })
    : null;
  return { ...state, health };
}

export async function stopProductionSyntheticPublishers({ options, context, store, manager }) {
  requireConfirmation(options.confirm, `STOP-SYNTHETIC-PUBLISHERS:${context.manifest.event}`);
  requireLifecycle(context, ["ready", "live", "closed"]);
  const state = await store.load();
  if (!state) return null;
  validateStateEvent(state, context);
  if (state.phase === "STOPPED") return state;
  if (!["STARTING", "RUNNING", "STOPPING"].includes(state.phase)) throw new Error(`production synthetic publisher state is ${state.phase}`);
  state.phase = "STOPPING";
  await store.save(state);
  for (const court of [...COURTS].reverse()) {
    await manager.stop({ marker: state.publishers[court].marker });
    state.publishers[court].status = "stopped";
    await store.save(state);
  }
  state.phase = "STOPPED";
  state.stoppedAt = new Date().toISOString();
  await store.save(state);
  return state;
}

export class ProductionSyntheticPublisherStateStore {
  constructor(path) { this.path = normalizedAbsolute(path, "publisher state"); }

  async load() {
    try {
      const information = await lstat(this.path);
      if (!information.isFile() || information.isSymbolicLink() || (information.mode & 0o077) !== 0) throw new Error("publisher state must be a protected regular file");
      return validatePublisherState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(value) {
    const state = validatePublisherState(value);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

export function validatePublisherState(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.event !== "string" || !value.event || !/^[A-Za-z0-9-]{8,80}$/.test(value.generationId ?? "")) throw new Error("production synthetic publisher state identity is invalid");
  if (!new Set(["STARTING", "RUNNING", "STOPPING", "STOPPED"]).has(value.phase)) throw new Error("production synthetic publisher phase is invalid");
  for (const field of ["profile", "evidenceDirectory", "runtimeDirectory", "ffmpegPath"]) normalizedAbsolute(value[field], `publisher state ${field}`);
  if (value.startedAt !== null && !Number.isFinite(Date.parse(value.startedAt))) throw new Error("production synthetic publisher startedAt is invalid");
  if (value.stoppedAt !== null && !Number.isFinite(Date.parse(value.stoppedAt))) throw new Error("production synthetic publisher stoppedAt is invalid");
  if (JSON.stringify(Object.keys(value.publishers ?? {}).map(Number).sort((a, b) => a - b)) !== JSON.stringify(COURTS)) throw new Error("production synthetic publisher inventory is incomplete");
  for (const court of COURTS) {
    const publisher = value.publishers[court];
    if (publisher?.court !== court || typeof publisher.marker !== "string" || publisher.protocol !== (court <= 2 ? "RTMP" : "SRT")
      || !["planned", "running", "stopped"].includes(publisher.status)
      || ![publisher.progressPath, publisher.logPath, publisher.supervisorConfigPath, publisher.supervisorStatusPath].every((entry) => typeof entry === "string" && isAbsolute(entry))) {
      throw new Error(`Camera ${court} production synthetic publisher state is invalid`);
    }
  }
  return value;
}

export function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["start", "status", "stop"]).has(command)) throw new Error("first argument must be start, status, or stop");
  const options = { command, profile: null, state: null, evidence: null, runtime: null, ffmpeg: null, confirm: null };
  const mappings = new Map([["--profile", "profile"], ["--state", "state"], ["--evidence", "evidence"], ["--runtime", "runtime"], ["--ffmpeg", "ffmpeg"], ["--confirm", "confirm"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mappings.get(flag);
    const raw = argv[++index];
    if (!key || !raw || raw.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    if (options[key] !== null) throw new Error(`${flag} may be specified only once`);
    options[key] = key === "confirm" ? raw : normalizedAbsolute(raw, flag);
  }
  for (const key of ["profile", "state"]) if (!options[key]) throw new Error(`--${key} is required`);
  if (command === "start") for (const key of ["evidence", "runtime", "ffmpeg", "confirm"]) if (!options[key]) throw new Error(`--${key} is required for start`);
  if (command === "stop" && !options.confirm) throw new Error("--confirm is required for stop");
  if (command === "status" && options.confirm !== null) throw new Error("status does not accept --confirm");
  return options;
}

async function loadContext(profilePath) {
  const profile = validateProfile(await readProtectedJson(profilePath, "event operator profile"));
  const manifest = await readProtectedJson(profile.manifest, "event manifest");
  validateEventManifest(manifest, await loadManifestInputs({ networkFromManifest: manifest.network }));
  if (manifest.kind !== "production" || manifest.droplets.length !== 12) throw new Error("production synthetic publishers require the exact production manifest");
  const lifecycleState = await new FileStateStore(profile.state).load();
  if (!lifecycleState || lifecycleState.event !== manifest.event || typeof lifecycleState.generationId !== "string") throw new Error("production synthetic publishers require matching lifecycle state");
  const ingestEnvironment = await loadProtectedEnv(join(profile.secrets, "ingest.env"));
  const observabilityEnvironment = await loadProtectedEnv(join(profile.secrets, "observability.env"));
  return { profile, manifest, lifecycleState, ingestEnvironment, observabilityEnvironment };
}

function buildConfigurations(options, context) {
  const host = onlyEndpoint(context.manifest, "ingest");
  return Object.fromEntries(COURTS.map((court) => [court, buildSyntheticPublisherConfig({
    court,
    generationId: context.lifecycleState.generationId,
    host,
    user: required(context.ingestEnvironment, `MEDIAMTX_COURT_${court}_PUBLISH_USER`),
    password: required(context.ingestEnvironment, `MEDIAMTX_COURT_${court}_PUBLISH_PASS`),
    evidenceDirectory: options.evidence,
    runtimeDirectory: options.runtime,
    ffmpegPath: options.ffmpeg,
    maxRestarts: MAX_RECOVERY_RESTARTS
  })]));
}

async function assertRawPathsIdle(context, fetchImpl) {
  const token = required(context.observabilityEnvironment, "MONITOR_API_TOKEN");
  const response = await fetchImpl(`https://${onlyEndpoint(context.manifest, "observability")}/v1/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`monitor snapshot returned HTTP ${response.status}`);
  const snapshot = await response.json();
  if (snapshot?.version !== 5 || !Array.isArray(snapshot.courts)) throw new Error("monitor snapshot contract is invalid");
  const occupied = snapshot.courts.filter((court) => court?.paths?.raw?.ready === true || Number(court?.paths?.raw?.inboundBitrateBps ?? 0) > 0).map((court) => court.courtNumber);
  if (occupied.length) throw new Error(`physical or unknown publishers already occupy Camera ${occupied.join(", ")} raw paths`);
}

function validateStateBinding(state, context, options) {
  validateStateEvent(state, context);
  if (state.profile !== options.profile || state.evidenceDirectory !== options.evidence || state.runtimeDirectory !== options.runtime || state.ffmpegPath !== options.ffmpeg) throw new Error("production synthetic publisher inputs changed");
}

function validateStateEvent(state, context) {
  validatePublisherState(state);
  if (state.event !== context.manifest.event || state.generationId !== context.lifecycleState.generationId) throw new Error("production synthetic publisher state belongs to another event generation");
}

function requireLifecycle(context, phases) {
  if (!phases.includes(context.lifecycleState.phase)) throw new Error(`production synthetic publishers require lifecycle phase ${phases.join(" or ")}`);
}

function publicState(value) {
  if (value === null) return { status: "ABSENT" };
  return {
    status: value.phase,
    event: value.event,
    generationId: value.generationId,
    startedAt: value.startedAt,
    stoppedAt: value.stoppedAt,
    healthy: value.health?.passed ?? null,
    problems: value.health?.problems ?? [],
    publishers: Object.values(value.publishers).map(({ court, marker, protocol, status }) => ({ court, marker, protocol, status }))
  };
}

async function readProtectedJson(path, label) {
  const information = await lstat(path);
  if (!information.isFile() || information.isSymbolicLink() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected regular file`);
  return JSON.parse(await readFile(path, "utf8"));
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

function isDirectInvocation() {
  return process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

function usage() {
  process.stdout.write(`Usage:\n  node infra/event-stack/production-synthetic-publishers.mjs start --profile FILE --state FILE --evidence DIR --runtime DIR --ffmpeg FILE --confirm START-SYNTHETIC-PUBLISHERS:EVENT\n  node infra/event-stack/production-synthetic-publishers.mjs status --profile FILE --state FILE\n  node infra/event-stack/production-synthetic-publishers.mjs stop --profile FILE --state FILE --confirm STOP-SYNTHETIC-PUBLISHERS:EVENT\n`);
}
