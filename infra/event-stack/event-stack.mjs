#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadManifestInputs, validateEventManifest } from "./event-manifest.mjs";
import { EventLifecycleController, FileStateStore, NullNotifier, stateSummary } from "./event-lifecycle.mjs";
import { verifyLifecycleAttestation } from "./lifecycle-attestation.mjs";
import { DigitalOceanProvider, PushoverNotifier, VercelDnsProvider } from "./providers.mjs";
import { LocalStackDeployer, loadProtectedEnv } from "./stack-deployer.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIRECTORY, "../..");
const CLOUD_INIT_PATHS = {
  commentary: resolve(SCRIPT_DIRECTORY, "../commentary/cloud-init.yaml"),
  observability: resolve(SCRIPT_DIRECTORY, "../monitoring/cloud-init.yaml"),
  ingest: resolve(SCRIPT_DIRECTORY, "../mediamtx/cloud-init.yaml"),
  compositor: resolve(SCRIPT_DIRECTORY, "../compositor/cloud-init.yaml")
};

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    usage();
    return;
  }
  const credentialEnv = options.credentialsEnv ? await loadProtectedEnv(options.credentialsEnv) : {};
  const environment = { ...process.env, ...credentialEnv };
  const manifestSource = await readFile(options.manifest, "utf8");
  const manifest = JSON.parse(manifestSource);
  validateEventManifest(manifest, await loadManifestInputs());
  const store = new FileStateStore(options.state);

  const needsCloud = ["up", "status", "start", "evidence", "destroy", "abort"].includes(options.command);
  const needsDns = ["up", "destroy", "abort"].includes(options.command);
  const needsDeployment = ["up", "start", "evidence"].includes(options.command);
  const digitalOceanToken = needsCloud ? requiredEnvironment(environment, "DIGITALOCEAN_TOKEN") : null;
  const digitalOceanSshKeys = options.command === "up" ? splitList(environment.SCORECHECK_DO_SSH_KEYS) : [];
  const vercelToken = needsDns ? requiredEnvironment(environment, "VERCEL_TOKEN") : null;
  const vercelTeamId = environment.VERCEL_TEAM_ID?.trim() || null;
  const cloud = needsCloud ? new DigitalOceanProvider({
    token: digitalOceanToken,
    sshKeys: digitalOceanSshKeys,
    cloudInitPaths: CLOUD_INIT_PATHS
  }) : unavailable("cloud provider is unavailable for this command");
  const dns = needsDns ? new VercelDnsProvider({
    token: vercelToken,
    teamId: vercelTeamId
  }) : unavailable("DNS provider is unavailable for this command");
  const deployer = needsDeployment ? new LocalStackDeployer({
    repoRoot: REPO_ROOT,
    secretsDirectory: requiredOption(options.secrets, "--secrets"),
    sshPrivateKey: requiredOption(options.sshKey, "--ssh-key"),
    knownHostsPath: requiredOption(options.knownHosts, "--known-hosts")
  }) : unavailable("stack deployment is unavailable for this command");
  const notifier = environment.PUSHOVER_APP_TOKEN?.trim() && environment.PUSHOVER_USER_KEY?.trim()
    ? new PushoverNotifier({ appToken: environment.PUSHOVER_APP_TOKEN.trim(), userKey: environment.PUSHOVER_USER_KEY.trim() })
    : new NullNotifier();
  if (["up", "destroy", "abort"].includes(options.command) && notifier instanceof NullNotifier) {
    throw new Error("PUSHOVER_APP_TOKEN and PUSHOVER_USER_KEY are required for event setup and cleanup");
  }
  const provisioningGuard = options.command === "up" ? {
    verify: async () => verifyLifecycleAttestation({
      path: requiredOption(options.attestation, "--attestation"),
      account: await cloud.getAccount(),
      digitalOceanToken,
      vercelToken,
      vercelTeamId,
      digitalOceanSshKeys,
      sshPrivateKeyPath: requiredOption(options.sshKey, "--ssh-key"),
      expectedRegion: manifest.provider.region,
      expectedDnsZone: manifest.dns.zone
    })
  } : null;
  const controller = new EventLifecycleController({ store, cloud, dns, deployer, notifier, provisioningGuard });

  let result;
  if (options.command === "plan") result = await controller.plan(manifest);
  else if (options.command === "up") {
    const anchors = await readProtectedJson(requiredOption(options.anchors, "--anchors"), "anchor configuration");
    result = await controller.up(manifest, anchors);
  } else if (options.command === "status") result = (await controller.status(manifest)).state;
  else if (options.command === "start") result = await controller.beginCoverage(manifest, requiredOption(options.confirm, "--confirm"));
  else if (options.command === "close") result = await controller.closeCoverage(manifest, requiredOption(options.confirm, "--confirm"));
  else if (options.command === "evidence") result = await controller.captureEvidence(manifest, requiredOption(options.evidence, "--evidence"), options.rehearsalEvidence);
  else if (options.command === "destroy") {
    result = await controller.destroy(manifest, requiredOption(options.evidence, "--evidence"), requiredOption(options.confirm, "--confirm"));
  } else if (options.command === "abort") {
    result = await controller.abort(manifest, requiredOption(options.evidence, "--evidence"), requiredOption(options.confirm, "--confirm"), options.rehearsalEvidence);
  } else throw new Error(`unsupported command ${options.command}`);
  process.stdout.write(`${JSON.stringify(stateSummary(result), null, 2)}\n`);
}

function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["plan", "up", "status", "start", "close", "evidence", "destroy", "abort"]).has(command)) throw new Error(`unknown lifecycle command ${command}`);
  const options = { command, manifest: null, state: null, anchors: null, secrets: null, sshKey: null, knownHosts: null, credentialsEnv: null, attestation: null, evidence: null, rehearsalEvidence: null, confirm: null };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    const mapping = new Map([
      ["--manifest", "manifest"], ["--state", "state"], ["--anchors", "anchors"], ["--secrets", "secrets"],
      ["--ssh-key", "sshKey"], ["--known-hosts", "knownHosts"], ["--credentials-env", "credentialsEnv"],
      ["--attestation", "attestation"], ["--evidence", "evidence"], ["--rehearsal-evidence", "rehearsalEvidence"], ["--confirm", "confirm"]
    ]);
    const key = mapping.get(flag);
    if (!key) throw new Error(`unknown option ${flag}`);
    options[key] = key === "confirm" ? value : absolute(value, flag);
  }
  options.manifest = requiredOption(options.manifest, "--manifest");
  options.state = requiredOption(options.state, "--state");
  return options;
}

function usage() {
  process.stdout.write(`Usage:
  node infra/event-stack/event-stack.mjs plan --manifest FILE --state FILE
  node infra/event-stack/event-stack.mjs up --manifest FILE --state FILE --anchors FILE --secrets DIR --ssh-key FILE --known-hosts FILE --credentials-env FILE --attestation FILE
  node infra/event-stack/event-stack.mjs status --manifest FILE --state FILE --credentials-env FILE
  node infra/event-stack/event-stack.mjs start --manifest FILE --state FILE --secrets DIR --ssh-key FILE --known-hosts FILE --credentials-env FILE --confirm START:EVENT
  node infra/event-stack/event-stack.mjs close --manifest FILE --state FILE --confirm CLOSE:EVENT
  node infra/event-stack/event-stack.mjs evidence --manifest FILE --state FILE --secrets DIR --ssh-key FILE --known-hosts FILE --credentials-env FILE --evidence DIR [--rehearsal-evidence DIR]
  node infra/event-stack/event-stack.mjs destroy --manifest FILE --state FILE --credentials-env FILE --evidence DIR --confirm DESTROY:EVENT
  node infra/event-stack/event-stack.mjs abort --manifest FILE --state FILE --credentials-env FILE --evidence DIR --confirm ABORT:EVENT
\nNo command prints secrets. Destroy is ID-scoped, requires closed coverage, protected evidence, the review date, and exact confirmation. Abort is ID-scoped and is unavailable after coverage starts.\n`);
}

async function readProtectedJson(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be mode 0600 or stricter`);
  return JSON.parse(await readFile(path, "utf8"));
}

function splitList(value) {
  const values = String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("SCORECHECK_DO_SSH_KEYS must contain at least one DigitalOcean SSH key id or fingerprint");
  return values;
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
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return resolve(value);
}

function unavailable(message) {
  return new Proxy({}, { get() { return async () => { throw new Error(message); }; } });
}
