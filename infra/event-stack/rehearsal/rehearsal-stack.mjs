#!/usr/bin/env node

import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadManifestInputs, validateEventManifest } from "../event-manifest.mjs";
import { assertNetworkContractDeployable } from "../network-contract.mjs";
import { loadProtectedEnv } from "../stack-deployer.mjs";
import { CommentaryClientManager, buildCommentaryClientConfig } from "./commentary-runtime.mjs";
import { EgressRuntime } from "./egress-runtime.mjs";
import { PoolSamplerRuntime } from "./pool-sampler-runtime.mjs";
import { RehearsalController, RehearsalFileStateStore, rehearsalSummary } from "./rehearsal-controller.mjs";
import { RehearsalSoakEvaluator, sealRehearsalEvidence } from "./rehearsal-evidence.mjs";
import { buildRehearsalVercelEnvironment, completeAgentSecrets, createRehearsalSecretMaterial, loadProtectedSecretMaterial, renderRehearsalSecretDirectory } from "./rehearsal-secrets.mjs";
import { RehearsalVerifier } from "./rehearsal-verifier.mjs";
import { SyntheticPublisherManager, buildSyntheticPublisherConfig } from "./synthetic-publishers.mjs";
import { VercelRehearsalProvider } from "./vercel-provider.mjs";
import { YouTubeRehearsalProvider } from "./youtube-provider.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIRECTORY, "../../..");
const COMMANDS = new Set(["plan", "prepare", "status", "start", "soak", "stop", "cleanup", "seal"]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const profile = await loadProfile(options.profile);
  const manifest = JSON.parse(await readFile(profile.manifest, "utf8"));
  validateEventManifest(manifest, await loadManifestInputs({ networkFromManifest: manifest.network }));
  assertNetworkContractDeployable(manifest.network);
  if (manifest.kind !== "rehearsal") throw new Error("rehearsal operator requires a rehearsal manifest");
  validateConfirmation(options.command, options.confirm, manifest.event);
  const lifecycleState = await readProtectedJson(profile.lifecycleState, "lifecycle state");
  const material = await materialForCommand(options.command, profile.material, manifest);
  const store = new RehearsalFileStateStore(profile.rehearsalState);
  const simple = ["plan", "status", "seal"].includes(options.command);
  const environment = simple ? {} : { ...process.env, ...await loadProtectedEnv(profile.credentialsEnv) };
  const dependencies = simple
    ? inertDependencies()
    : options.command === "cleanup"
      ? providerCleanupDependencies(environment)
      : runtimeDependencies({ profile, manifest, material, environment });
  const controller = new RehearsalController({ store, ...dependencies });
  let result;
  if (options.command === "plan") result = await controller.plan({ manifest, lifecycleState });
  else if (options.command === "prepare") result = await controller.prepare({
    manifest,
    lifecycleState,
    material,
    git: profile.git,
    secretsDirectory: profile.secrets,
    external: externalCredentials(environment)
  });
  else if (options.command === "status") result = await controller.status({ manifest, lifecycleState });
  else if (options.command === "start") result = await controller.start({ manifest, lifecycleState, material, evidenceDirectory: profile.rehearsalEvidence });
  else if (options.command === "soak") result = await controller.soak({ manifest, lifecycleState, evidenceDirectory: profile.rehearsalEvidence, durationMs: profile.soakDurationSeconds * 1_000 });
  else if (options.command === "stop") result = await controller.stop({ manifest, lifecycleState });
  else if (options.command === "cleanup") result = await controller.cleanup({ manifest, lifecycleState });
  else if (options.command === "seal") result = await controller.seal({ manifest, lifecycleState, evidenceDirectory: profile.rehearsalEvidence });
  else throw new Error(`unsupported rehearsal command ${options.command}`);
  process.stdout.write(`${JSON.stringify(result.phase ? rehearsalSummary(result) : result, null, 2)}\n`);
}

function runtimeDependencies({ profile, manifest, material, environment }) {
  const youtube = new YouTubeRehearsalProvider({
    clientId: requiredEnvironment(environment, "YOUTUBE_CLIENT_ID"),
    clientSecret: requiredEnvironment(environment, "YOUTUBE_CLIENT_SECRET"),
    refreshToken: requiredEnvironment(environment, "YOUTUBE_REFRESH_TOKEN")
  });
  const vercel = new VercelRehearsalProvider({
    token: requiredEnvironment(environment, "VERCEL_TOKEN"),
    teamId: requiredEnvironment(environment, "VERCEL_TEAM_ID")
  });
  const publishers = new SyntheticPublisherManager();
  const commentary = new CommentaryClientManager();
  const egress = new EgressRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts });
  const sampler = new PoolSamplerRuntime({ repoRoot: REPO_ROOT, sshKey: profile.sshKey, knownHosts: profile.knownHosts });
  const verifier = new RehearsalVerifier({
    monitorOrigin: `https://${endpointForRole(manifest, "observability")}`,
    monitorToken: material.monitorApiToken,
    youtube,
    sampler
  });
  return {
    vercel,
    youtube,
    publishers,
    commentary,
    egress,
    sampler,
    verifier,
    soakEvaluator: new RehearsalSoakEvaluator({ verifier }),
    sealEvidence: sealRehearsalEvidence,
    renderSecrets: renderRehearsalSecretDirectory,
    programEnvironment: buildRehearsalVercelEnvironment,
    publisherConfiguration: ({ court, state, evidenceDirectory }) => buildSyntheticPublisherConfig({
      court,
      generationId: state.generationId,
      host: endpointForRole(manifest, "ingest"),
      user: material.publishers[court].user,
      password: material.publishers[court].password,
      evidenceDirectory,
      ffmpegPath: profile.ffmpegPath
    }),
    commentaryConfiguration: ({ court, state, evidenceDirectory }) => buildCommentaryClientConfig({
      court,
      generationId: state.generationId,
      material,
      rtcHost: commentaryRtcHost(manifest),
      evidenceDirectory,
      lkPath: profile.liveKitCliPath,
      ffmpegPath: profile.ffmpegPath
    })
  };
}

function inertDependencies() {
  const unavailable = new Proxy({}, { get() { return async () => { throw new Error("runtime dependency is unavailable for this command"); }; } });
  return {
    vercel: unavailable, youtube: unavailable, publishers: unavailable, commentary: unavailable, egress: unavailable,
    sampler: unavailable, verifier: unavailable, soakEvaluator: unavailable,
    sealEvidence: sealRehearsalEvidence,
    renderSecrets: unavailable,
    programEnvironment: unavailable,
    publisherConfiguration: unavailable,
    commentaryConfiguration: unavailable
  };
}

function providerCleanupDependencies(environment) {
  const dependencies = inertDependencies();
  dependencies.youtube = new YouTubeRehearsalProvider({
    clientId: requiredEnvironment(environment, "YOUTUBE_CLIENT_ID"),
    clientSecret: requiredEnvironment(environment, "YOUTUBE_CLIENT_SECRET"),
    refreshToken: requiredEnvironment(environment, "YOUTUBE_REFRESH_TOKEN")
  });
  dependencies.vercel = new VercelRehearsalProvider({
    token: requiredEnvironment(environment, "VERCEL_TOKEN"),
    teamId: requiredEnvironment(environment, "VERCEL_TEAM_ID")
  });
  return dependencies;
}

export function materialModeForCommand(command) {
  if (command === "prepare") return "create-or-load";
  if (["start", "soak", "stop"].includes(command)) return "load";
  if (["plan", "status", "cleanup", "seal"].includes(command)) return "none";
  throw new Error(`unsupported rehearsal command ${command}`);
}

async function materialForCommand(command, path, manifest) {
  const mode = materialModeForCommand(command);
  if (mode === "none") return null;
  if (mode === "create-or-load") return loadOrCreateMaterial(path, manifest);
  return completeAgentSecrets(await loadProtectedSecretMaterial(path), manifest);
}

async function loadOrCreateMaterial(path, manifest) {
  try { return completeAgentSecrets(await loadProtectedSecretMaterial(path), manifest); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const material = completeAgentSecrets(createRehearsalSecretMaterial(), manifest);
  await writeFile(path, `${JSON.stringify(material, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
  return material;
}

export function validateRehearsalProfile(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("rehearsal operator profile schemaVersion must be 1");
  const pathFields = ["manifest", "lifecycleState", "rehearsalState", "secrets", "material", "rehearsalEvidence", "credentialsEnv", "sshKey", "knownHosts", "ffmpegPath", "liveKitCliPath"];
  const expected = ["schemaVersion", ...pathFields, "git", "soakDurationSeconds"].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) throw new Error("rehearsal operator profile must contain exactly the supported fields");
  for (const key of pathFields) normalizedAbsolute(value[key], `profile ${key}`);
  if (!value.git || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.git.repo ?? "") || !new Set(["string", "number"]).has(typeof value.git.repoId) || !/^[a-zA-Z0-9._/-]{1,200}$/.test(value.git.ref ?? "") || !/^[a-f0-9]{40}$/.test(value.git.sha ?? "")) throw new Error("rehearsal operator Git source is invalid");
  if (!Number.isInteger(value.soakDurationSeconds) || value.soakDurationSeconds < 1_800 || value.soakDurationSeconds > 12 * 60 * 60) throw new Error("rehearsal soak must be from 1800 through 43200 seconds");
  return value;
}

export function validateConfirmation(command, confirmation, event) {
  const expected = command === "prepare" ? `PREPARE:${event}` : command === "start" ? `START-REHEARSAL:${event}` : command === "cleanup" ? `CLEANUP:${event}` : null;
  if (expected && confirmation !== expected) throw new Error(`confirmation must be exactly ${expected}`);
  if (!expected && confirmation !== null) throw new Error(`${command} does not accept --confirm`);
}

function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!COMMANDS.has(command)) throw new Error("first argument must be plan, prepare, status, start, soak, stop, cleanup, or seal");
  const options = { command, profile: null, confirm: null };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--profile") options.profile = normalizedAbsolute(value, flag);
    else if (flag === "--confirm") options.confirm = value;
    else throw new Error(`unknown rehearsal operator option ${flag}`);
  }
  if (!options.profile) throw new Error("--profile is required");
  return options;
}

async function loadProfile(path) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("rehearsal operator profile must be mode 0600 or stricter");
  return validateRehearsalProfile(JSON.parse(await readFile(path, "utf8")));
}

async function readProtectedJson(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be mode 0600 or stricter`);
  return JSON.parse(await readFile(path, "utf8"));
}

function externalCredentials(environment) {
  return {
    ...(environment.PUSHOVER_APP_TOKEN?.trim() && environment.PUSHOVER_USER_KEY?.trim() ? { pushoverAppToken: environment.PUSHOVER_APP_TOKEN.trim(), pushoverUserKey: environment.PUSHOVER_USER_KEY.trim() } : {}),
    youtubeClientId: requiredEnvironment(environment, "YOUTUBE_CLIENT_ID"),
    youtubeClientSecret: requiredEnvironment(environment, "YOUTUBE_CLIENT_SECRET"),
    youtubeRefreshToken: requiredEnvironment(environment, "YOUTUBE_REFRESH_TOKEN")
  };
}

function endpointForRole(manifest, role) {
  const values = manifest.endpoints.filter((entry) => entry.role === role);
  if (values.length !== 1) throw new Error(`manifest must contain exactly one ${role} endpoint`);
  return values[0].hostname;
}

function commentaryRtcHost(manifest) {
  const value = manifest.endpoints.find((entry) => entry.role === "commentary" && entry.hostname.split(".")[0].startsWith("rtc-"));
  if (!value) throw new Error("manifest has no rehearsal commentary RTC endpoint");
  return value.hostname;
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function usage() {
  process.stdout.write(`Usage: node infra/event-stack/rehearsal/rehearsal-stack.mjs COMMAND --profile /ABSOLUTE/PROFILE [--confirm VALUE]\n\nCommands: plan, prepare, status, start, soak, stop, cleanup, seal. Prepare, start, and cleanup require exact confirmations. The soak is fixed by the protected profile and cannot be shorter than 30 minutes. No command prints secrets.\n`);
}
