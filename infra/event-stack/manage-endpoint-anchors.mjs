#!/usr/bin/env node

import { isAbsolute, resolve } from "node:path";
import process from "node:process";

import { EndpointAnchorManager } from "./endpoint-anchors.mjs";
import { CanaryStateStore } from "./lifecycle-canary.mjs";
import { DigitalOceanProvider } from "./providers.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = options.credentialsEnv ? await loadProtectedEnv(options.credentialsEnv) : {};
  const environment = { ...process.env, ...credentials };
  const token = environment.DIGITALOCEAN_TOKEN?.trim();
  if (!token) throw new Error("DIGITALOCEAN_TOKEN is required");
  const cloud = new DigitalOceanProvider({ token, sshKeys: [], cloudInitPaths: {} });
  const manager = new EndpointAnchorManager({ cloud, store: new CanaryStateStore(options.anchors) });
  const result = options.command === "create"
    ? await manager.create({ region: options.region }, options.confirm)
    : await manager.verify({ region: options.region });
  process.stdout.write(`${JSON.stringify(options.command === "create" ? {
    status: result.status,
    region: result.region,
    slots: Object.keys(result.reservedIpv4).sort(),
    readyAt: result.readyAt
  } : result, null, 2)}\n`);
}

function parseArgs(argv) {
  const command = argv[0];
  if (!["create", "verify"].includes(command)) throw new Error("first argument must be create or verify");
  const options = { command, anchors: null, credentialsEnv: null, region: "sfo2", confirm: null };
  const mapping = new Map([["--anchors", "anchors"], ["--credentials-env", "credentialsEnv"], ["--region", "region"], ["--confirm", "confirm"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    if (!key) throw new Error(`unknown anchor option ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    options[key] = ["anchors", "credentialsEnv"].includes(key) ? absolute(value, flag) : value;
  }
  if (!options.anchors) throw new Error("--anchors is required");
  if (command === "create" && !options.confirm) throw new Error("--confirm is required for anchor creation");
  return options;
}

function absolute(value, flag) {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return resolve(value);
}
