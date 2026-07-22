import { randomUUID } from "node:crypto";

const PHASES = new Set(["PREPARING", "PREPARED", "BACKUP_ACTIVE", "PRIMARY_STOPPED", "PRIMARY_RESTORED", "BACKUP_STOPPED", "ROLLED_BACK"]);
const REQUIRED_EVIDENCE = ["dualIngest", "continuity", "backupOnly", "dualRestored", "primaryOnly"];
const REQUIRED_TIMELINE = [
  "backup-assignment-staged",
  "backup-egress-active",
  "viewer-continuity-started",
  "primary-egress-stopped",
  "primary-egress-restored",
  "backup-egress-stopped",
  "backup-assignment-removed",
  "viewer-continuity-completed"
];

export class YoutubeBackupRehearsalController {
  constructor({ platform, checkpoint = async () => {}, now = () => Date.now() }) {
    this.platform = platform;
    this.checkpoint = checkpoint;
    this.now = now;
  }

  async run(input) {
    try {
      return await this.#run(input);
    } finally {
      await this.platform.closeContinuity?.().catch(() => {});
    }
  }

  async #run({ context, state = null }) {
    const expected = validateContext(context);
    let current = state ? validateYoutubeBackupState(state, expected) : createState(expected, this.now);

    if (current.phase === "PREPARING") {
      current.assignment = await this.platform.stageAssignment(expected);
      current.phase = "PREPARED";
      current.timeline.push(timeline(this.now, "backup-assignment-staged"));
      await this.#save(current);
    }
    if (current.phase === "PREPARED") {
      const backup = await this.platform.ensureBackupStarted({ ...expected, owner: current.backupOwner, assignment: current.assignment });
      current.backupEgressId = backup.id;
      current.phase = "BACKUP_ACTIVE";
      current.timeline.push(timeline(this.now, "backup-egress-active"));
      await this.#save(current);
    }
    if (current.phase === "BACKUP_ACTIVE") {
      current.evidence.dualIngest = await this.platform.capture({ ...expected, backupOwner: current.backupOwner, primaryEgressId: current.primaryEgressId, backupEgressId: current.backupEgressId, label: "dual-ingest", primaryExpected: true, backupExpected: true });
      if (current.evidence.dualIngest.passed !== true) {
        const primary = await this.platform.ensurePrimaryStarted({ ...expected, owner: current.primaryOwner });
        current.primaryEgressId = primary.id;
        await this.platform.ensureBackupStopped({ ...expected, owner: current.backupOwner, egressId: current.backupEgressId });
        current.phase = "BACKUP_STOPPED";
        current.timeline.push(timeline(this.now, "backup-egress-stopped"));
        await this.#save(current);
        await this.platform.cleanupAssignment({ ...expected, assignment: current.assignment });
        current.phase = "ROLLED_BACK";
        current.timeline.push(timeline(this.now, "backup-assignment-removed"));
        await this.#save(current);
      } else {
        current.evidence.continuity = await this.platform.startContinuity(expected);
        current.timeline.push(timeline(this.now, "viewer-continuity-started"));
        await this.#save(current);
        await this.platform.markContinuity("primary-stop-requested");
        await this.platform.ensurePrimaryStopped({ ...expected, owner: current.primaryOwner, egressId: current.primaryEgressId });
        await this.platform.markContinuity("primary-stopped");
        current.phase = "PRIMARY_STOPPED";
        current.timeline.push(timeline(this.now, "primary-egress-stopped"));
        await this.#save(current);
      }
    }
    if (current.phase === "PRIMARY_STOPPED") {
      current.evidence.backupOnly = await this.platform.capture({ ...expected, backupOwner: current.backupOwner, primaryEgressId: current.primaryEgressId, backupEgressId: current.backupEgressId, label: "backup-only", primaryExpected: false, backupExpected: true });
      await this.platform.markContinuity("backup-only-verified");
      await this.platform.markContinuity("primary-start-requested");
      const primary = await this.platform.ensurePrimaryStarted({ ...expected, owner: current.primaryOwner });
      await this.platform.markContinuity("primary-restored");
      current.primaryEgressId = primary.id;
      current.phase = "PRIMARY_RESTORED";
      current.timeline.push(timeline(this.now, "primary-egress-restored"));
      await this.#save(current);
    }
    if (current.phase === "PRIMARY_RESTORED") {
      current.evidence.dualRestored = await this.platform.capture({ ...expected, backupOwner: current.backupOwner, primaryEgressId: current.primaryEgressId, backupEgressId: current.backupEgressId, label: "dual-restored", primaryExpected: true, backupExpected: true });
      await this.platform.markContinuity("dual-restored-verified");
      await this.platform.markContinuity("backup-stop-requested");
      await this.platform.ensureBackupStopped({ ...expected, owner: current.backupOwner, egressId: current.backupEgressId });
      await this.platform.markContinuity("backup-stopped");
      current.phase = "BACKUP_STOPPED";
      current.timeline.push(timeline(this.now, "backup-egress-stopped"));
      await this.#save(current);
    }
    if (current.phase === "BACKUP_STOPPED") {
      await this.platform.cleanupAssignment({ ...expected, assignment: current.assignment });
      current.phase = "ROLLED_BACK";
      current.timeline.push(timeline(this.now, "backup-assignment-removed"));
      await this.#save(current);
    }
    current.evidence.primaryOnly = await this.platform.capture({ ...expected, backupOwner: current.backupOwner, primaryEgressId: current.primaryEgressId, backupEgressId: current.backupEgressId, label: "primary-only", primaryExpected: true, backupExpected: false });
    if (current.evidence.continuity?.status === "RUNNING") {
      await this.platform.markContinuity("primary-only-verified");
      current.evidence.continuity = await this.platform.finishContinuity(current.evidence.continuity);
      current.timeline.push(timeline(this.now, "viewer-continuity-completed"));
    }
    current.completedAt = new Date(this.now()).toISOString();
    current.report = evaluateYoutubeBackupRehearsal(current);
    await this.#save(current);
    return current;
  }

  async #save(state) {
    validateYoutubeBackupState(state);
    await this.checkpoint(structuredClone(state));
  }
}

export function evaluateYoutubeBackupRehearsal(input) {
  const state = validateYoutubeBackupState(input);
  const problems = [];
  if (state.phase !== "ROLLED_BACK") problems.push("YouTube backup rehearsal did not return to primary-only output");
  for (const label of REQUIRED_EVIDENCE) {
    const evidence = state.evidence[label];
    if (!evidence || evidence.passed !== true || evidence.label !== kebab(label)) problems.push(`${kebab(label)} evidence did not pass`);
  }
  const events = state.timeline.map((entry) => entry.event);
  for (const expected of REQUIRED_TIMELINE) {
    if (events.filter((value) => value === expected).length !== 1) problems.push(`${expected} was not recorded exactly once`);
  }
  const positions = REQUIRED_TIMELINE.map((event) => events.indexOf(event));
  if (!positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]))) problems.push("YouTube backup lifecycle events are not in the required order");
  return {
    schemaVersion: 1,
    classification: problems.length ? "FAIL" : "PASS",
    event: state.event,
    generation: state.generation,
    camera: state.camera,
    rehearsalId: state.rehearsalId,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    primary: { host: state.primaryHost, egressId: state.primaryEgressId, destinationRole: "primary" },
    backup: { host: state.spareHost, egressId: state.backupEgressId, destinationRole: "backup" },
    evidence: state.evidence,
    problems
  };
}

export function validateYoutubeBackupState(value, expected = null) {
  if (!value || value.schemaVersion !== 1 || !PHASES.has(value.phase)) throw new Error("YouTube backup rehearsal state is invalid");
  for (const field of ["event", "generation", "profile", "streamId", "broadcastId", "rehearsalId"]) validateIdentifier(value[field], field);
  validateCourt(value.camera);
  validateHost(value.primaryHost);
  validateHost(value.spareHost);
  if (value.primaryHost === value.spareHost) throw new Error("YouTube backup rehearsal hosts must differ");
  validateOwner(value.primaryOwner, "primary");
  validateOwner(value.backupOwner, "backup");
  if (!/^EG_[A-Za-z0-9]+$/u.test(value.primaryEgressId ?? "")) throw new Error("YouTube backup primary Egress id is invalid");
  if (value.backupEgressId !== null && !/^EG_[A-Za-z0-9]+$/u.test(value.backupEgressId)) throw new Error("YouTube backup Egress id is invalid");
  if (!Number.isFinite(Date.parse(value.startedAt ?? "")) || (value.completedAt !== null && !Number.isFinite(Date.parse(value.completedAt)))) throw new Error("YouTube backup rehearsal timestamps are invalid");
  if (!Array.isArray(value.timeline) || !value.evidence || typeof value.evidence !== "object") throw new Error("YouTube backup rehearsal evidence is invalid");
  if (expected) {
    for (const field of ["event", "generation", "camera", "primaryHost", "spareHost", "profile", "streamId", "broadcastId"]) {
      if (value[field] !== expected[field]) throw new Error(`YouTube backup rehearsal ${field} changed`);
    }
  }
  return value;
}

function createState(context, now) {
  const rehearsalId = `youtube-backup-${randomUUID()}`;
  return {
    schemaVersion: 1,
    phase: "PREPARING",
    event: context.event,
    generation: context.generation,
    camera: context.camera,
    primaryHost: context.primaryHost,
    spareHost: context.spareHost,
    profile: context.profile,
    streamId: context.stream.id,
    broadcastId: context.broadcastId,
    rehearsalId,
    primaryOwner: context.primaryOwner,
    backupOwner: {
      event: context.event,
      destinationId: context.primaryOwner.destinationId,
      destinationRole: "backup",
      outputGeneration: `backup-${context.camera}-${rehearsalId.slice(-36)}`,
      rendererGitSha: context.primaryOwner.rendererGitSha,
      rendererDeploymentId: context.primaryOwner.rendererDeploymentId
    },
    primaryEgressId: context.primaryOwner.egressId,
    backupEgressId: null,
    assignment: null,
    evidence: {},
    timeline: [],
    startedAt: new Date(now()).toISOString(),
    completedAt: null,
    report: null
  };
}

function validateContext(value) {
  if (!value || typeof value !== "object") throw new Error("YouTube backup rehearsal context is required");
  for (const field of ["event", "generation", "profile", "broadcastId"]) validateIdentifier(value[field], field);
  validateCourt(value.camera);
  validateHost(value.primaryHost);
  validateHost(value.spareHost);
  if (value.primaryHost === value.spareHost) throw new Error("YouTube backup rehearsal hosts must differ");
  validateOwner(value.primaryOwner, "primary");
  if (value.primaryOwner.court !== value.camera || value.primaryOwner.event !== value.event || value.primaryOwner.destinationId !== value.broadcastId) throw new Error("YouTube backup primary owner does not match the gate");
  if (!value.stream || value.stream.id === undefined || value.stream.court !== value.camera) throw new Error("YouTube backup stream does not match the gate");
  return { ...value, streamId: value.stream.id };
}

function validateOwner(value, role) {
  if (!value || value.schemaVersion !== undefined && value.schemaVersion !== 2) throw new Error(`YouTube backup ${role} owner is invalid`);
  for (const field of ["event", "destinationId", "outputGeneration"]) validateIdentifier(value[field], `${role} owner ${field}`);
  if (value.destinationRole !== role || !/^[a-f0-9]{40}$/u.test(value.rendererGitSha ?? "") || !/^dpl_[A-Za-z0-9]+$/u.test(value.rendererDeploymentId ?? "")) throw new Error(`YouTube backup ${role} owner is invalid`);
  if (role === "primary" && (!Number.isInteger(value.court) || !/^EG_[A-Za-z0-9]+$/u.test(value.egressId ?? ""))) throw new Error("YouTube backup primary owner is invalid");
}

function timeline(now, event) { return { at: new Date(now()).toISOString(), event }; }
function kebab(value) { return value.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`); }
function validateCourt(value) { if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error("YouTube backup camera must be from 1 through 8"); }
function validateHost(value) { if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value ?? "")) throw new Error("YouTube backup host must be an IPv4 address"); }
function validateIdentifier(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(value)) throw new Error(`YouTube backup ${label} is invalid`); }
