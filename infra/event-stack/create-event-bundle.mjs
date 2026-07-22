#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { validateAnchorConfig } from "./event-lifecycle.mjs";
import { validateProfile as validateEventProfile } from "./eventctl.mjs";
import { assertNetworkContractDeployable } from "./network-contract.mjs";
import { renderProductionSecretDirectory } from "./production-recovery.mjs";
import { loadRendererBinding } from "./renderer-binding.mjs";
import { createSyntheticRehearsalVenueProfile, evaluateVenueAdmission, loadVenueAdmission } from "./venue-admission.mjs";
import { createSyntheticCommentaryQualification, loadCommentaryQualification } from "./commentary-qualification.mjs";
import { validateRehearsalProfile } from "./rehearsal/rehearsal-stack.mjs";
import { SyntheticPublisherManager } from "./rehearsal/synthetic-publishers.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REHEARSAL_SCRIPT = resolve(dirname(SCRIPT_PATH), "rehearsal/turnkey-rehearsal.mjs");
const COMMENTARY_WORKER = resolve(dirname(SCRIPT_PATH), "rehearsal/commentary-browser-worker.cjs");
const PLAYWRIGHT_PACKAGE = resolve(dirname(SCRIPT_PATH), "node_modules/playwright");
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const execFileAsync = promisify(execFile);

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseBundleArgs(process.argv.slice(2));
  if (!options) return usage();
  const result = await createEventBundle(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function createEventBundle(options, {
  verifyGitIdentity = assertRehearsalGitIdentity,
  verifyCommentaryRuntime = assertCommentaryBrowserRuntime,
  verifyFfmpegRuntime = assertRehearsalFfmpegRuntime
} = {}) {
  validateBundleOptions(options);
  if (options.kind === "rehearsal") await verifyGitIdentity({ repo: options.gitRepo, ref: options.gitRef, sha: options.gitSha });
  if (options.kind === "rehearsal") await verifyCommentaryRuntime();
  await Promise.all([
    assertProtectedFile(options.credentialsEnv, "provider credentials"),
    assertProtectedFile(options.sshKey, "SSH private key"),
    assertProtectedFile(options.lifecycleAttestation, "lifecycle attestation"),
    assertProtectedFile(options.networkSpec, "rendered network contract"),
    ...(options.kind === "production" ? [assertProtectedFile(options.anchors, "production endpoint anchors")] : []),
    ...(options.kind === "production" ? [assertProtectedFile(options.rendererBinding, "production renderer binding")] : []),
    ...(options.kind === "production" ? [assertProtectedFile(options.venueProfile, "production venue profile")] : []),
    ...(options.kind === "production" ? [assertProtectedFile(options.commentaryQualification, "production commentary qualification")] : []),
    ...(options.kind === "production" ? [assertProtectedDirectory(options.productionSource, "production recovery source")] : []),
    ...(options.kind === "rehearsal" ? [assertExecutable(options.ffmpegPath, "FFmpeg")] : [])
  ]);
  if (options.kind === "rehearsal") await verifyFfmpegRuntime(options.ffmpegPath);
  const parent = dirname(options.root);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory() || (parentInfo.mode & 0o077) !== 0) throw new Error("bundle parent directory must be mode 0700 or stricter");
  try {
    await stat(options.root);
    throw new Error("event bundle directory already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const manifestInputs = await loadManifestInputs({ networkSpec: options.networkSpec });
  assertNetworkContractDeployable(manifestInputs.networkSpec);
  const manifest = buildEventManifest({
    event: options.event,
    kind: options.kind,
    destroyAfter: options.destroyAfter,
    ...manifestInputs
  });
  const createdAt = new Date().toISOString();
  const anchorConfig = options.kind === "production"
    ? await readAnchorConfig(options.anchors)
    : {
        schemaVersion: 2,
        provider: "digitalocean",
        region: manifest.provider.region,
        retention: "ephemeral",
        reservedIpv4: {},
        baselineReservedIpv4s: [],
        pendingAllocation: null,
        status: "ready",
        createdAt,
        updatedAt: createdAt,
        readyAt: createdAt,
        timeline: [{ at: createdAt, event: "dynamic-rehearsal-binding-created" }]
      };
  validateAnchorConfig(anchorConfig, manifest);
  const renderer = options.kind === "production" ? await loadRendererBinding(options.rendererBinding) : null;
  const rehearsalVenueProfile = options.kind === "rehearsal" ? createSyntheticRehearsalVenueProfile(manifest.event) : null;
  const venueAdmission = options.kind === "production"
    ? await loadVenueAdmission(options.venueProfile, manifest.event)
    : evaluateVenueAdmission(rehearsalVenueProfile);
  if (!venueAdmission.passed) throw new Error(`venue profile is not admitted: ${venueAdmission.problems.join("; ")}`);
  const venueProfile = options.kind === "production" ? venueAdmission.profile : rehearsalVenueProfile;
  const activeCameras = venueProfile.cameras.filter((camera) => camera.enabled).map((camera) => camera.cameraNumber);
  const commentaryQualification = options.kind === "production"
    ? (await loadCommentaryQualification(options.commentaryQualification, manifest.event, activeCameras)).qualification
    : createSyntheticCommentaryQualification(manifest.event, activeCameras);
  const final = bundlePaths(options.root);
  const temporary = `${options.root}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  const temporaryPaths = bundlePaths(temporary);
  try {
    await writeProtectedJson(temporaryPaths.manifest, manifest);
    await writeProtectedJson(temporaryPaths.venueProfile, venueProfile);
    await writeProtectedJson(temporaryPaths.commentaryQualification, commentaryQualification);
    const anchors = options.kind === "production" ? options.anchors : final.rehearsalBinding;
    if (options.kind === "rehearsal") {
      await writeProtectedJson(temporaryPaths.rehearsalBinding, anchorConfig);
    } else {
      await writeProtectedJson(temporaryPaths.rendererBinding, renderer);
      await renderProductionSecretDirectory({
        manifest,
        sourceDirectory: options.productionSource,
        directory: temporaryPaths.secrets,
        renderer,
        venueProfile
      });
    }
    const eventProfile = {
      schemaVersion: 9,
      manifest: final.manifest,
      state: final.lifecycleState,
      anchors,
      secrets: final.secrets,
      sshKey: options.sshKey,
      knownHosts: final.knownHosts,
      commentaryTlsState: tlsStatePath(parent, manifest, "commentary", "retained-commentary-tls"),
      ingestTlsState: tlsStatePath(parent, manifest, "ingest", "retained-ingest-tls"),
      observabilityTlsState: tlsStatePath(parent, manifest, "observability", "retained-observability-tls"),
      credentialsEnv: options.credentialsEnv,
      lifecycleAttestation: options.lifecycleAttestation,
      rendererBinding: options.kind === "production" ? final.rendererBinding : null,
      venueProfile: final.venueProfile,
      commentaryQualification: final.commentaryQualification,
      evidence: final.finalEvidence,
      rehearsalEvidence: options.kind === "rehearsal" ? final.rehearsalEvidence : null
    };
    validateEventProfile(eventProfile);
    await writeProtectedJson(temporaryPaths.eventProfile, eventProfile);

    let rehearsalProfile = null;
    if (options.kind === "rehearsal") {
      rehearsalProfile = {
        schemaVersion: 2,
        manifest: final.manifest,
        lifecycleState: final.lifecycleState,
        rehearsalState: final.rehearsalState,
        secrets: final.secrets,
        material: final.rehearsalMaterial,
        rehearsalEvidence: final.rehearsalEvidence,
        credentialsEnv: options.credentialsEnv,
        sshKey: options.sshKey,
        knownHosts: final.knownHosts,
        venueProfile: final.venueProfile,
        ffmpegPath: options.ffmpegPath,
        git: { repo: options.gitRepo, repoId: options.gitRepoId, ref: options.gitRef, sha: options.gitSha },
        soakDurationSeconds: options.soakDurationSeconds
      };
      validateRehearsalProfile(rehearsalProfile);
      await writeProtectedJson(temporaryPaths.rehearsalProfile, rehearsalProfile);
    }

    const marker = {
      schemaVersion: 1,
      event: manifest.event,
      kind: manifest.kind,
      namespace: manifest.namespace,
      createdAt,
      destroyAfter: manifest.destroyAfter,
      manifestSha256: sha256(await readFile(temporaryPaths.manifest)),
      eventProfileSha256: sha256(await readFile(temporaryPaths.eventProfile)),
      rendererBindingSha256: renderer ? sha256(await readFile(temporaryPaths.rendererBinding)) : null,
      venueProfileSha256: sha256(await readFile(temporaryPaths.venueProfile)),
      commentaryQualificationSha256: sha256(await readFile(temporaryPaths.commentaryQualification)),
      rehearsalProfileSha256: rehearsalProfile ? sha256(await readFile(temporaryPaths.rehearsalProfile)) : null,
      operator: options.kind === "rehearsal" ? {
        command: process.execPath,
        args: [
          REHEARSAL_SCRIPT,
          "full-dry-run",
          "--event-profile", final.eventProfile,
          "--rehearsal-profile", final.rehearsalProfile,
          "--report", final.turnkeyReport,
          "--confirm", `FULL-DRY-RUN:${manifest.event}`
        ]
      } : {
        command: process.execPath,
        args: [resolve(dirname(SCRIPT_PATH), "eventctl.mjs"), "up", "--profile", final.eventProfile]
      }
    };
    await writeProtectedJson(temporaryPaths.marker, marker);
    await rename(temporary, options.root);
    await chmod(options.root, 0o700);
    return {
      event: manifest.event,
      kind: manifest.kind,
      root: options.root,
      manifest: final.manifest,
      eventProfile: final.eventProfile,
      rehearsalProfile: options.kind === "rehearsal" ? final.rehearsalProfile : null,
      nextCommand: marker.operator
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function parseBundleArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (argv[0] !== "create") throw new Error("first argument must be create");
  const values = { command: "create", soakDurationSeconds: 1_800 };
  const mapping = new Map([
    ["--event", "event"], ["--kind", "kind"], ["--destroy-after", "destroyAfter"], ["--root", "root"],
    ["--credentials-env", "credentialsEnv"], ["--ssh-key", "sshKey"], ["--attestation", "lifecycleAttestation"],
    ["--network-spec", "networkSpec"],
    ["--anchors", "anchors"], ["--production-source", "productionSource"], ["--renderer-binding", "rendererBinding"], ["--venue-profile", "venueProfile"], ["--commentary-qualification", "commentaryQualification"], ["--git-repo", "gitRepo"], ["--git-repo-id", "gitRepoId"], ["--git-ref", "gitRef"], ["--git-sha", "gitSha"],
    ["--ffmpeg", "ffmpegPath"], ["--soak-seconds", "soakDurationSeconds"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    values[key] = key === "soakDurationSeconds" ? Number(value) : value;
  }
  for (const key of ["root", "credentialsEnv", "sshKey", "lifecycleAttestation", "networkSpec", "anchors", "productionSource", "rendererBinding", "venueProfile", "commentaryQualification", "ffmpegPath"]) {
    if (values[key] !== undefined) values[key] = normalizedAbsolute(values[key], `--${key}`);
  }
  return values;
}

function validateBundleOptions(value) {
  if (!value || value.command !== "create") throw new Error("bundle create options are required");
  for (const key of ["event", "kind", "destroyAfter", "root", "credentialsEnv", "sshKey", "lifecycleAttestation", "networkSpec"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`${key} is required`);
  }
  normalizedAbsolute(value.root, "bundle root");
  normalizedAbsolute(value.networkSpec, "rendered network contract");
  if (!new Set(["production", "rehearsal"]).has(value.kind)) throw new Error("kind must be production or rehearsal");
  if (value.kind === "production") {
    if (!value.anchors) throw new Error("production bundle requires --anchors");
    if (!value.productionSource) throw new Error("production bundle requires --production-source");
    if (!value.rendererBinding) throw new Error("production bundle requires --renderer-binding");
    if (!value.venueProfile) throw new Error("production bundle requires --venue-profile");
    if (!value.commentaryQualification) throw new Error("production bundle requires --commentary-qualification");
    for (const key of ["gitRepo", "gitRepoId", "gitRef", "gitSha", "ffmpegPath"]) {
      if (value[key] !== undefined) throw new Error(`production bundle does not accept ${key}`);
    }
  } else {
    if (value.productionSource !== undefined) throw new Error("rehearsal bundle does not accept productionSource");
    if (value.rendererBinding !== undefined) throw new Error("rehearsal bundle does not accept rendererBinding");
    if (value.venueProfile !== undefined) throw new Error("rehearsal bundle does not accept venueProfile");
    if (value.commentaryQualification !== undefined) throw new Error("rehearsal bundle does not accept commentaryQualification");
    for (const key of ["gitRepo", "gitRepoId", "gitRef", "gitSha", "ffmpegPath"]) {
      if (typeof value[key] !== "string" || !value[key]) throw new Error(`rehearsal bundle requires ${key}`);
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.gitRepo) || !/^[A-Za-z0-9._/-]{1,200}$/.test(value.gitRef) || value.gitRef.startsWith("-") || value.gitRef.includes("..") || !/^[a-f0-9]{40}$/.test(value.gitSha)) throw new Error("rehearsal Git identity is invalid");
    if (!Number.isInteger(value.soakDurationSeconds) || value.soakDurationSeconds < 1_800 || value.soakDurationSeconds > 43_200) throw new Error("rehearsal soak must be 1800-43200 seconds");
  }
}

export async function assertCommentaryBrowserRuntime({ run = defaultRunCommentaryPreflight } = {}) {
  const result = await run();
  if (!/playwright chromium ready/i.test(result.stdout ?? "")) {
    throw new Error("rehearsal commentary browser runtime is unavailable; run npm ci --prefix infra/event-stack and npx --prefix infra/event-stack playwright install chromium");
  }
}

export async function assertRehearsalFfmpegRuntime(ffmpegPath, { manager = new SyntheticPublisherManager() } = {}) {
  await manager.preflight(ffmpegPath);
}

async function defaultRunCommentaryPreflight() {
  return execFileAsync(process.execPath, [COMMENTARY_WORKER, "--preflight", "--playwright", PLAYWRIGHT_PACKAGE], { cwd: REPO_ROOT });
}

export async function assertRehearsalGitIdentity({ repo, ref, sha }, { runGit = defaultRunGit } = {}) {
  const remote = normalizeGitHubRemote((await runGit(["remote", "get-url", "origin"])).trim());
  if (remote !== repo) throw new Error("rehearsal Git repository does not match remote origin");
  const local = (await runGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  if (local !== sha) throw new Error(`rehearsal Git SHA does not match local ${ref}`);
  const remoteRef = ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`;
  const remoteRows = (await runGit(["ls-remote", "--exit-code", "origin", remoteRef]))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  if (remoteRows.length !== 1 || remoteRows[0][0] !== sha || remoteRows[0][1] !== remoteRef) {
    throw new Error(`rehearsal Git SHA does not match remote origin ${remoteRef}`);
  }
}

async function defaultRunGit(args) {
  const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  return stdout;
}

function bundlePaths(root) {
  return {
    manifest: join(root, "manifest.json"),
    lifecycleState: join(root, "lifecycle-state.json"),
    rehearsalState: join(root, "rehearsal-state.json"),
    rehearsalBinding: join(root, "rehearsal-endpoint-binding.json"),
    rendererBinding: join(root, "renderer-binding.json"),
    venueProfile: join(root, "venue-profile.json"),
    commentaryQualification: join(root, "commentary-qualification.json"),
    eventProfile: join(root, "event-profile.json"),
    rehearsalProfile: join(root, "rehearsal-profile.json"),
    rehearsalMaterial: join(root, "rehearsal-material.json"),
    secrets: join(root, "secrets"),
    knownHosts: join(root, "known_hosts"),
    finalEvidence: join(root, "final-evidence"),
    rehearsalEvidence: join(root, "rehearsal-evidence"),
    turnkeyReport: join(root, "full-dry-run-report.json"),
    marker: join(root, "BUNDLE.json")
  };
}

async function writeProtectedJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function assertProtectedFile(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a mode-0600 protected file`);
}

async function assertProtectedDirectory(path, label) {
  const information = await stat(path);
  if (!information.isDirectory() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a mode-0700 protected directory`);
}

async function assertExecutable(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o111) === 0) throw new Error(`${label} must be an executable file`);
}

async function readAnchorConfig(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`production endpoint anchors are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function tlsStatePath(parent, manifest, role, directoryName) {
  const hosts = manifest.endpoints.filter((entry) => entry.role === role).map((entry) => entry.hostname).sort();
  const expected = role === "commentary" ? 2 : 1;
  if (hosts.length !== expected) throw new Error(`event manifest must contain exactly ${expected} ${role} TLS endpoint${expected === 1 ? "" : "s"}`);
  return join(parent, directoryName, sha256(Buffer.from(hosts.join("\n"), "utf8")).slice(0, 16));
}

function normalizeGitHubRemote(value) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(value);
  if (!match) throw new Error("rehearsal remote origin must be a GitHub repository");
  return match[1];
}

function usage() {
  process.stdout.write("Usage: node infra/event-stack/create-event-bundle.mjs create --event SLUG --kind production|rehearsal --destroy-after YYYY-MM-DD --root /PROTECTED/DIR --credentials-env FILE --ssh-key FILE --attestation FILE --network-spec /PROTECTED/RENDERED-NETWORK.json [production: --anchors FILE --production-source DIR --renderer-binding FILE --venue-profile FILE --commentary-qualification FILE] [rehearsal: --git-repo OWNER/REPO --git-repo-id ID --git-ref REF --git-sha SHA --ffmpeg FILE --soak-seconds 1800]\n");
}
