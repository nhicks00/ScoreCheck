#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DigitalOceanProvider, VercelDnsProvider } from "./providers.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { buildCanaryConfig, CanarySshHost, CanaryStateStore, LifecycleCanary } from "./lifecycle-canary.mjs";
import { issueLifecycleAttestation } from "./lifecycle-attestation.mjs";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CLOUD_INIT_PATH = resolve(DIRECTORY, "canary-cloud-init.yaml");

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = options.credentialsEnv ? await loadProtectedEnv(options.credentialsEnv) : {};
  const environment = { ...process.env, ...credentials };
  const cloudInitSource = await readFile(CLOUD_INIT_PATH, "utf8");
  const config = buildCanaryConfig({ runId: options.runId, cloudInitSource });
  const digitalOceanToken = required(environment, "DIGITALOCEAN_TOKEN");
  const vercelToken = required(environment, "VERCEL_TOKEN");
  const digitalOceanSshKeys = splitList(required(environment, "SCORECHECK_DO_SSH_KEYS"));
  const vercelTeamId = environment.VERCEL_TEAM_ID?.trim() || null;
  const cloud = new DigitalOceanProvider({
    token: digitalOceanToken,
    sshKeys: digitalOceanSshKeys,
    cloudInitPaths: { canary: CLOUD_INIT_PATH }
  });
  const dns = new VercelDnsProvider({
    token: vercelToken,
    teamId: vercelTeamId
  });
  const store = new CanaryStateStore(options.evidence);
  const host = new CanarySshHost({ privateKey: options.sshKey, knownHostsPath: options.knownHosts });
  const canary = new LifecycleCanary({ cloud, dns, host, store });
  const state = options.command === "cleanup"
    ? await canary.cleanup(config, options.confirm)
    : await canary.run(config, options.confirm);
  const attestation = options.command === "run"
    ? await issueLifecycleAttestation({
        path: options.attestation,
        evidencePath: options.evidence,
        digitalOceanToken,
        vercelToken,
        vercelTeamId,
        digitalOceanSshKeys,
        sshPrivateKeyPath: options.sshKey
      })
    : null;
  process.stdout.write(`${JSON.stringify({
    runId: state.runId,
    phase: state.phase,
    classification: state.classification ?? null,
    originalDropletId: state.original?.id ?? null,
    replacementDropletId: state.replacement?.id ?? null,
    stableAddressProved: state.checks.some((entry) => entry.name === "replacement-created"),
    endpointChecks: state.checks.length,
    completedAt: state.completedAt,
    attestationExpiresAt: attestation?.expiresAt ?? null
  }, null, 2)}\n`);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!["run", "cleanup"].includes(command)) throw new Error("first argument must be run or cleanup");
  const options = { command, runId: null, evidence: null, attestation: null, credentialsEnv: null, sshKey: null, knownHosts: null, confirm: null };
  const mapping = new Map([
    ["--run-id", "runId"], ["--evidence", "evidence"], ["--attestation", "attestation"], ["--credentials-env", "credentialsEnv"],
    ["--ssh-key", "sshKey"], ["--known-hosts", "knownHosts"], ["--confirm", "confirm"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    if (!key) throw new Error(`unknown canary option ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[key] = ["evidence", "attestation", "credentialsEnv", "sshKey", "knownHosts"].includes(key) ? absolute(value, flag) : value;
  }
  for (const [key, flag] of [["runId", "--run-id"], ["evidence", "--evidence"], ["sshKey", "--ssh-key"], ["knownHosts", "--known-hosts"], ["confirm", "--confirm"]]) {
    if (!options[key]) throw new Error(`${flag} is required`);
  }
  if (command === "run" && !options.attestation) throw new Error("--attestation is required for a canary run");
  return options;
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function splitList(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function absolute(value, flag) {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return resolve(value);
}
