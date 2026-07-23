#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadVenueAdmission } from "./venue-admission.mjs";
import { ProductionYouTubeProvider, readProductionDestinations } from "./production-youtube.mjs";
import { withQualificationGateLock } from "./qualification-gate-lock.mjs";
import { EgressRuntime } from "./rehearsal/egress-runtime.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { YoutubeBackupAssignmentRuntime } from "./youtube-backup-assignment.mjs";
import { YoutubeBackupRehearsalController, validateYoutubeBackupState } from "./youtube-backup-rehearsal.mjs";
import { YoutubeBackupObserver, YoutubeBackupPlatform } from "./youtube-backup-runtime.mjs";
import { YouTubeViewerProbe } from "./youtube-viewer-probe.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const statePath = join(options.evidence, "youtube-backup-state.json");
  if (options.command === "status") {
    const state = await readState(statePath);
    process.stdout.write(`${JSON.stringify(state?.report ?? state ?? { status: "NOT_STARTED" }, null, 2)}\n`);
    return;
  }
  const runtime = await createRuntime(options);
  const expectedConfirmation = `YOUTUBE-BACKUP:${runtime.context.event}:${runtime.context.generation}:CAMERA-${runtime.context.camera}`;
  if (options.confirm !== expectedConfirmation) throw new Error(`confirmation must be exactly ${expectedConfirmation}`);
  await mkdir(options.evidence, { recursive: true, mode: 0o700 });
  await chmod(options.evidence, 0o700);
  const state = await withQualificationGateLock(
    { profile: runtime.profile, lifecycleState: runtime.lifecycleState, gate: `YouTube backup Camera ${options.camera}` },
    async () => {
      const controller = new YoutubeBackupRehearsalController({
        platform: runtime.platform,
        checkpoint: (value) => writeState(statePath, value)
      });
      return controller.run({ context: runtime.context, state: await readState(statePath) });
    }
  );
  await writeProtected(join(options.evidence, "youtube-backup-report.json"), state.report);
  process.stdout.write(`${JSON.stringify(state.report, null, 2)}\n`);
  if (state.report.classification !== "PASS") throw new Error("YouTube backup rehearsal classified FAIL; primary-only rollback evidence was preserved");
}

export async function createRuntime(options, dependencies = {}) {
  const profile = await readProtectedJson(options.profile, "event operator profile");
  if (profile.schemaVersion !== 9) throw new Error("YouTube backup rehearsal requires event operator profile schema 9");
  const manifest = await readProtectedJson(profile.manifest, "event manifest");
  const lifecycleState = await readProtectedJson(profile.state, "event lifecycle state");
  if (manifest.kind !== "production" || manifest.droplets?.length !== 12 || lifecycleState.event !== manifest.event || lifecycleState.phase !== "live") {
    throw new Error("YouTube backup rehearsal requires the matching live 12-host production event");
  }
  const venue = await loadVenueAdmission(profile.venueProfile, manifest.event);
  if (!venue.passed || !venue.activeCameras.includes(options.camera)) throw new Error(`Camera ${options.camera} is not admitted by the live venue profile`);
  requireTierOneCamera(venue, options.camera);
  const destinations = await readProductionDestinations(options.destinations, { event: manifest.event, activeCameras: venue.activeCameras });
  const soakState = await readProtectedJson(join(options.soakEvidence, "production-soak-state.json"), "production soak state");
  if (soakState.phase !== "RUNNING" || soakState.event !== manifest.event
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(soakState.runId ?? "")
    || !soakState.activeCameras?.includes(options.camera)
    || soakState.runBinding?.destinations?.[options.camera]?.broadcastId !== destinations.broadcasts[options.camera].id) {
    throw new Error("YouTube backup rehearsal requires the matching RUNNING production soak");
  }
  const profileName = soakState.profiles?.[options.camera]?.profile;
  if (!new Set(["1080p30", "1080p60"]).has(profileName)) throw new Error(`Camera ${options.camera} has no active production output profile`);
  const primary = hostFor(manifest, lifecycleState, (entry) => entry.role === "compositor" && entry.court === options.camera, `Camera ${options.camera} compositor`);
  const spare = hostFor(manifest, lifecycleState, (entry) => entry.role === "compositor-spare" && entry.warmSpare === true, "warm compositor spare");
  const egress = dependencies.egress ?? new EgressRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts });
  const primaryOwner = await egress.readOwnership(primary.host, options.camera);
  if (soakState.egress?.[options.camera]?.id !== primaryOwner.egressId || primaryOwner.outputGeneration !== soakState.runId) throw new Error("Camera primary Egress is not owned by this production soak");
  await egress.reconcileOwned({ host: primary.host, court: options.camera, profile: profileName, owner: primaryOwner, expectedId: primaryOwner.egressId });
  const environment = await loadProtectedEnv(profile.credentialsEnv);
  const monitorEnvironment = await loadProtectedEnv(join(profile.secrets, "observability.env"));
  const monitorEndpoint = manifest.endpoints.find((entry) => entry.role === "observability");
  if (!monitorEndpoint?.hostname) throw new Error("production manifest has no observability endpoint");
  const youtube = dependencies.youtube ?? new ProductionYouTubeProvider({
    clientId: required(environment.YOUTUBE_CLIENT_ID, "YouTube client id"),
    clientSecret: required(environment.YOUTUBE_CLIENT_SECRET, "YouTube client secret"),
    refreshToken: required(environment.YOUTUBE_REFRESH_TOKEN, "YouTube refresh token")
  });
  const observer = dependencies.observer ?? new YoutubeBackupObserver({
    monitorOrigin: `https://${monitorEndpoint.hostname}`,
    monitorToken: required(monitorEnvironment.MONITOR_API_TOKEN, "monitor API token"),
    youtube,
    viewer: dependencies.viewer ?? new YouTubeViewerProbe(),
    destinations,
    profiles: soakState.profiles,
    venue
  });
  const assignment = dependencies.assignment ?? new YoutubeBackupAssignmentRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts });
  const platform = dependencies.platform ?? new YoutubeBackupPlatform({ egress, assignment, observer });
  return {
    profile,
    lifecycleState,
    platform,
    context: {
      event: manifest.event,
      generation: soakState.runId,
      camera: options.camera,
      primaryHost: primary.host,
      spareHost: spare.host,
      profile: profileName,
      stream: destinations.streams[options.camera],
      broadcastId: destinations.broadcasts[options.camera].id,
      primaryOwner
    }
  };
}

export function requireTierOneCamera(venue, camera) {
  const assignment = venue?.assignments?.[camera];
  if (!assignment || assignment.priorityTier !== "TIER_1") throw new Error(`Camera ${camera} is not a Tier 1 priority court`);
  return assignment;
}

function hostFor(manifest, lifecycleState, predicate, label) {
  const matches = manifest.droplets.filter(predicate);
  if (matches.length !== 1) throw new Error(`production manifest must contain exactly one ${label}`);
  const host = lifecycleState.droplets?.[matches[0].name]?.publicIpv4;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host ?? "")) throw new Error(`${label} has no live IPv4`);
  return { name: matches[0].name, host };
}

async function readProtectedJson(path, label) {
  requireAbsolute(path, label);
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readState(path) {
  try { return validateYoutubeBackupState(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function writeState(path, value) {
  validateYoutubeBackupState(value);
  await writeProtected(path, value);
}

async function writeProtected(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return null;
  const command = argv[0];
  if (!new Set(["run", "status"]).has(command)) return null;
  const options = { command, profile: null, destinations: null, soakEvidence: null, evidence: null, camera: null, confirm: null };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => argv[++index] ?? "";
    if (value === "--profile") options.profile = next();
    else if (value === "--destinations") options.destinations = next();
    else if (value === "--soak-evidence") options.soakEvidence = next();
    else if (value === "--evidence") options.evidence = next();
    else if (value === "--camera") options.camera = Number(next());
    else if (value === "--confirm") options.confirm = next();
    else throw new Error(`unknown argument ${value}`);
  }
  requireAbsolute(options.evidence, "evidence directory");
  if (command === "run") {
    for (const [field, label] of [["profile", "profile"], ["destinations", "destinations"], ["soakEvidence", "soak evidence"]]) requireAbsolute(options[field], label);
    if (!Number.isInteger(options.camera) || options.camera < 1 || options.camera > 8) throw new Error("camera must be from 1 through 8");
    if (!options.confirm) throw new Error("explicit confirmation is required");
  }
  return options;
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
}
function required(value, label) { if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) throw new Error(`${label} is required`); return value.trim(); }
function usage() {
  process.stdout.write("Usage:\n  node infra/event-stack/youtube-backupctl.mjs run --profile /PROTECTED/event-profile.json --destinations /PROTECTED/destinations.json --soak-evidence /PROTECTED/soak --evidence /PROTECTED/backup-gate --camera 1 --confirm YOUTUBE-BACKUP:<event>:<run-id>:CAMERA-1\n  node infra/event-stack/youtube-backupctl.mjs status --evidence /PROTECTED/backup-gate\n");
}
