import { randomUUID } from "node:crypto";

const CAMERA_NUMBERS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const PHASES = new Set(["PREPARED", "TAKING_OVER", "ACTIVE_ON_SPARE", "ROLLING_BACK", "ROLLED_BACK", "FAILED"]);

export class IngestRecoveryController {
  constructor({ platform, now = () => new Date() }) {
    if (!platform) throw new Error("ingest recovery platform is required");
    this.platform = platform;
    this.now = now;
  }

  async prepare({ manifest, lifecycleState, anchors }) {
    const topology = recoveryTopology(manifest, lifecycleState, anchors);
    await this.platform.assertPrimaryIngestHealthy(topology.primary);
    await this.platform.assertSpareIdle(topology.spare);
    await this.platform.assertCompositorOutputsHealthy(topology.compositors);
    const staged = await this.platform.stageSpareIngest(topology);
    if (staged?.status !== "staged") throw new Error("spare ingest staging did not complete");
    const at = this.now().toISOString();
    return validateRecoveryState({
      schemaVersion: 1,
      event: manifest.event,
      recoveryId: randomUUID(),
      phase: "PREPARED",
      preparedAt: at,
      updatedAt: at,
      topology,
      outputGenerations: null,
      activeHost: "primary",
      failure: null,
      timeline: [{ at, event: "spare-ingest-staged" }]
    });
  }

  async takeover({ state, confirmation }) {
    validateRecoveryState(state);
    requirePhase(state, "PREPARED");
    requireConfirmation(confirmation, `TAKEOVER-INGEST:${state.event}`);
    const topology = state.topology;
    await this.platform.assertPrimaryIngestFailed(topology.primary);
    await this.platform.assertSpareIdle(topology.spare);
    state.phase = "TAKING_OVER";
    this.#record(state, "takeover-started");
    try {
      state.outputGenerations = await this.platform.captureOutputGenerations(topology.compositors);
      validateOutputGenerations(state.outputGenerations, topology.compositors);
      await this.platform.attachIngestNetworkPolicy(topology.spare);
      await this.platform.activateSpareIngest(topology);
      await this.platform.moveReservedIpv4({
        ip: topology.reservedIpv4,
        fromDropletId: topology.primary.dropletId,
        toDropletId: topology.spare.dropletId
      });
      this.#record(state, "reserved-ipv4-moved-to-spare");
      await this.platform.waitIngestPublicHealth(topology.spare);
      for (const compositor of topology.compositors) {
        const generation = state.outputGenerations[compositor.cameraNumber];
        await this.platform.rebindCompositorIngress({ compositor, fromPrivateIpv4: topology.primary.privateIpv4, toPrivateIpv4: topology.spare.privateIpv4 });
        await this.platform.resumeOutputGeneration({ compositor, generation });
      }
      await this.platform.switchIngestMonitoring({ from: topology.primary, to: topology.spare });
      await this.platform.verifyRecoveredIngest({ topology, outputGenerations: state.outputGenerations });
      state.phase = "ACTIVE_ON_SPARE";
      state.activeHost = "spare";
      this.#record(state, "takeover-qualified");
      return validateRecoveryState(state);
    } catch (error) {
      state.phase = "FAILED";
      state.failure = safeError(error);
      this.#record(state, "takeover-failed");
      throw new IngestRecoveryError(state.failure, state);
    }
  }

  async rollback({ state, confirmation }) {
    validateRecoveryState(state);
    requirePhase(state, "ACTIVE_ON_SPARE");
    requireConfirmation(confirmation, `ROLLBACK-INGEST:${state.event}`);
    const topology = state.topology;
    await this.platform.assertPrimaryIngestHealthy(topology.primary);
    await this.platform.assertSpareIngestHealthy(topology.spare);
    state.phase = "ROLLING_BACK";
    this.#record(state, "rollback-started");
    try {
      await this.platform.moveReservedIpv4({
        ip: topology.reservedIpv4,
        fromDropletId: topology.spare.dropletId,
        toDropletId: topology.primary.dropletId
      });
      this.#record(state, "reserved-ipv4-restored-to-primary");
      await this.platform.waitIngestPublicHealth(topology.primary);
      for (const compositor of topology.compositors) {
        const generation = state.outputGenerations[compositor.cameraNumber];
        await this.platform.rebindCompositorIngress({ compositor, fromPrivateIpv4: topology.spare.privateIpv4, toPrivateIpv4: topology.primary.privateIpv4 });
        await this.platform.resumeOutputGeneration({ compositor, generation });
      }
      await this.platform.switchIngestMonitoring({ from: topology.spare, to: topology.primary });
      await this.platform.verifyRecoveredIngest({ topology: { ...topology, activeIngest: topology.primary }, outputGenerations: state.outputGenerations });
      await this.platform.deactivateSpareIngest(topology.spare);
      await this.platform.detachIngestNetworkPolicy(topology.spare);
      await this.platform.restoreSpareCompositor(topology.spare);
      state.phase = "ROLLED_BACK";
      state.activeHost = "primary";
      this.#record(state, "rollback-qualified");
      return validateRecoveryState(state);
    } catch (error) {
      state.phase = "FAILED";
      state.failure = safeError(error);
      this.#record(state, "rollback-failed");
      throw new IngestRecoveryError(state.failure, state);
    }
  }

  #record(state, event) {
    const at = this.now().toISOString();
    state.updatedAt = at;
    state.timeline.push({ at, event });
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
  return {
    primary: resource(primarySpec),
    spare: resource(spareSpec),
    compositors: compositorSpecs.map((spec) => ({ ...resource(spec), cameraNumber: spec.court })),
    reservedIpv4
  };
}

export function validateRecoveryState(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.event !== "string" || !value.event || typeof value.recoveryId !== "string" || !value.recoveryId) throw new Error("ingest recovery state identity is invalid");
  if (!PHASES.has(value.phase) || !new Set(["primary", "spare"]).has(value.activeHost)) throw new Error("ingest recovery state phase is invalid");
  for (const field of ["preparedAt", "updatedAt"]) if (!Number.isFinite(Date.parse(value[field]))) throw new Error(`ingest recovery ${field} is invalid`);
  recoveryTopologyFromState(value.topology);
  if (value.outputGenerations !== null) validateOutputGenerations(value.outputGenerations, value.topology.compositors);
  if (value.failure !== null && (typeof value.failure !== "string" || !value.failure)) throw new Error("ingest recovery failure is invalid");
  if (!Array.isArray(value.timeline) || value.timeline.length < 1 || value.timeline.some((entry) => !Number.isFinite(Date.parse(entry?.at)) || typeof entry.event !== "string" || !entry.event)) throw new Error("ingest recovery timeline is invalid");
  return value;
}

function recoveryTopologyFromState(value) {
  if (!value || !isIpv4(value.reservedIpv4)) throw new Error("ingest recovery topology is invalid");
  for (const host of [value.primary, value.spare, ...(value.compositors ?? [])]) {
    if (!host || typeof host.name !== "string" || !host.name || typeof host.dropletId !== "string" || !host.dropletId || !isIpv4(host.publicIpv4) || !isPrivateIpv4(host.privateIpv4)) throw new Error("ingest recovery host identity is invalid");
  }
  if (JSON.stringify(value.compositors.map((entry) => entry.cameraNumber)) !== JSON.stringify(CAMERA_NUMBERS)) throw new Error("ingest recovery compositor topology is invalid");
}

function validateOutputGenerations(value, compositors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ingest recovery output generations are missing");
  const cameras = compositors.map((entry) => String(entry.cameraNumber));
  if (JSON.stringify(Object.keys(value).sort((left, right) => Number(left) - Number(right))) !== JSON.stringify(cameras)) throw new Error("ingest recovery output generations do not match the compositor set");
  for (const camera of cameras) {
    const generation = value[camera];
    if (!generation || typeof generation.broadcastId !== "string" || !generation.broadcastId || typeof generation.outputGeneration !== "string" || !generation.outputGeneration || typeof generation.profile !== "string" || !new Set(["1080p30", "1080p60"]).has(generation.profile)) throw new Error(`Camera ${camera} output generation is invalid`);
  }
}

function requirePhase(state, phase) {
  if (state.phase !== phase) throw new Error(`ingest recovery requires phase ${phase}`);
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
