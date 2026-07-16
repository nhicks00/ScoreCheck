#!/usr/bin/env node

import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { renderAdminSshNetworkContract } from "./network-contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_TEMPLATE = fileURLToPath(new URL("./network-contract.json", import.meta.url));

export function parseRenderAdminSshArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (argv[0] !== "render") throw new Error("first argument must be render");
  const options = { template: DEFAULT_TEMPLATE, adminCidrs: null, output: null };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--template") options.template = absolute(value, flag);
    else if (flag === "--admin-cidrs") options.adminCidrs = absolute(value, flag);
    else if (flag === "--output") options.output = absolute(value, flag);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!options.adminCidrs) throw new Error("--admin-cidrs is required");
  if (!options.output) throw new Error("--output is required");
  return options;
}

export async function renderAdminSshNetwork(options) {
  absolute(options.template, "--template");
  absolute(options.adminCidrs, "--admin-cidrs");
  absolute(options.output, "--output");
  await assertProtectedFile(options.adminCidrs, "admin SSH CIDR document");
  const parent = await stat(dirname(options.output));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error("output parent must be a mode-0700 protected directory");
  const [templateSource, adminSource] = await Promise.all([
    readFile(options.template, "utf8"),
    readFile(options.adminCidrs, "utf8")
  ]);
  const contract = renderAdminSshNetworkContract(JSON.parse(templateSource), JSON.parse(adminSource));
  await writeFile(options.output, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(options.output, 0o600);
  return {
    output: options.output,
    region: contract.region,
    vpcUuid: contract.vpcUuid,
    firewallCount: contract.firewalls.length,
    adminSourceCount: contract.firewalls[0].inboundRules.find((rule) => rule.protocol === "tcp" && rule.ports === "22" && rule.sources.addresses).sources.addresses.length
  };
}

function absolute(value, flag) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) {
    throw new Error(`${flag} must be a normalized absolute path`);
  }
  return value;
}

async function assertProtectedFile(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a mode-0600 protected file`);
}

function usage() {
  return "Usage: node infra/event-stack/render-admin-ssh-network.mjs render --admin-cidrs /PROTECTED/admin-cidrs.json --output /PROTECTED/network-contract.json [--template FILE]";
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const options = parseRenderAdminSshArgs(process.argv.slice(2));
  if (!options) process.stdout.write(`${usage()}\n`);
  else renderAdminSshNetwork(options)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
