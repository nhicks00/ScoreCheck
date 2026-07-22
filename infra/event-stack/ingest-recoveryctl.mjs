#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadManifestInputs, validateEventManifest } from "./event-manifest.mjs";
import { FileStateStore, validateAnchorConfig } from "./event-lifecycle.mjs";
import { IngestRecoveryController, FileIngestRecoveryStateStore, assertRecoveryTopologyCurrent } from "./ingest-recovery.mjs";
import { LocalIngestRecoveryPlatform } from "./ingest-recovery-platform.mjs";
import { assertNetworkContractDeployable } from "./network-contract.mjs";
import { DigitalOceanProvider } from "./providers.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIRECTORY, "../..");

if (isDirectInvocation()) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    usage();
    return;
  }
  const recoveryStore = new FileIngestRecoveryStateStore(options.recoveryState);
  if (options.command === "status") {
    process.stdout.write(`${JSON.stringify(recoverySummary(await recoveryStore.load()), null, 2)}\n`);
    return;
  }

  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  validateEventManifest(manifest, await loadManifestInputs({ networkFromManifest: manifest.network }));
  assertNetworkContractDeployable(manifest.network);
  const lifecycleState = await new FileStateStore(options.lifecycleState).load();
  if (!lifecycleState) throw new Error("event lifecycle state is missing");
  const anchors = validateAnchorConfig(await readProtectedJson(options.anchors, "endpoint anchors"), manifest);
  const credentialEnvironment = await loadProtectedEnv(options.credentialsEnv);
  const digitalOceanToken = requiredEnvironment({ ...process.env, ...credentialEnvironment }, "DIGITALOCEAN_TOKEN");
  const acmeEmail = requiredEnvironment({ ...process.env, ...credentialEnvironment }, "SCORECHECK_ACME_EMAIL");
  const cloud = new DigitalOceanProvider({ token: digitalOceanToken, sshKeys: [], cloudInitPaths: {} });
  const platform = new LocalIngestRecoveryPlatform({
    repoRoot: REPO_ROOT,
    manifest,
    lifecycleState,
    anchors,
    secretsDirectory: options.secrets,
    sshPrivateKey: options.sshKey,
    knownHostsPath: options.knownHosts,
    ingestTlsStateDirectory: options.ingestTlsState,
    acmeEmail,
    cloud
  });
  await platform.assertProtectedInputs();
  const controller = new IngestRecoveryController({ platform, checkpoint: (state) => recoveryStore.save(state) });
  const result = await recoveryStore.withLock(async () => {
    const state = await recoveryStore.load();
    if (options.command === "prepare") {
      return controller.prepare({ manifest, lifecycleState, anchors, state });
    }
    if (!state) throw new Error("ingest recovery has not been prepared");
    assertRecoveryTopologyCurrent(state, manifest, lifecycleState, anchors);
    if (options.command === "takeover") return controller.takeover({ state, confirmation: options.confirm });
    if (options.command === "rollback") return controller.rollback({ state, confirmation: options.confirm });
    throw new Error(`unsupported ingest recovery command ${options.command}`);
  });
  process.stdout.write(`${JSON.stringify(recoverySummary(result), null, 2)}\n`);
}

export function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["prepare", "takeover", "rollback", "status"]).has(command)) throw new Error(`unknown ingest recovery command ${command}`);
  const options = {
    command,
    manifest: null,
    lifecycleState: null,
    anchors: null,
    recoveryState: null,
    secrets: null,
    sshKey: null,
    knownHosts: null,
    ingestTlsState: null,
    credentialsEnv: null,
    confirm: null
  };
  const mappings = new Map([
    ["--manifest", "manifest"],
    ["--lifecycle-state", "lifecycleState"],
    ["--anchors", "anchors"],
    ["--recovery-state", "recoveryState"],
    ["--secrets", "secrets"],
    ["--ssh-key", "sshKey"],
    ["--known-hosts", "knownHosts"],
    ["--ingest-tls-state", "ingestTlsState"],
    ["--credentials-env", "credentialsEnv"],
    ["--confirm", "confirm"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!mappings.has(flag)) throw new Error(`unknown option ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    const key = mappings.get(flag);
    if (options[key] !== null) throw new Error(`${flag} may be specified only once`);
    options[key] = key === "confirm" ? value : absolute(value, flag);
  }
  options.recoveryState = requiredOption(options.recoveryState, "--recovery-state");
  if (command === "status") {
    const extras = ["manifest", "lifecycleState", "anchors", "secrets", "sshKey", "knownHosts", "ingestTlsState", "credentialsEnv", "confirm"].filter((key) => options[key] !== null);
    if (extras.length > 0) throw new Error("status accepts only --recovery-state");
    return options;
  }
  for (const [key, flag] of [
    ["manifest", "--manifest"], ["lifecycleState", "--lifecycle-state"], ["anchors", "--anchors"],
    ["secrets", "--secrets"], ["sshKey", "--ssh-key"], ["knownHosts", "--known-hosts"],
    ["ingestTlsState", "--ingest-tls-state"], ["credentialsEnv", "--credentials-env"]
  ]) options[key] = requiredOption(options[key], flag);
  if (command === "prepare" && options.confirm !== null) throw new Error("prepare does not accept --confirm");
  if (["takeover", "rollback"].includes(command)) options.confirm = requiredOption(options.confirm, "--confirm");
  return options;
}

export function recoverySummary(state) {
  if (state === null) return { status: "ABSENT" };
  return {
    status: state.phase === "FAILED" ? "FAILED" : "PRESENT",
    schemaVersion: state.schemaVersion,
    event: state.event,
    recoveryId: state.recoveryId,
    phase: state.phase,
    activeHost: state.activeHost,
    resumePhase: state.resumePhase,
    startedAt: state.startedAt,
    preparedAt: state.preparedAt,
    updatedAt: state.updatedAt,
    failure: state.failure,
    completedSteps: state.timeline.map((entry) => entry.event)
  };
}

function usage() {
  process.stdout.write(`Usage:
  node infra/event-stack/ingest-recoveryctl.mjs prepare --manifest FILE --lifecycle-state FILE --anchors FILE --recovery-state FILE --secrets DIR --ssh-key FILE --known-hosts FILE --ingest-tls-state DIR --credentials-env FILE
  node infra/event-stack/ingest-recoveryctl.mjs takeover --manifest FILE --lifecycle-state FILE --anchors FILE --recovery-state FILE --secrets DIR --ssh-key FILE --known-hosts FILE --ingest-tls-state DIR --credentials-env FILE --confirm TAKEOVER-INGEST:EVENT
  node infra/event-stack/ingest-recoveryctl.mjs rollback --manifest FILE --lifecycle-state FILE --anchors FILE --recovery-state FILE --secrets DIR --ssh-key FILE --known-hosts FILE --ingest-tls-state DIR --credentials-env FILE --confirm ROLLBACK-INGEST:EVENT
  node infra/event-stack/ingest-recoveryctl.mjs status --recovery-state FILE

Preparation stages a stopped ingest role on the existing compositor spare. Takeover and rollback are explicit, resumable transactions; neither runs automatically.
`);
}

async function readProtectedJson(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be mode 0600 or stricter`);
  return JSON.parse(await readFile(path, "utf8"));
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredOption(value, flag) {
  if (!value) throw new Error(`${flag} is required for this command`);
  return value;
}

function absolute(value, flag) {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${flag} must be a normalized absolute path`);
  return value;
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}
