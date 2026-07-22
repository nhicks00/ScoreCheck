import { setTimeout as delay } from "node:timers/promises";

import { assertProductionMonitorSnapshot, productionProviderProblems, productionSnapshotProblems } from "./production-soak.mjs";

const STABLE_SAMPLES = 3;
const SAMPLE_INTERVAL_MS = 5_000;

export class YoutubeBackupPlatform {
  constructor({ egress, assignment, observer }) {
    this.egress = egress;
    this.assignment = assignment;
    this.observer = observer;
  }

  async stageAssignment(context) {
    await this.egress.preflight(context.spareHost);
    return this.assignment.stage({
      host: context.spareHost,
      event: context.event,
      generation: context.generation,
      court: context.camera,
      stream: context.stream
    });
  }

  async ensureBackupStarted(context) {
    await this.assignment.verify({ host: context.spareHost, assignment: context.assignment });
    return this.egress.ensureStarted({
      host: context.spareHost,
      court: context.camera,
      profile: context.profile,
      owner: context.owner
    });
  }

  async ensurePrimaryStopped(context) {
    return this.egress.stopExact({
      host: context.primaryHost,
      court: context.camera,
      egressId: context.egressId,
      profile: context.profile,
      owner: context.owner
    });
  }

  async ensurePrimaryStarted(context) {
    return this.egress.ensureStarted({
      host: context.primaryHost,
      court: context.camera,
      profile: context.profile,
      owner: context.owner
    });
  }

  async ensureBackupStopped(context) {
    return this.egress.stopExact({
      host: context.spareHost,
      court: context.camera,
      egressId: context.egressId,
      profile: context.profile,
      owner: context.owner
    });
  }

  async cleanupAssignment(context) {
    await this.egress.preflight(context.spareHost);
    return this.assignment.cleanup({ host: context.spareHost, assignment: context.assignment });
  }

  async capture(context) {
    const primary = await this.egress.listActive(context.primaryHost);
    const backup = await this.egress.listActive(context.spareHost);
    if (context.primaryExpected) {
      await this.egress.reconcileOwned({ host: context.primaryHost, court: context.camera, profile: context.profile, owner: context.primaryOwner, expectedId: context.primaryEgressId });
    }
    if (context.backupExpected) {
      await this.egress.reconcileOwned({ host: context.spareHost, court: context.camera, profile: context.profile, owner: context.backupOwner, expectedId: context.backupEgressId });
    }
    return this.observer.capture({ ...context, primary, backup });
  }
}

export class YoutubeBackupObserver {
  constructor({ monitorOrigin, monitorToken, youtube, viewer, destinations, profiles, venue, fetchImpl = globalThis.fetch, sleep = delay, now = () => Date.now() }) {
    this.monitorOrigin = monitorOrigin;
    this.monitorToken = monitorToken;
    this.youtube = youtube;
    this.viewer = viewer;
    this.destinations = destinations;
    this.profiles = profiles;
    this.venue = venue;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
  }

  async capture({ label, camera, primaryExpected, backupExpected, primary, backup }) {
    const samples = [];
    for (let index = 0; index < STABLE_SAMPLES; index += 1) {
      try {
        const snapshot = await this.#snapshot();
        const provider = await this.#provider();
        const sample = evaluateYoutubeBackupSample({
          label,
          camera,
          primaryExpected,
          backupExpected,
          primary,
          backup,
          snapshot,
          provider,
          profiles: this.profiles,
          venue: this.venue,
          nowMs: this.now()
        });
        samples.push(sample);
        if (!sample.passed) break;
        if (index + 1 < STABLE_SAMPLES) await this.sleep(SAMPLE_INTERVAL_MS);
      } catch (error) {
        samples.push({ schemaVersion: 1, label, observedAt: new Date(this.now()).toISOString(), problems: [`evidence capture failed: ${error instanceof Error ? error.message : String(error)}`], passed: false });
        break;
      }
    }
    const viewer = samples.length === STABLE_SAMPLES && samples.every((sample) => sample.passed)
      ? await this.viewer.probe({ camera, broadcastId: this.destinations.broadcasts[camera].id })
      : null;
    const problems = [...new Set([
      ...samples.flatMap((sample) => sample.problems),
      ...(viewer && !viewer.passed ? viewer.problems : []),
      ...(viewer ? [] : ["external viewer probe was not run after stable internal samples"])
    ])];
    return {
      schemaVersion: 1,
      label,
      observedAt: new Date(this.now()).toISOString(),
      primaryExpected,
      backupExpected,
      samples,
      viewer,
      problems,
      passed: samples.length === STABLE_SAMPLES && problems.length === 0
    };
  }

  async #snapshot() {
    const response = await this.fetchImpl(`${this.monitorOrigin}/v1/snapshot`, {
      headers: { authorization: `Bearer ${this.monitorToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`YouTube backup monitor snapshot returned HTTP ${response.status}`);
    return assertProductionMonitorSnapshot(await response.json());
  }

  async #provider() {
    const cameras = [];
    for (const camera of this.venue.activeCameras) {
      cameras.push({
        camera,
        stream: await this.youtube.getStream(this.destinations.streams[camera].id),
        broadcast: await this.youtube.getBroadcast(this.destinations.broadcasts[camera].id)
      });
    }
    return { observedAt: new Date(this.now()).toISOString(), cameras };
  }
}

export function evaluateYoutubeBackupSample({ label, camera, primaryExpected, backupExpected, primary, backup, snapshot, provider, profiles, venue, nowMs }) {
  const problems = productionSnapshotProblems(snapshot, profiles, venue, null, nowMs).filter((problem) => {
    if (problem === "warm spare is not healthy and idle") return false;
    if (problem === `Camera ${camera} program path is not healthy with 1 reader(s)`) return false;
    if (!primaryExpected && problem === `Camera ${camera} output server is not running exactly one healthy Egress with headroom`) return false;
    return true;
  });
  problems.push(...productionProviderProblems(provider, venue.activeCameras));
  const expectedPrimaryCount = primaryExpected ? 1 : 0;
  const expectedBackupCount = backupExpected ? 1 : 0;
  if (!Array.isArray(primary) || primary.length !== expectedPrimaryCount) problems.push(`primary compositor active Egress count is not ${expectedPrimaryCount}`);
  if (!Array.isArray(backup) || backup.length !== expectedBackupCount) problems.push(`backup compositor active Egress count is not ${expectedBackupCount}`);
  const court = snapshot.courts.find((entry) => entry.courtNumber === camera);
  const expectedReaders = expectedPrimaryCount + expectedBackupCount;
  if (!court?.paths?.program?.ready || court.paths.program.readerCount !== expectedReaders || court.paths.program.frameErrors !== 0 || (court.paths.program.inboundBitrateBps ?? 0) <= 0) {
    problems.push(`Camera ${camera} program path does not have exactly ${expectedReaders} healthy reader(s)`);
  }
  const spare = snapshot.agents.find((agent) => agent.role === "worker");
  const spareEgress = spare?.nativeServices?.egress;
  if (!spare || spare.state !== "HEALTHY" || !spareEgress || spareEgress.activeWebRequests !== expectedBackupCount || spareEgress.maximumWebRequests !== 1
    || spareEgress.idle !== !backupExpected || spareEgress.canAcceptRequest !== !backupExpected) {
    problems.push(`warm spare does not match the expected ${backupExpected ? "active backup" : "idle"} state`);
  }
  return {
    schemaVersion: 1,
    label,
    observedAt: snapshot.generatedAt,
    primaryEgressIds: primary.map((entry) => entry.id),
    backupEgressIds: backup.map((entry) => entry.id),
    programReaders: court?.paths?.program?.readerCount ?? null,
    problems: [...new Set(problems)],
    passed: problems.length === 0
  };
}
