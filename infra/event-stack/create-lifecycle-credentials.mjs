#!/usr/bin/env node

import { chmod, link, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadProtectedEnv } from "./stack-deployer.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROVIDER_KEYS = ["DIGITALOCEAN_TOKEN", "SCORECHECK_DO_SSH_KEYS", "VERCEL_TOKEN", "VERCEL_TEAM_ID"];
const MONITORING_KEYS = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN", "PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY"];
const OUTPUT_KEYS = [...PROVIDER_KEYS, ...MONITORING_KEYS];

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseCredentialArgs(process.argv.slice(2));
  if (!options) return usage();
  const result = await createLifecycleCredentials(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function createLifecycleCredentials(options) {
  validateOptions(options);
  const [provider, monitoring] = await Promise.all([
    loadProtectedEnv(options.providerEnv),
    loadProtectedEnv(options.monitoringEnv)
  ]);
  const digitalOceanToken = options.digitalOceanTokenFile
    ? await readProtectedToken(options.digitalOceanTokenFile)
    : provider.DIGITALOCEAN_TOKEN;
  const values = {
    DIGITALOCEAN_TOKEN: digitalOceanToken,
    SCORECHECK_DO_SSH_KEYS: provider.SCORECHECK_DO_SSH_KEYS,
    VERCEL_TOKEN: provider.VERCEL_TOKEN,
    VERCEL_TEAM_ID: provider.VERCEL_TEAM_ID,
    YOUTUBE_CLIENT_ID: monitoring.YOUTUBE_CLIENT_ID,
    YOUTUBE_CLIENT_SECRET: monitoring.YOUTUBE_CLIENT_SECRET,
    YOUTUBE_REFRESH_TOKEN: monitoring.YOUTUBE_REFRESH_TOKEN,
    PUSHOVER_APP_TOKEN: monitoring.PUSHOVER_APP_TOKEN,
    PUSHOVER_USER_KEY: monitoring.PUSHOVER_USER_KEY
  };
  for (const key of OUTPUT_KEYS) validateSecretValue(values[key], key);

  const parentInformation = await stat(dirname(options.output));
  if (!parentInformation.isDirectory() || (parentInformation.mode & 0o077) !== 0) {
    throw new Error("lifecycle credentials parent directory must be mode 0700 or stricter");
  }
  try {
    await stat(options.output);
    throw new Error("lifecycle credentials output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = `${options.output}.tmp-${process.pid}`;
  const serialized = `${OUTPUT_KEYS.map((key) => `${key}=${values[key]}`).join("\n")}\n`;
  try {
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await link(temporary, options.output);
    await rm(temporary);
    await chmod(options.output, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    if (error?.code === "EEXIST") throw new Error("lifecycle credentials output already exists");
    throw error;
  }
  return { output: options.output, keys: OUTPUT_KEYS, digitalOceanTokenSource: options.digitalOceanTokenFile ? "protected-token-file" : "provider-env" };
}

export function parseCredentialArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (argv[0] !== "create") throw new Error("first argument must be create");
  const options = { command: "create", providerEnv: null, monitoringEnv: null, digitalOceanTokenFile: null, output: null };
  const fields = new Map([
    ["--provider-env", "providerEnv"],
    ["--monitoring-env", "monitoringEnv"],
    ["--digitalocean-token-file", "digitalOceanTokenFile"],
    ["--output", "output"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const field = fields.get(flag);
    const value = argv[++index];
    if (!field || !value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    options[field] = normalizedAbsolute(value, flag);
  }
  return options;
}

function validateOptions(value) {
  if (!value || value.command !== "create") throw new Error("credential create options are required");
  for (const field of ["providerEnv", "monitoringEnv", "output"]) normalizedAbsolute(value[field], field);
  if (value.digitalOceanTokenFile !== null) normalizedAbsolute(value.digitalOceanTokenFile, "digitalOceanTokenFile");
  const inputs = [value.providerEnv, value.monitoringEnv, value.digitalOceanTokenFile].filter(Boolean);
  if (new Set(inputs).size !== inputs.length || inputs.includes(value.output)) throw new Error("credential input and output paths must be distinct");
}

async function readProtectedToken(path) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("DigitalOcean token file must be mode 0600 or stricter");
  const value = (await readFile(path, "utf8")).trim();
  validateSecretValue(value, "DIGITALOCEAN_TOKEN");
  if (/\s/u.test(value)) throw new Error("DigitalOcean token file must contain exactly one token");
  return value;
}

function validateSecretValue(value, key) {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /[\r\n\0]/u.test(value)) {
    throw new Error(`${key} is missing or invalid`);
  }
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..")) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function usage() {
  process.stdout.write("Usage: node infra/event-stack/create-lifecycle-credentials.mjs create --provider-env FILE --monitoring-env FILE [--digitalocean-token-file FILE] --output FILE\n");
}
