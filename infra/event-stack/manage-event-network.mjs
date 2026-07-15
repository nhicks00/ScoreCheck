#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateNetworkContract } from "./network-contract.mjs";
import { DigitalOceanProvider } from "./providers.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";

const DEFAULT_NETWORK_SPEC = fileURLToPath(new URL("./network-contract.json", import.meta.url));
const APPLY_CONFIRMATION = "APPLY:EVENT-NETWORK";

export function parseNetworkManagerArgs(argv) {
  const command = argv[0];
  if (!new Set(["verify", "apply"]).has(command)) throw new Error("first argument must be verify or apply");
  const options = { command, credentialsEnv: null, networkSpec: DEFAULT_NETWORK_SPEC, confirm: null };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--credentials-env") options.credentialsEnv = absolute(value, flag);
    else if (flag === "--network-spec") options.networkSpec = absolute(value, flag);
    else if (flag === "--confirm") options.confirm = value;
    else throw new Error(`unknown network option ${flag}`);
  }
  if (!options.credentialsEnv) throw new Error("--credentials-env is required");
  if (command === "apply" && options.confirm !== APPLY_CONFIRMATION) {
    throw new Error(`confirmation must be exactly ${APPLY_CONFIRMATION}`);
  }
  if (command === "verify" && options.confirm !== null) throw new Error("verify does not accept --confirm");
  return options;
}

async function main() {
  const options = parseNetworkManagerArgs(process.argv.slice(2));
  const credentials = await loadProtectedEnv(options.credentialsEnv);
  const token = credentials.DIGITALOCEAN_TOKEN?.trim();
  if (!token) throw new Error("DIGITALOCEAN_TOKEN is required");
  const contract = validateNetworkContract(JSON.parse(await readFile(options.networkSpec, "utf8")));
  const cloud = new DigitalOceanProvider({ token, sshKeys: [], cloudInitPaths: {} });
  const result = options.command === "apply"
    ? await cloud.applyNetworkContract(contract)
    : await cloud.verifyNetworkContract(contract);
  process.stdout.write(`${JSON.stringify({
    command: options.command,
    healthy: result.healthy,
    region: contract.region,
    vpcUuid: contract.vpcUuid,
    firewallNames: contract.firewalls.map((firewall) => firewall.name),
    problems: result.problems
  }, null, 2)}\n`);
  if (!result.healthy) process.exitCode = 1;
}

function absolute(value, flag) {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return resolve(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
