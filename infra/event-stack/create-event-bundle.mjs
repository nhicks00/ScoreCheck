#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { validateAnchorConfig } from "./event-lifecycle.mjs";
import { validateProfile as validateEventProfile } from "./eventctl.mjs";
import { renderProductionSecretDirectory } from "./production-recovery.mjs";
import { validateRehearsalProfile } from "./rehearsal/rehearsal-stack.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REHEARSAL_SCRIPT = resolve(dirname(SCRIPT_PATH), "rehearsal/turnkey-rehearsal.mjs");

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

export async function createEventBundle(options) {
  validateBundleOptions(options);
  await Promise.all([
    assertProtectedFile(options.credentialsEnv, "provider credentials"),
    assertProtectedFile(options.sshKey, "SSH private key"),
    assertProtectedFile(options.lifecycleAttestation, "lifecycle attestation"),
    ...(options.kind === "production" ? [assertProtectedFile(options.anchors, "production endpoint anchors")] : []),
    ...(options.kind === "production" ? [assertProtectedDirectory(options.productionSource, "production recovery source")] : []),
    ...(options.kind === "rehearsal" ? [assertExecutable(options.ffmpegPath, "FFmpeg"), assertExecutable(options.liveKitCliPath, "LiveKit CLI")] : [])
  ]);
  const parent = dirname(options.root);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory() || (parentInfo.mode & 0o077) !== 0) throw new Error("bundle parent directory must be mode 0700 or stricter");
  try {
    await stat(options.root);
    throw new Error("event bundle directory already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const manifest = buildEventManifest({
    event: options.event,
    kind: options.kind,
    destroyAfter: options.destroyAfter,
    ...await loadManifestInputs()
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
  const final = bundlePaths(options.root);
  const temporary = `${options.root}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  const temporaryPaths = bundlePaths(temporary);
  try {
    await writeProtectedJson(temporaryPaths.manifest, manifest);
    const anchors = options.kind === "production" ? options.anchors : final.rehearsalBinding;
    if (options.kind === "rehearsal") {
      await writeProtectedJson(temporaryPaths.rehearsalBinding, anchorConfig);
    } else {
      await renderProductionSecretDirectory({
        manifest,
        sourceDirectory: options.productionSource,
        directory: temporaryPaths.secrets
      });
    }
    const eventProfile = {
      schemaVersion: 3,
      manifest: final.manifest,
      state: final.lifecycleState,
      anchors,
      secrets: final.secrets,
      sshKey: options.sshKey,
      knownHosts: final.knownHosts,
      credentialsEnv: options.credentialsEnv,
      lifecycleAttestation: options.lifecycleAttestation,
      evidence: final.finalEvidence,
      rehearsalEvidence: options.kind === "rehearsal" ? final.rehearsalEvidence : null
    };
    validateEventProfile(eventProfile);
    await writeProtectedJson(temporaryPaths.eventProfile, eventProfile);

    let rehearsalProfile = null;
    if (options.kind === "rehearsal") {
      rehearsalProfile = {
        schemaVersion: 1,
        manifest: final.manifest,
        lifecycleState: final.lifecycleState,
        rehearsalState: final.rehearsalState,
        secrets: final.secrets,
        material: final.rehearsalMaterial,
        rehearsalEvidence: final.rehearsalEvidence,
        credentialsEnv: options.credentialsEnv,
        sshKey: options.sshKey,
        knownHosts: final.knownHosts,
        ffmpegPath: options.ffmpegPath,
        liveKitCliPath: options.liveKitCliPath,
        git: { repoId: options.gitRepoId, ref: options.gitRef, sha: options.gitSha },
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
    ["--anchors", "anchors"], ["--production-source", "productionSource"], ["--git-repo-id", "gitRepoId"], ["--git-ref", "gitRef"], ["--git-sha", "gitSha"],
    ["--ffmpeg", "ffmpegPath"], ["--livekit-cli", "liveKitCliPath"], ["--soak-seconds", "soakDurationSeconds"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    values[key] = key === "soakDurationSeconds" ? Number(value) : value;
  }
  for (const key of ["root", "credentialsEnv", "sshKey", "lifecycleAttestation", "anchors", "productionSource", "ffmpegPath", "liveKitCliPath"]) {
    if (values[key] !== undefined) values[key] = normalizedAbsolute(values[key], `--${key}`);
  }
  return values;
}

function validateBundleOptions(value) {
  if (!value || value.command !== "create") throw new Error("bundle create options are required");
  for (const key of ["event", "kind", "destroyAfter", "root", "credentialsEnv", "sshKey", "lifecycleAttestation"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`${key} is required`);
  }
  normalizedAbsolute(value.root, "bundle root");
  if (!new Set(["production", "rehearsal"]).has(value.kind)) throw new Error("kind must be production or rehearsal");
  if (value.kind === "production") {
    if (!value.anchors) throw new Error("production bundle requires --anchors");
    if (!value.productionSource) throw new Error("production bundle requires --production-source");
    for (const key of ["gitRepoId", "gitRef", "gitSha", "ffmpegPath", "liveKitCliPath"]) {
      if (value[key] !== undefined) throw new Error(`production bundle does not accept ${key}`);
    }
  } else {
    if (value.productionSource !== undefined) throw new Error("rehearsal bundle does not accept productionSource");
    for (const key of ["gitRepoId", "gitRef", "gitSha", "ffmpegPath", "liveKitCliPath"]) {
      if (typeof value[key] !== "string" || !value[key]) throw new Error(`rehearsal bundle requires ${key}`);
    }
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(value.gitRef) || !/^[a-f0-9]{40}$/.test(value.gitSha)) throw new Error("rehearsal Git identity is invalid");
    if (!Number.isInteger(value.soakDurationSeconds) || value.soakDurationSeconds < 1_800 || value.soakDurationSeconds > 43_200) throw new Error("rehearsal soak must be 1800-43200 seconds");
  }
}

function bundlePaths(root) {
  return {
    manifest: join(root, "manifest.json"),
    lifecycleState: join(root, "lifecycle-state.json"),
    rehearsalState: join(root, "rehearsal-state.json"),
    rehearsalBinding: join(root, "rehearsal-endpoint-binding.json"),
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

function usage() {
  process.stdout.write("Usage: node infra/event-stack/create-event-bundle.mjs create --event SLUG --kind production|rehearsal --destroy-after YYYY-MM-DD --root /PROTECTED/DIR --credentials-env FILE --ssh-key FILE --attestation FILE [production: --anchors FILE --production-source DIR] [rehearsal: --git-repo-id ID --git-ref REF --git-sha SHA --ffmpeg FILE --livekit-cli FILE --soak-seconds 1800]\n");
}
