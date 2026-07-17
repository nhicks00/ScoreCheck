import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { rehearsalMarker } from "./youtube-provider.mjs";
import { withProcessLock } from "../process-lock.mjs";

const STATE_SCHEMA_VERSION = 2;
const PHASES = new Set(["planned", "preparing", "prepared", "starting", "running", "stopping", "stopped", "cleaning", "cleaned"]);
const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));

export class RehearsalController {
  constructor({ store, vercel, youtube, publishers, commentary, egress, sampler, verifier, soakEvaluator, sealEvidence, renderSecrets, programEnvironment, publisherConfiguration, commentaryConfiguration, now = () => new Date() }) {
    Object.assign(this, { store, vercel, youtube, publishers, commentary, egress, sampler, verifier, soakEvaluator, sealEvidence, renderSecrets, programEnvironment, publisherConfiguration, commentaryConfiguration, now });
  }

  async plan({ manifest, lifecycleState }) {
    validateLifecycleBinding(manifest, lifecycleState, ["planned", "provisioning", "ready"]);
    return this.store.withLock(async () => {
      const existing = await this.store.load();
      if (existing) {
        assertStateBinding(existing, manifest, lifecycleState);
        return existing;
      }
      const state = createRehearsalState(manifest, lifecycleState, this.now());
      await this.store.save(state);
      return state;
    });
  }

  async prepare({ manifest, lifecycleState, material, git, secretsDirectory, external = {} }) {
    validateLifecycleBinding(manifest, lifecycleState, ["planned", "provisioning", "ready"]);
    return this.store.withLock(async () => {
      let state = await this.#loadBound(manifest, lifecycleState);
      assertPhase(state, ["planned", "preparing"], "prepare rehearsal providers");
      state.phase = "preparing";
      state.lastError = null;
      await this.store.save(state);
      try {
        const projectName = state.program.projectName;
        const project = await this.vercel.ensureProject({ name: projectName, repository: { slug: git.repo, repoId: git.repoId } });
        state.program.project = project;
        await this.store.save(state);

        const environment = this.programEnvironment({ manifest, material, programOrigin: project.origin });
        const deployment = await this.vercel.ensureDeployment({ project, generationId: state.generationId, ...git, environment });
        state.program.deployment = deployment;
        await this.store.save(state);
        state.program.deployment = await this.vercel.waitReady({ deploymentId: deployment.id, project, generationId: state.generationId });
        state.program.origin = project.origin;
        state.program.preflight = await this.vercel.verifyProgramPage({ project, token: material.programPageToken });
        await this.store.save(state);

        for (const court of COURTS) {
          const courtState = state.courts[court];
          const marker = courtState.marker;
          courtState.stream = await this.youtube.ensureStream({ court, marker });
          await this.store.save(state);
          courtState.broadcast = await this.youtube.ensureBroadcast({ court, marker });
          await this.store.save(state);
          courtState.broadcast = await this.youtube.bind({ broadcastId: courtState.broadcast.id, streamId: courtState.stream.id });
          courtState.bound = true;
          await this.store.save(state);
        }

        state.secretsDirectory = await this.renderSecrets({
          manifest,
          material,
          directory: secretsDirectory,
          programOrigin: state.program.origin,
          youtubeDestinations: COURTS.map((court) => ({
            court,
            streamId: state.courts[court].stream.id,
            broadcastId: state.courts[court].broadcast.id,
            streamName: state.courts[court].stream.streamName,
            rtmpsIngestionAddress: state.courts[court].stream.rtmpsIngestionAddress
          })),
          external
        });
        state.phase = "prepared";
        state.preparedAt = this.now().toISOString();
        await this.store.save(state);
        return state;
      } catch (error) {
        state.lastError = safeError(error, this.now());
        await this.store.save(state);
        throw error;
      }
    });
  }

  async start({ manifest, lifecycleState, material, evidenceDirectory }) {
    validateLifecycleBinding(manifest, lifecycleState, ["ready", "live"]);
    return this.store.withLock(async () => {
      let state = await this.#loadBound(manifest, lifecycleState);
      assertPhase(state, ["prepared", "starting"], "start rehearsal workload");
      state.phase = "starting";
      state.lastError = null;
      await this.store.save(state);
      try {
        await this.verifier.preflight({ manifest, lifecycleState, state: structuredClone(state) });
        if (!state.sampler) {
          state.sampler = { status: "starting", output: `${resolve(evidenceDirectory)}/pool-host-samples.jsonl` };
          await this.store.save(state);
        }
        state.sampler = await this.sampler.ensure({ manifest, lifecycleState, state: structuredClone(state), evidenceDirectory });
        await this.store.save(state);

        await this.publishers.preflight(this.publisherConfiguration({ manifest, material, court: 1, state, evidenceDirectory }).ffmpegPath);
        for (const court of COURTS) {
          const courtState = state.courts[court];
          const configuration = this.publisherConfiguration({ manifest, material, court, state, evidenceDirectory });
          if (courtState.publisher?.status !== "running") {
            courtState.publisher = { status: "starting", marker: courtState.publisherMarker };
            await this.store.save(state);
          }
          const publisher = await this.publishers.ensure(configuration);
          courtState.publisher = { status: "running", ...publisher };
          await this.store.save(state);
        }
        await this.verifier.waitForRaw({ manifest, lifecycleState, state: structuredClone(state) });

        await this.commentary.preflight(this.commentaryConfiguration({ manifest, material, court: 1, state, evidenceDirectory }));
        for (const court of COURTS) {
          const courtState = state.courts[court];
          const configuration = this.commentaryConfiguration({ manifest, material, court, state, evidenceDirectory });
          if (courtState.commentary?.status !== "running") {
            courtState.commentary = { status: "starting", marker: configuration.marker };
            await this.store.save(state);
          }
          courtState.commentary = await this.commentary.ensure(configuration);
          await this.store.save(state);
        }

        for (const court of COURTS) {
          const courtState = state.courts[court];
          const host = compositorHost(lifecycleState, manifest, court);
          const expectedId = courtState.egress?.id ?? null;
          if (!expectedId) {
            await this.egress.preflight(host);
            courtState.egress = { status: "starting", id: null };
            await this.store.save(state);
          }
          const active = await this.egress.ensureStarted({ host, court, expectedId });
          courtState.egress = { status: "active", ...active };
          await this.store.save(state);
          courtState.admission = await this.egress.proveSecondStartRejected({ host, court, expectedId: active.id });
          await this.store.save(state);
          // Ramp one court end to end before admitting the next. This both
          // bounds startup load and prevents one broken Program chain from
          // occupying every compositor and YouTube destination.
          await this.youtube.waitFor({ streamId: courtState.stream.id, broadcastId: courtState.broadcast.id, streamStatus: "active" });
          courtState.broadcast = await this.youtube.transition(courtState.broadcast.id, "live");
          await this.store.save(state);
          const live = await this.youtube.waitFor({ streamId: courtState.stream.id, broadcastId: courtState.broadcast.id, streamStatus: "active", broadcastStatus: "live" });
          courtState.stream = { ...courtState.stream, ...live.stream };
          courtState.broadcast = live.broadcast;
          await this.store.save(state);
        }

        state.startEvidence = await this.verifier.waitForFull({ manifest, lifecycleState, state: structuredClone(state) });
        state.phase = "running";
        state.startedAt = this.now().toISOString();
        await this.store.save(state);
        return state;
      } catch (error) {
        state.lastError = safeError(error, this.now());
        await this.store.save(state);
        throw error;
      }
    });
  }

  async stop({ manifest, lifecycleState }) {
    validateLifecycleBinding(manifest, lifecycleState, ["ready", "live", "closed"]);
    return this.store.withLock(async () => {
      let state = await this.#loadBound(manifest, lifecycleState);
      assertPhase(state, ["starting", "running", "stopping"], "stop rehearsal workload");
      const reachedRunning = state.phase === "running" || state.startedAt !== null;
      const workloadNeverStarted = state.startedAt === null
        && state.sampler === null
        && COURTS.every((court) => {
          const courtState = state.courts[court];
          return !courtState.publisher?.marker
            && !courtState.commentary?.marker
            && !courtState.egress?.id
            && !["testing", "live"].includes(courtState.broadcast?.lifecycleStatus);
        });
      state.phase = "stopping";
      state.lastError = null;
      await this.store.save(state);
      try {
        if (!state.endpointEvidence) {
          try {
            state.endpointEvidence = await this.verifier.captureEndpoint({ manifest, lifecycleState, state: structuredClone(state) });
          } catch (error) {
            state.endpointEvidence = { passed: false, observedAt: this.now().toISOString(), problems: [`endpoint capture failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`] };
          }
          await this.store.save(state);
        }
        for (const court of COURTS) {
          const courtState = state.courts[court];
          if (!courtState.broadcast?.id) continue;
          let current;
          try {
            current = await this.youtube.getBroadcast(courtState.broadcast.id);
          } catch (error) {
            if (error?.status !== 404) throw error;
            courtState.broadcast = { id: courtState.broadcast.id, status: "absent" };
            await this.store.save(state);
            continue;
          }
          courtState.broadcast = current;
          await this.store.save(state);
          if (current.lifecycleStatus === "complete") continue;
          if (["testing", "live"].includes(current.lifecycleStatus)) {
            courtState.broadcast = await this.youtube.transition(current.id, "complete");
            await this.store.save(state);
            const completed = await this.youtube.waitFor({ streamId: courtState.stream.id, broadcastId: current.id, broadcastStatus: "complete" });
            courtState.broadcast = completed.broadcast;
            await this.store.save(state);
          } else {
            courtState.broadcast = { ...current, completionSkipped: true, completionSkippedReason: reachedRunning ? "provider was not live at endpoint" : "startup ended before provider became live" };
            await this.store.save(state);
          }
        }
        for (const court of [...COURTS].reverse()) {
          const courtState = state.courts[court];
          const host = compositorHost(lifecycleState, manifest, court);
          const active = await this.egress.listActive(host);
          if (active.length > 1) throw new Error(`compositor ${host} retained multiple Egress jobs during cleanup`);
          if (courtState.egress?.id && active.length === 1 && active[0].id !== courtState.egress.id) {
            throw new Error(`compositor ${host} active Egress does not match the recorded rehearsal job`);
          }
          if (!courtState.egress?.id && active.length === 1) {
            courtState.egress = { status: "active", ...active[0], adoptedDuringStop: true };
            await this.store.save(state);
          }
          if (courtState.egress?.id) {
            await this.egress.stopExact({ host, court, egressId: courtState.egress.id });
          }
          courtState.egress = { ...(courtState.egress ?? {}), status: "stopped" };
          await this.store.save(state);
        }
        for (const court of [...COURTS].reverse()) {
          const courtState = state.courts[court];
          if (courtState.commentary?.marker) {
            await this.commentary.stop({ marker: courtState.commentary.marker });
            courtState.commentary.status = "stopped";
            await this.store.save(state);
          }
        }
        for (const court of [...COURTS].reverse()) {
          const courtState = state.courts[court];
          if (courtState.publisher?.marker) {
            await this.publishers.stop({ marker: courtState.publisher.marker });
            courtState.publisher.status = "stopped";
            await this.store.save(state);
          }
        }
        if (state.sampler) {
          state.sampler = await this.sampler.stop(state.sampler);
          await this.store.save(state);
        }
        state.stopEvidence = workloadNeverStarted
          ? {
              passed: true,
              observedAt: this.now().toISOString(),
              mode: "direct-pre-start-cleanup",
              problems: [],
              note: "Workload ownership never started; provider state and all compositor Egress lists were reconciled directly."
            }
          : await this.verifier.waitForIdle({ manifest, lifecycleState, state: structuredClone(state) });
        state.phase = "stopped";
        state.stoppedAt = this.now().toISOString();
        await this.store.save(state);
        return state;
      } catch (error) {
        state.lastError = safeError(error, this.now());
        await this.store.save(state);
        throw error;
      }
    });
  }

  async cleanup({ manifest, lifecycleState }) {
    validateLifecycleBinding(manifest, lifecycleState, ["planned", "provisioning", "ready", "closed"]);
    return this.store.withLock(async () => {
      let state = await this.#loadBound(manifest, lifecycleState);
      assertPhase(state, ["planned", "preparing", "prepared", "stopped", "cleaning"], "clean rehearsal providers");
      if (COURTS.some((court) => ["starting", "active"].includes(state.courts[court].egress?.status)
        || ["starting", "running"].includes(state.courts[court].publisher?.status)
        || ["starting", "running"].includes(state.courts[court].commentary?.status))) {
        throw new Error("rehearsal workload must be stopped before provider cleanup");
      }
      state.phase = "cleaning";
      state.lastError = null;
      await this.store.save(state);
      try {
        for (const court of [...COURTS].reverse()) {
          const courtState = state.courts[court];
          if (!courtState.broadcast) {
            courtState.broadcast = await this.youtube.findBroadcast({ court, marker: courtState.marker }) ?? { id: null, status: "absent" };
            await this.store.save(state);
          }
          if (!courtState.stream) {
            courtState.stream = await this.youtube.findStream({ court, marker: courtState.marker }) ?? { id: null, status: "absent" };
            await this.store.save(state);
          }
          if (courtState.broadcast?.id && courtState.broadcast.status !== "deleted") {
            await this.youtube.deleteBroadcast(courtState.broadcast.id);
            courtState.broadcast = { id: courtState.broadcast.id, status: "deleted" };
            await this.store.save(state);
          }
          if (courtState.stream?.id && courtState.stream.status !== "deleted") {
            await this.youtube.deleteStream(courtState.stream.id);
            courtState.stream = { id: courtState.stream.id, status: "deleted" };
            await this.store.save(state);
          }
        }
        if (!state.program.project) {
          state.program.project = await this.vercel.findProject(state.program.projectName) ?? { id: null, name: state.program.projectName, status: "absent" };
          await this.store.save(state);
        }
        if (state.program.project?.id && state.program.project.status !== "deleted") {
          await this.vercel.deleteProject(state.program.project.id);
          state.program.project = { id: state.program.project.id, name: state.program.project.name, status: "deleted" };
          state.program.deployment = state.program.deployment ? { id: state.program.deployment.id, status: "deleted-with-project" } : null;
          await this.store.save(state);
        }
        state.phase = "cleaned";
        state.cleanedAt = this.now().toISOString();
        await this.store.save(state);
        return state;
      } catch (error) {
        state.lastError = safeError(error, this.now());
        await this.store.save(state);
        throw error;
      }
    });
  }

  async soak({ manifest, lifecycleState, evidenceDirectory, durationMs }) {
    validateLifecycleBinding(manifest, lifecycleState, ["ready", "live"]);
    return this.store.withLock(async () => {
      const state = await this.#loadBound(manifest, lifecycleState);
      assertPhase(state, ["running"], "run the rehearsal soak");
      if (state.soakEvidence?.passed) return state;
      if (state.soakEvidence && !state.soakEvidence.passed) throw new Error("this rehearsal generation already has a failed soak; preserve it and start a new generation");
      state.soak ??= { status: "running", startedAt: this.now().toISOString(), durationMs, evidenceDirectory: resolve(evidenceDirectory) };
      if (state.soak.durationMs !== durationMs || state.soak.evidenceDirectory !== resolve(evidenceDirectory)) throw new Error("rehearsal soak resume inputs changed");
      state.lastError = null;
      await this.store.save(state);
      try {
        state.soakEvidence = await this.soakEvaluator.run({ state: structuredClone(state), manifest, lifecycleState, evidenceDirectory, durationMs });
        state.soak.status = state.soakEvidence.passed ? "passed" : "failed";
        state.soak.completedAt = this.now().toISOString();
        await this.store.save(state);
        if (!state.soakEvidence.passed) throw new Error(`rehearsal soak failed: ${state.soakEvidence.problems.slice(0, 8).join("; ")}`);
        return state;
      } catch (error) {
        state.lastError = safeError(error, this.now());
        await this.store.save(state);
        throw error;
      }
    });
  }

  async seal({ manifest, lifecycleState, evidenceDirectory }) {
    validateLifecycleBinding(manifest, lifecycleState, ["planned", "provisioning", "ready", "closed"]);
    return this.store.withLock(async () => {
      const state = await this.#loadBound(manifest, lifecycleState);
      assertPhase(state, ["cleaned"], "seal rehearsal evidence");
      if (!state.evidence) {
        state.evidence = await this.sealEvidence({ state: structuredClone(state), manifest, evidenceDirectory, now: this.now() });
        await this.store.save(state);
      }
      return state;
    });
  }

  async status({ manifest, lifecycleState }) {
    const state = await this.#loadBound(manifest, lifecycleState);
    return rehearsalSummary(state);
  }

  async #loadBound(manifest, lifecycleState) {
    const state = await this.store.load();
    if (!state) throw new Error("rehearsal state does not exist; run plan first");
    assertStateBinding(state, manifest, lifecycleState);
    return state;
  }
}

export class RehearsalFileStateStore {
  constructor(path) {
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("..")) throw new Error("rehearsal state path must be normalized and absolute");
    this.path = resolve(path);
    this.lockPath = `${this.path}.lock`;
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      validateRehearsalState(value);
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    validateRehearsalState(state);
    state.updatedAt = new Date().toISOString();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async withLock(operation) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    return withProcessLock({ lockPath: this.lockPath, label: "rehearsal" }, operation);
  }
}

export class RehearsalMemoryStateStore {
  constructor(initial = null) { this.state = initial; }
  async load() { return this.state === null ? null : structuredClone(this.state); }
  async save(state) { validateRehearsalState(state); this.state = structuredClone(state); }
  async withLock(operation) { return operation(); }
}

export function createRehearsalState(manifest, lifecycleState, now = new Date()) {
  validateLifecycleBinding(manifest, lifecycleState, ["planned", "provisioning", "ready"]);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    event: manifest.event,
    generationId: lifecycleState.generationId,
    lifecycleManifestSha256: lifecycleState.manifestSha256,
    manifestSha256: sha256(stableJson(manifest)),
    phase: "planned",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    preparedAt: null,
    startedAt: null,
    stoppedAt: null,
    cleanedAt: null,
    secretsDirectory: null,
    program: { projectName: `scorecheck-rehearsal-${manifest.namespace}`.slice(0, 52).replace(/-+$/u, ""), project: null, deployment: null, origin: null },
    courts: Object.fromEntries(COURTS.map((court) => [court, {
      marker: rehearsalMarker(lifecycleState.generationId, court),
      publisherMarker: `scorecheck-rehearsal-${lifecycleState.generationId}-camera-${court}`,
      stream: null,
      broadcast: null,
      bound: false,
      publisher: null,
      commentary: null,
      egress: null,
      admission: null
    }])),
    sampler: null,
    soak: null,
    startEvidence: null,
    soakEvidence: null,
    endpointEvidence: null,
    stopEvidence: null,
    evidence: null,
    lastError: null
  };
}

export function rehearsalSummary(state) {
  validateRehearsalState(state);
  return {
    event: state.event,
    generationId: state.generationId,
    phase: state.phase,
    programProjectId: state.program.project?.id ?? null,
    programDeploymentId: state.program.deployment?.id ?? null,
    preparedCourts: COURTS.filter((court) => state.courts[court].bound).length,
    activePublishers: COURTS.filter((court) => state.courts[court].publisher?.status === "running").length,
    activeEgresses: COURTS.filter((court) => state.courts[court].egress?.status === "active").length,
    liveBroadcasts: COURTS.filter((court) => state.courts[court].broadcast?.lifecycleStatus === "live").length,
    samplerStatus: state.sampler?.status ?? null,
    soakStatus: state.soak?.status ?? null,
    evidenceClassification: state.evidence?.classification ?? null,
    lastError: state.lastError
  };
}

export function validateRehearsalState(value) {
  if (!value || value.schemaVersion !== STATE_SCHEMA_VERSION || !PHASES.has(value.phase)) throw new Error("rehearsal state schema or phase is invalid");
  for (const key of ["event", "generationId", "lifecycleManifestSha256", "manifestSha256", "createdAt", "updatedAt"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`rehearsal state ${key} is invalid`);
  }
  if (!value.program || typeof value.program.projectName !== "string" || !value.courts || typeof value.courts !== "object") throw new Error("rehearsal state resource maps are invalid");
  if (JSON.stringify(Object.keys(value.courts).map(Number).sort((a, b) => a - b)) !== JSON.stringify(COURTS)) throw new Error("rehearsal state courts are incomplete");
  for (const court of COURTS) {
    const entry = value.courts[court];
    if (!entry || typeof entry.marker !== "string" || typeof entry.publisherMarker !== "string") throw new Error(`rehearsal state Camera ${court} is invalid`);
  }
  return value;
}

function validateLifecycleBinding(manifest, state, allowedPhases) {
  if (manifest?.kind !== "rehearsal" || manifest?.droplets?.length !== 12) throw new Error("workload rehearsal requires the isolated 12-Droplet manifest");
  if (!state || state.event !== manifest.event || state.kind !== "rehearsal" || !allowedPhases.includes(state.phase)) throw new Error("lifecycle state is not at an allowed rehearsal boundary");
  if (state.manifestSha256 !== sha256(stableJson(manifest)) || typeof state.generationId !== "string") throw new Error("lifecycle state does not match the rehearsal manifest");
}

function assertStateBinding(state, manifest, lifecycleState) {
  validateRehearsalState(state);
  if (state.event !== manifest.event || state.generationId !== lifecycleState.generationId || state.lifecycleManifestSha256 !== lifecycleState.manifestSha256 || state.manifestSha256 !== sha256(stableJson(manifest))) {
    throw new Error("rehearsal state belongs to a different lifecycle generation");
  }
}

function compositorHost(lifecycleState, manifest, court) {
  const spec = manifest.droplets.find((entry) => entry.role === "compositor" && entry.court === court);
  const host = spec && lifecycleState.droplets?.[spec.name]?.publicIpv4;
  if (!host) throw new Error(`lifecycle state has no compositor host for Camera ${court}`);
  return host;
}

function assertPhase(state, phases, action) {
  if (!phases.includes(state.phase)) throw new Error(`cannot ${action} while rehearsal phase is ${state.phase}`);
}

function safeError(error, now) {
  const observedAt = typeof now === "function" ? now() : now;
  return { message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), observedAt: observedAt.toISOString() };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export { COURTS };
