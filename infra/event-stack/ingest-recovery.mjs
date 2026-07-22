import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { withProcessLock } from "./process-lock.mjs";

const CAMERA_NUMBERS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const PHASES = new Set(["PREPARING", "PREPARED", "TAKING_OVER", "ACTIVE_ON_SPARE", "ROLLING_BACK", "ROLLED_BACK", "FAILED"]);

export class IngestRecoveryController {
  constructor({ platform, now = () => new Date(), checkpoint = async () => {} }) {
    if (!platform) throw new Error("ingest recovery platform is required");
    if (typeof checkpoint !== "function") throw new Error("ingest recovery checkpoint must be a function");
    this.platform = platform;
    this.now = now;
    this.checkpoint = checkpoint;
  }

  async prepare({ manifest, lifecycleState, anchors, state = null }) {
    const topology = recoveryTopology(manifest, lifecycleState, anchors);
    await this.platform.assertPrimaryIngestHealthy(topology.primary);
    if (state === null) {
      await this.platform.assertSpareIdle(topology.spare);
      await this.platform.assertCompositorOutputsHealthy(topology.compositors);
      const at = this.now().toISOString();
      state = validateRecoveryState({
        schemaVersion: 3,
        event: manifest.event,
        recoveryId: randomUUID(),
        phase: "PREPARING",
        startedAt: at,
        preparedAt: null,
        updatedAt: at,
        topology,
        outputGenerations: null,
        activeHost: "primary",
        resumePhase: null,
        failure: null,
        timeline: [{ at, event: "spare-ingest-staging-started" }]
      });
      await this.#checkpoint(state);
    } else {
      validateRecoveryState(state);
      if (state.event !== manifest.event) throw new Error("ingest recovery state belongs to a different event");
      requireMatchingTopology(state.topology, topology);
      if (state.phase === "PREPARED") {
        await this.platform.assertSpareIdle(topology.spare);
        await this.platform.assertCompositorOutputsHealthy(topology.compositors);
        await this.platform.assertSpareIngestStaged(topology.spare);
        return state;
      }
      requirePhase(state, "PREPARING");
      await this.platform.assertCompositorOutputsHealthy(topology.compositors);
    }
    const staged = await this.platform.stageSpareIngest(topology);
    if (staged?.status !== "staged") throw new Error("spare ingest staging did not complete");
    state.phase = "PREPARED";
    state.preparedAt = this.now().toISOString();
    await this.#record(state, "spare-ingest-staged");
    return validateRecoveryState(state);
  }

  async takeover({ state, confirmation }) {
    validateRecoveryState(state);
    requirePhase(state, ["PREPARED", "TAKING_OVER", "FAILED"]);
    requireConfirmation(confirmation, `TAKEOVER-INGEST:${state.event}`);
    if (state.phase === "FAILED") await this.#resumeFailure(state, "TAKING_OVER", "takeover-resumed-after-failure");
    const topology = state.topology;
    await this.platform.assertPrimaryIngestFailed(topology.primary, { allowReservedOnSpare: state.phase === "TAKING_OVER" });
    if (state.phase === "PREPARED") {
      await this.platform.assertSpareIdle(topology.spare);
      state.phase = "TAKING_OVER";
      await this.#record(state, "takeover-started");
    }
    try {
      if (state.outputGenerations === null) {
        state.outputGenerations = await this.platform.captureOutputGenerations(topology.compositors);
        validateOutputGenerations(state.outputGenerations, topology.compositors, state.event);
        await this.#record(state, "output-generations-captured");
      }
      await this.#step(state, "ingest-network-policy-attached", () => this.platform.attachIngestNetworkPolicy(topology.spare));
      await this.#step(state, "spare-ingest-activated", () => this.platform.activateSpareIngest(topology));
      await this.#step(state, "reserved-ipv4-moved-to-spare", () => this.platform.moveReservedIpv4({
        ip: topology.reservedIpv4,
        fromDropletId: topology.primary.dropletId,
        toDropletId: topology.spare.dropletId
      }));
      await this.#step(state, "spare-ingest-public-healthy", () => this.platform.waitIngestPublicHealth(topology.spare));
      for (const compositor of topology.compositors) {
        const generation = state.outputGenerations[compositor.cameraNumber];
        await this.#step(state, `compositor-${compositor.cameraNumber}-rebound-to-spare`, () => this.platform.rebindCompositorIngress({ compositor, generation, fromPrivateIpv4: topology.primary.privateIpv4, toPrivateIpv4: topology.spare.privateIpv4 }));
        await this.#step(state, `compositor-${compositor.cameraNumber}-output-resumed-on-spare`, async () => {
          const resumed = await this.platform.resumeOutputGeneration({ compositor, generation });
          state.outputGenerations[compositor.cameraNumber] = resumed?.owner;
          validateOutputGenerations(state.outputGenerations, topology.compositors, state.event);
        });
      }
      await this.#step(state, "ingest-monitoring-switched-to-spare", () => this.platform.switchIngestMonitoring({ from: topology.primary, to: topology.spare }));
      await this.platform.verifyRecoveredIngest({ topology, outputGenerations: state.outputGenerations });
      state.phase = "ACTIVE_ON_SPARE";
      state.activeHost = "spare";
      await this.#record(state, "takeover-qualified");
      return validateRecoveryState(state);
    } catch (error) {
      throw await this.#failure(state, "takeover-failed", error);
    }
  }

  async rollback({ state, confirmation }) {
    validateRecoveryState(state);
    requirePhase(state, ["ACTIVE_ON_SPARE", "ROLLING_BACK", "FAILED"]);
    requireConfirmation(confirmation, `ROLLBACK-INGEST:${state.event}`);
    if (state.phase === "FAILED") await this.#resumeFailure(state, "ROLLING_BACK", "rollback-resumed-after-failure");
    const topology = state.topology;
    await this.platform.assertPrimaryIngestHealthy(topology.primary);
    if (state.timeline.some((entry) => entry.event === "spare-ingest-deactivated")) {
      await this.platform.assertSpareIngestStaged(topology.spare);
    } else {
      await this.platform.assertSpareIngestHealthy(topology.spare);
    }
    if (state.phase === "ACTIVE_ON_SPARE") {
      state.phase = "ROLLING_BACK";
      await this.#record(state, "rollback-started");
    }
    try {
      await this.#step(state, "reserved-ipv4-restored-to-primary", () => this.platform.moveReservedIpv4({
        ip: topology.reservedIpv4,
        fromDropletId: topology.spare.dropletId,
        toDropletId: topology.primary.dropletId
      }));
      await this.#step(state, "primary-ingest-public-healthy", () => this.platform.waitIngestPublicHealth(topology.primary));
      for (const compositor of topology.compositors) {
        const generation = state.outputGenerations[compositor.cameraNumber];
        await this.#step(state, `compositor-${compositor.cameraNumber}-rebound-to-primary`, () => this.platform.rebindCompositorIngress({ compositor, generation, fromPrivateIpv4: topology.spare.privateIpv4, toPrivateIpv4: topology.primary.privateIpv4 }));
        await this.#step(state, `compositor-${compositor.cameraNumber}-output-resumed-on-primary`, async () => {
          const resumed = await this.platform.resumeOutputGeneration({ compositor, generation });
          state.outputGenerations[compositor.cameraNumber] = resumed?.owner;
          validateOutputGenerations(state.outputGenerations, topology.compositors, state.event);
        });
      }
      await this.#step(state, "ingest-monitoring-restored-to-primary", () => this.platform.switchIngestMonitoring({ from: topology.spare, to: topology.primary }));
      await this.platform.verifyRecoveredIngest({ topology: { ...topology, activeIngest: topology.primary }, outputGenerations: state.outputGenerations });
      await this.#step(state, "spare-ingest-deactivated", () => this.platform.deactivateSpareIngest(topology.spare));
      await this.#step(state, "ingest-network-policy-detached", () => this.platform.detachIngestNetworkPolicy(topology.spare));
      await this.#step(state, "spare-compositor-restored", () => this.platform.restoreSpareCompositor(topology.spare));
      state.phase = "ROLLED_BACK";
      state.activeHost = "primary";
      await this.#record(state, "rollback-qualified");
      return validateRecoveryState(state);
    } catch (error) {
      throw await this.#failure(state, "rollback-failed", error);
    }
  }

  async #step(state, event, operation) {
    if (state.timeline.some((entry) => entry.event === event)) return;
    await operation();
    await this.#record(state, event);
  }

  async #failure(state, event, error) {
    state.resumePhase = state.phase;
    state.phase = "FAILED";
    state.failure = safeError(error);
    try {
      await this.#record(state, event);
    } catch (checkpointError) {
      state.failure = `${state.failure}; recovery checkpoint failed: ${safeError(checkpointError)}`.slice(0, 500);
    }
    return new IngestRecoveryError(state.failure, state);
  }

  async #resumeFailure(state, expectedPhase, event) {
    if (state.resumePhase !== expectedPhase) throw new Error(`ingest recovery failure belongs to ${state.resumePhase ?? "an unknown phase"}`);
    state.phase = expectedPhase;
    state.resumePhase = null;
    state.failure = null;
    await this.#record(state, event);
  }

  async #record(state, event) {
    const at = this.now().toISOString();
    state.updatedAt = at;
    state.timeline.push({ at, event });
    await this.#checkpoint(state);
  }

  async #checkpoint(state) {
    validateRecoveryState(state);
    await this.checkpoint(structuredClone(state));
  }
}

export class FileIngestRecoveryStateStore {
  constructor(statePath) {
    if (typeof statePath !== "string" || !isAbsolute(statePath) || resolve(statePath) !== statePath || statePath.includes("..") || /[\r\n\0]/u.test(statePath)) throw new Error("ingest recovery state path must be a normalized absolute path");
    this.statePath = statePath;
    this.lockPath = `${statePath}.lock`;
  }

  async load() {
    try {
      const information = await lstat(this.statePath);
      if (!information.isFile() || information.isSymbolicLink() || (information.mode & 0o077) !== 0) throw new Error("ingest recovery state must be a protected regular file");
      return validateRecoveryState(JSON.parse(await readFile(this.statePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    validateRecoveryState(state);
    const parent = dirname(this.statePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, this.statePath);
    await chmod(this.statePath, 0o600);
  }

  async withLock(operation) {
    const parent = dirname(this.statePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    return withProcessLock({ lockPath: this.lockPath, label: "ingest recovery" }, operation);
  }
}

export class IngestRecoveryError extends Error {
  constructor(message, state) {
    super(message);
    this.name = "IngestRecoveryError";
    this.state = structuredClone(state);
  }
}

export function recoveryTopology(manifest, lifecycleState, anchors) {
  if (manifest?.schemaVersion !== 6 || manifest.kind !== "production" || !Array.isArray(manifest.droplets) || manifest.droplets.length !== 12) throw new Error("ingest recovery requires the exact production event manifest");
  if (lifecycleState?.event !== manifest.event || !new Set(["ready", "live"]).has(lifecycleState.phase)) throw new Error("ingest recovery requires matching ready or live lifecycle state");
  const primarySpec = only(manifest.droplets.filter((entry) => entry.role === "ingest"), "primary ingest");
  const observabilitySpec = only(manifest.droplets.filter((entry) => entry.role === "observability"), "observability host");
  const spareSpec = only(manifest.droplets.filter((entry) => entry.role === "compositor-spare" && entry.warmSpare === true), "warm compositor spare");
  const compositorSpecs = manifest.droplets.filter((entry) => entry.role === "compositor").sort((left, right) => left.court - right.court);
  if (JSON.stringify(compositorSpecs.map((entry) => entry.court)) !== JSON.stringify(CAMERA_NUMBERS)) throw new Error("ingest recovery requires eight ordered camera compositors");
  const resource = (spec) => {
    const value = lifecycleState.droplets?.[spec.name];
    if (!value || value.status === "destroyed" || String(value.id ?? "") === "" || !isIpv4(value.publicIpv4) || !isPrivateIpv4(value.privateIpv4)) throw new Error(`${spec.name} lifecycle identity is incomplete`);
    return { name: spec.name, providerName: spec.providerName, dropletId: String(value.id), publicIpv4: value.publicIpv4, privateIpv4: value.privateIpv4 };
  };
  const reservedIpv4 = anchors?.reservedIpv4?.ingest;
  if (!isIpv4(reservedIpv4)) throw new Error("ingest recovery requires the retained ingest Reserved IPv4");
  const ingestEndpoints = manifest.endpoints?.filter((entry) => entry.role === "ingest") ?? [];
  const ingestHostname = only(ingestEndpoints, "ingest endpoint").hostname;
  if (typeof ingestHostname !== "string" || !/^[a-z0-9.-]+$/u.test(ingestHostname) || !ingestHostname.includes(".")) throw new Error("ingest recovery endpoint is invalid");
  const vpcCidr = manifest.provider?.vpcCidr;
  if (typeof vpcCidr !== "string" || !/^10\.(?:\d{1,3}\.){2}0\/\d{1,2}$/u.test(vpcCidr)) throw new Error("ingest recovery VPC is invalid");
  if (typeof primarySpec.tag !== "string" || !primarySpec.tag) throw new Error("ingest recovery firewall tag is invalid");
  return {
    primary: resource(primarySpec),
    spare: resource(spareSpec),
    observability: resource(observabilitySpec),
    compositors: compositorSpecs.map((spec) => ({ ...resource(spec), cameraNumber: spec.court })),
    reservedIpv4,
    ingestHostname,
    vpcCidr,
    ingestFirewallTag: primarySpec.tag
  };
}

export function assertRecoveryTopologyCurrent(state, manifest, lifecycleState, anchors) {
  validateRecoveryState(state);
  requireMatchingTopology(state.topology, recoveryTopology(manifest, lifecycleState, anchors));
  return state.topology;
}

export function validateRecoveryState(value) {
  if (!value || value.schemaVersion !== 3 || typeof value.event !== "string" || !value.event || typeof value.recoveryId !== "string" || !value.recoveryId) throw new Error("ingest recovery state identity is invalid");
  if (!PHASES.has(value.phase) || !new Set(["primary", "spare"]).has(value.activeHost)) throw new Error("ingest recovery state phase is invalid");
  for (const field of ["startedAt", "updatedAt"]) if (!Number.isFinite(Date.parse(value[field]))) throw new Error(`ingest recovery ${field} is invalid`);
  if (value.phase === "PREPARING" ? value.preparedAt !== null : !Number.isFinite(Date.parse(value.preparedAt))) throw new Error("ingest recovery preparedAt is invalid");
  recoveryTopologyFromState(value.topology);
  if (value.outputGenerations !== null) validateOutputGenerations(value.outputGenerations, value.topology.compositors, value.event);
  if (value.resumePhase !== null && !new Set(["TAKING_OVER", "ROLLING_BACK"]).has(value.resumePhase)) throw new Error("ingest recovery resume phase is invalid");
  if (value.failure !== null && (typeof value.failure !== "string" || !value.failure)) throw new Error("ingest recovery failure is invalid");
  if (!Array.isArray(value.timeline) || value.timeline.length < 1 || value.timeline.some((entry) => !Number.isFinite(Date.parse(entry?.at)) || typeof entry.event !== "string" || !entry.event)) throw new Error("ingest recovery timeline is invalid");
  validatePhaseState(value);
  return value;
}

function recoveryTopologyFromState(value) {
  if (!value || !isIpv4(value.reservedIpv4)
    || typeof value.ingestHostname !== "string" || !/^[a-z0-9.-]+$/u.test(value.ingestHostname) || !value.ingestHostname.includes(".")
    || typeof value.vpcCidr !== "string" || !/^10\.(?:\d{1,3}\.){2}0\/\d{1,2}$/u.test(value.vpcCidr)
    || typeof value.ingestFirewallTag !== "string" || !value.ingestFirewallTag) throw new Error("ingest recovery topology is invalid");
  for (const host of [value.primary, value.spare, value.observability, ...(value.compositors ?? [])]) {
    if (!host || typeof host.name !== "string" || !host.name || typeof host.dropletId !== "string" || !host.dropletId || !isIpv4(host.publicIpv4) || !isPrivateIpv4(host.privateIpv4)) throw new Error("ingest recovery host identity is invalid");
  }
  if (JSON.stringify(value.compositors.map((entry) => entry.cameraNumber)) !== JSON.stringify(CAMERA_NUMBERS)) throw new Error("ingest recovery compositor topology is invalid");
}

function validateOutputGenerations(value, compositors, event) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ingest recovery output generations are missing");
  const cameras = compositors.map((entry) => String(entry.cameraNumber));
  if (JSON.stringify(Object.keys(value).sort((left, right) => Number(left) - Number(right))) !== JSON.stringify(cameras)) throw new Error("ingest recovery output generations do not match the compositor set");
  for (const camera of cameras) {
    const generation = value[camera];
    if (!generation || generation.schemaVersion !== 1 || generation.court !== Number(camera)) throw new Error(`Camera ${camera} output generation is invalid`);
    if (generation.event !== event) throw new Error(`Camera ${camera} output generation belongs to a different event`);
    for (const field of ["event", "destinationId", "outputGeneration"]) {
      if (typeof generation[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(generation[field])) throw new Error(`Camera ${camera} output generation is invalid`);
    }
    if (!new Set(["1080p30", "1080p60"]).has(generation.outputProfile)
      || !/^[a-f0-9]{40}$/u.test(generation.rendererGitSha ?? "")
      || !/^dpl_[A-Za-z0-9]+$/u.test(generation.rendererDeploymentId ?? "")
      || !/^EG_[A-Za-z0-9]+$/u.test(generation.egressId ?? "")
      || !/^[a-f0-9]{64}$/u.test(generation.requestSha256 ?? "")
      || !Number.isFinite(Date.parse(generation.startedAt ?? ""))) {
      throw new Error(`Camera ${camera} output generation is invalid`);
    }
  }
}

function validatePhaseState(value) {
  const outputCaptured = value.outputGenerations !== null;
  const failed = value.failure !== null;
  const expected = {
    PREPARING: ["primary", false, false, null],
    PREPARED: ["primary", false, false, null],
    TAKING_OVER: ["primary", null, false, null],
    ACTIVE_ON_SPARE: ["spare", true, false, null],
    ROLLING_BACK: ["spare", true, false, null],
    ROLLED_BACK: ["primary", true, false, null],
    FAILED: [null, null, true, "failure"]
  }[value.phase];
  const resumeValid = expected[3] === "failure" ? new Set(["TAKING_OVER", "ROLLING_BACK"]).has(value.resumePhase) : value.resumePhase === expected[3];
  if ((expected[0] !== null && value.activeHost !== expected[0]) || (expected[1] !== null && outputCaptured !== expected[1]) || failed !== expected[2] || !resumeValid) {
    throw new Error("ingest recovery phase state is inconsistent");
  }
}

function requireMatchingTopology(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("ingest recovery topology changed while preparation was incomplete");
}

function requirePhase(state, phases) {
  const allowed = Array.isArray(phases) ? phases : [phases];
  if (!allowed.includes(state.phase)) throw new Error(`ingest recovery requires phase ${allowed.join(" or ")}`);
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`ingest recovery requires exact confirmation ${expected}`);
}

function only(values, label) {
  if (values.length !== 1) throw new Error(`ingest recovery requires exactly one ${label}`);
  return values[0];
}

function isIpv4(value) {
  if (typeof value !== "string") return false;
  const octets = value.split(".").map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

function isPrivateIpv4(value) {
  if (!isIpv4(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]+/gu, " ").slice(0, 500);
}
