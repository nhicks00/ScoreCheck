#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { HevcNormalizerRuntime } from "./hevc-normalizer-runtime.mjs";
import { OutputConformanceRuntime } from "./output-conformance.mjs";
import { admittedProfileProblems, assertProductionMonitorSnapshot, productionRawProblems } from "./production-soak.mjs";
import { ProductionSourceProbe } from "./production-media-profile.mjs";
import { loadRendererBinding } from "./renderer-binding.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { loadVenueAdmission } from "./venue-admission.mjs";
import { loadCommentaryQualification } from "./commentary-qualification.mjs";
import { validateProfile } from "./eventctl.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SOURCE_WAIT_MS = 5 * 60_000;
const RAW_STABLE_SAMPLES = 3;
const RAW_SAMPLE_INTERVAL_MS = 2_000;

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const runtime = await ProductionMediaPrequalificationRuntime.create(options);
  process.stdout.write(`${JSON.stringify(await runtime.run(), null, 2)}\n`);
}

export class ProductionMediaPrequalificationRuntime {
  static async create(options, dependencies = {}) {
    const profile = validateProfile(await readProtectedJson(options.profile, "event operator profile"));
    const [manifest, lifecycle, renderer] = await Promise.all([
      readProtectedJson(profile.manifest, "event manifest"),
      readProtectedJson(profile.state, "event lifecycle state"),
      loadRendererBinding(profile.rendererBinding)
    ]);
    if (manifest.kind !== "production" || !Array.isArray(manifest.droplets) || manifest.droplets.length !== 12 || lifecycle.event !== manifest.event || lifecycle.phase !== "ready") {
      throw new Error("media prequalification requires its exact ready 12-host production event before coverage");
    }
    const venue = await loadVenueAdmission(profile.venueProfile, manifest.event);
    if (!venue.passed) throw new Error(`venue profile is not admitted: ${venue.problems.join("; ")}`);
    const commentary = await loadCommentaryQualification(profile.commentaryQualification, manifest.event, venue.activeCameras);
    if (commentary.qualification.status !== "PENDING") throw new Error("media prequalification requires pending commentary evidence");
    const monitorEnvironment = await loadProtectedEnv(join(profile.secrets, "observability.env"));
    const monitorEndpoint = manifest.endpoints.find((entry) => entry.role === "observability");
    if (!monitorEndpoint?.hostname || !monitorEnvironment.MONITOR_API_TOKEN) throw new Error("production monitor endpoint or token is missing");
    const ffprobe = await stat(options.ffprobe);
    if (!ffprobe.isFile() || (ffprobe.mode & 0o111) === 0) throw new Error("FFprobe must be executable");
    return new ProductionMediaPrequalificationRuntime({
      options, profile, manifest, lifecycle, renderer, venue,
      monitorOrigin: `https://${monitorEndpoint.hostname}`,
      monitorToken: monitorEnvironment.MONITOR_API_TOKEN,
      normalizer: dependencies.normalizer ?? new HevcNormalizerRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts }),
      sourceProbe: dependencies.sourceProbe ?? new ProductionSourceProbe({ sshKey: profile.sshKey, knownHosts: profile.knownHosts }),
      outputConformance: dependencies.outputConformance ?? new OutputConformanceRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts, ffprobePath: options.ffprobe }),
      fetchSnapshot: dependencies.fetchSnapshot ?? (() => fetchMonitorSnapshot(`https://${monitorEndpoint.hostname}`, monitorEnvironment.MONITOR_API_TOKEN)),
      rawProblems: dependencies.rawProblems ?? productionRawProblems,
      cleanupProblems: dependencies.cleanupProblems ?? prequalificationCleanupProblems,
      sleep: dependencies.sleep ?? delay,
      now: dependencies.now ?? (() => Date.now())
    });
  }

  constructor(values) { Object.assign(this, values); }

  async run() {
    await mkdir(this.options.evidence, { recursive: true, mode: 0o700 });
    await chmod(this.options.evidence, 0o700);
    const statePath = join(this.options.evidence, "production-media-prequalification-state.json");
    let state = await readStateOrNull(statePath);
    if (!state) {
      state = {
        schemaVersion: 1,
        event: this.manifest.event,
        lifecycleGenerationId: this.lifecycle.generationId,
        runId: randomUUID(),
        phase: "RUNNING",
        startedAt: new Date(this.now()).toISOString(),
        renderer: { origin: this.renderer.origin, deploymentId: this.renderer.deploymentId, gitSha: this.renderer.gitSha },
        venueProfileSha256: this.venue.sha256,
        cameras: {}
      };
      await writeProtectedAtomic(statePath, state);
    } else validateState(state, this.manifest, this.lifecycle, this.renderer, this.venue);
    if (state.phase === "COMPLETE") return state.report;

    for (const camera of this.venue.activeCameras) {
      const assignment = this.venue.assignments[camera];
      const court = state.cameras[camera] ?? { camera, status: "WAITING", normalizer: null, profile: null, baseline: null, outputConformance: null, final: null };
      state.cameras[camera] = court;
      process.stdout.write(`WAITING Camera ${camera}: publish the exact ${assignment.sourceCodec} ${assignment.frameRateMode} feed to ${assignment.publishPath}. No YouTube output will start.\n`);
      if (!court.normalizer) {
        court.normalizer = await this.normalizer.ensure({
          host: compositorHost(this.manifest, this.lifecycle, camera),
          court: camera,
          required: assignment.sourcePathMode === "isolated-hevc-normalizer",
          ...(assignment.sourcePathMode === "isolated-hevc-normalizer" ? {
            sourceProfile: assignment.sourceProfile,
            frameRateMode: assignment.frameRateMode,
            mediamtxPrivateHost: ingestPrivateHost(this.manifest, this.lifecycle)
          } : {})
        });
        court.status = "NORMALIZER_READY";
        await writeProtectedAtomic(statePath, state);
      }
      if (!court.profile) {
        court.profile = await this.#waitForSource(camera, assignment);
        const problems = admittedProfileProblems(camera, court.profile, assignment);
        if (problems.length) throw new Error(problems.join("; "));
        court.status = "SOURCE_QUALIFIED";
        await writeProtectedAtomic(statePath, state);
      }
      if (!court.baseline) {
        court.baseline = await this.#waitForStableRaw();
        court.status = "RAW_STABLE";
        await writeProtectedAtomic(statePath, state);
      }
      if (!court.outputConformance) {
        court.outputConformance = await this.outputConformance.qualify({
          host: compositorHost(this.manifest, this.lifecycle, camera),
          court: camera,
          profile: court.profile.profile,
          evidenceId: state.runId,
          outputDirectory: join(this.options.evidence, "output-conformance"),
          renderer: this.renderer
        });
        court.status = "OUTPUT_QUALIFIED";
        await writeProtectedAtomic(statePath, state);
      }
      court.final = await this.#waitForPostCaptureIdle();
      court.status = "PASS";
      await writeProtectedAtomic(statePath, state);
    }

    const endedAt = new Date(this.now()).toISOString();
    const report = {
      schemaVersion: 1,
      status: "PASS",
      event: state.event,
      lifecycleGenerationId: state.lifecycleGenerationId,
      runId: state.runId,
      startedAt: state.startedAt,
      endedAt,
      renderer: state.renderer,
      venueProfileSha256: state.venueProfileSha256,
      activeCameras: [...this.venue.activeCameras],
      inactiveCameras: [...this.venue.inactiveCameras],
      cameras: state.cameras
    };
    await writeProtectedAtomic(join(this.options.evidence, "production-media-prequalification-report.json"), report);
    state.phase = "COMPLETE";
    state.endedAt = endedAt;
    state.report = report;
    await writeProtectedAtomic(statePath, state);
    return report;
  }

  async #waitForSource(camera, assignment) {
    const started = this.now();
    let lastError = null;
    while (this.now() - started <= SOURCE_WAIT_MS) {
      try {
        return await this.sourceProbe.probe({
          host: ingestHost(this.manifest, this.lifecycle),
          court: camera,
          sourcePathMode: assignment.sourcePathMode,
          expectedFrameRateMode: assignment.frameRateMode
        });
      } catch (error) {
        lastError = error;
        await this.sleep(RAW_SAMPLE_INTERVAL_MS);
      }
    }
    throw new Error(`Camera ${camera} did not reach its source contract within five minutes: ${safeError(lastError)}`);
  }

  async #waitForStableRaw() {
    const started = this.now();
    let stable = 0;
    let first = null;
    let last = null;
    let lastProblems = [];
    while (this.now() - started <= SOURCE_WAIT_MS) {
      const snapshot = assertProductionMonitorSnapshot(await this.fetchSnapshot());
      lastProblems = this.rawProblems(snapshot, this.venue, this.now());
      if (lastProblems.length === 0) {
        first ??= summarizeSnapshot(snapshot, this.venue);
        last = summarizeSnapshot(snapshot, this.venue);
        stable += 1;
        if (stable >= RAW_STABLE_SAMPLES) return { first, last, samples: stable };
      } else {
        first = null;
        last = null;
        stable = 0;
      }
      await this.sleep(RAW_SAMPLE_INTERVAL_MS);
    }
    throw new Error(`production raw paths did not stabilize: ${lastProblems.slice(0, 8).join("; ")}`);
  }

  async #waitForPostCaptureIdle() {
    const started = this.now();
    let stable = 0;
    let first = null;
    let last = null;
    let lastProblems = [];
    while (this.now() - started <= SOURCE_WAIT_MS) {
      const snapshot = assertProductionMonitorSnapshot(await this.fetchSnapshot());
      lastProblems = [
        ...this.rawProblems(snapshot, this.venue, this.now()),
        ...this.cleanupProblems(snapshot, this.venue)
      ];
      if (lastProblems.length === 0) {
        first ??= summarizeSnapshot(snapshot, this.venue);
        last = summarizeSnapshot(snapshot, this.venue);
        stable += 1;
        if (stable >= RAW_STABLE_SAMPLES) return { first, last, samples: stable };
      } else {
        first = null;
        last = null;
        stable = 0;
      }
      await this.sleep(RAW_SAMPLE_INTERVAL_MS);
    }
    throw new Error(`local-only output did not drain to idle: ${lastProblems.slice(0, 8).join("; ")}`);
  }
}

export function prequalificationCleanupProblems(snapshot, venue) {
  const problems = [];
  for (const camera of venue.activeCameras) {
    const court = snapshot.courts.find((entry) => entry.courtNumber === camera);
    if (!court) { problems.push(`monitor does not contain Camera ${camera}`); continue; }
    if (court.browser) problems.push(`Camera ${camera} retains a program browser after local-only output capture`);
    for (const branch of ["preview", "program"]) {
      const path = court.paths?.[branch];
      if (path?.ready || (path?.readerCount ?? 0) !== 0) problems.push(`Camera ${camera} ${branch} did not retire after local-only output capture`);
    }
  }
  for (const agent of snapshot.agents.filter((entry) => ["compositor", "worker"].includes(entry.role))) {
    const egress = agent.nativeServices?.egress;
    if (!egress?.idle || egress.activeWebRequests !== 0 || egress.maximumWebRequests !== 1 || !egress.canAcceptRequest) problems.push(`${agent.agentId} is not idle after local-only output capture`);
  }
  return problems;
}

function summarizeSnapshot(snapshot, venue) {
  const cameras = new Set([...venue.activeCameras, ...venue.inactiveCameras]);
  return {
    generatedAt: snapshot.generatedAt,
    sha256: sha256(stableJson(snapshot)),
    collector: snapshot.collector,
    courts: snapshot.courts.filter((court) => cameras.has(court.courtNumber)).map((court) => ({ courtNumber: court.courtNumber, overallState: court.overallState, paths: court.paths })),
    agents: snapshot.agents.map((agent) => ({ agentId: agent.agentId, role: agent.role, state: agent.state, assignedCourts: agent.assignedCourts, host: agent.host, nativeServices: agent.nativeServices }))
  };
}

async function fetchMonitorSnapshot(origin, token) {
  const response = await fetch(`${origin}/v1/snapshot`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`production monitor snapshot returned HTTP ${response.status}`);
  return response.json();
}

function validateState(state, manifest, lifecycle, renderer, venue) {
  if (state?.schemaVersion !== 1 || state.event !== manifest.event || state.lifecycleGenerationId !== lifecycle.generationId || state.venueProfileSha256 !== venue.sha256
    || state.renderer?.deploymentId !== renderer.deploymentId || state.renderer?.gitSha !== renderer.gitSha || !new Set(["RUNNING", "COMPLETE"]).has(state.phase)) {
    throw new Error("media prequalification state does not match this event generation");
  }
}

function resourceHost(manifest, lifecycle, predicate, field, label) {
  const spec = manifest.droplets.find(predicate);
  const host = spec ? lifecycle.droplets?.[spec.name]?.[field] : null;
  if (!host) throw new Error(`${label} is unavailable`);
  return host;
}
function ingestHost(manifest, lifecycle) { return resourceHost(manifest, lifecycle, (entry) => entry.role === "ingest", "publicIpv4", "ingest public IPv4"); }
function ingestPrivateHost(manifest, lifecycle) { return resourceHost(manifest, lifecycle, (entry) => entry.role === "ingest", "privateIpv4", "ingest private IPv4"); }
function compositorHost(manifest, lifecycle, camera) { return resourceHost(manifest, lifecycle, (entry) => entry.role === "compositor" && entry.court === camera, "publicIpv4", `Camera ${camera} compositor IPv4`); }

function parseArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (argv[0] !== "run") throw new Error("first argument must be run");
  const values = { command: "run" };
  const mapping = new Map([["--profile", "profile"], ["--evidence", "evidence"], ["--ffprobe", "ffprobe"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    values[key] = absolute(value, flag);
  }
  for (const key of mapping.values()) if (!values[key]) throw new Error(`${key} is required`);
  return values;
}

function absolute(value, label) {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("..")) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

async function readProtectedJson(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readStateOrNull(path) {
  try { return await readProtectedJson(path, "media prequalification state"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function writeProtectedAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function safeError(value) { return value instanceof Error ? value.message.slice(0, 300) : String(value).slice(0, 300); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function usage() {
  process.stdout.write("Usage:\n  production-media-prequalification.mjs run --profile /PROTECTED/event-profile.json --evidence /PROTECTED/evidence/media-prequalification --ffprobe /ABSOLUTE/ffprobe\n");
}
