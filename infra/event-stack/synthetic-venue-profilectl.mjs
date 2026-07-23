#!/usr/bin/env node

import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createSyntheticRehearsalVenueProfile } from "./venue-admission.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EVENT = /^[a-z0-9][a-z0-9-]{2,62}$/u;

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const result = await createSyntheticVenueProfile(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function createSyntheticVenueProfile({ event, output, now = () => new Date() }) {
  if (!EVENT.test(event ?? "")) throw new Error("synthetic venue event is invalid");
  const target = protectedPath(output);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const parent = await stat(dirname(target));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error("synthetic venue output parent must be protected");
  const profile = createSyntheticRehearsalVenueProfile(event, now());
  await writeFile(target, `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(target, 0o600);
  return { status: "PASS", event, output: target, activeCameras: profile.cameras.filter((camera) => camera.enabled).map((camera) => camera.cameraNumber) };
}

export function parseArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (argv[0] !== "create") throw new Error("first argument must be create");
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    if (flag === "--event") values.event = value;
    else if (flag === "--output") values.output = value;
    else throw new Error(`${flag} is unknown or missing a value`);
  }
  if (!values.event || !values.output) throw new Error("--event and --output are required");
  return values;
}

function protectedPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("..") || resolve(value) !== value) {
    throw new Error("synthetic venue output must be a normalized absolute path");
  }
  return value;
}

function usage() {
  process.stdout.write("Usage:\n  synthetic-venue-profilectl.mjs create --event EVENT --output /PROTECTED/venue-profile.json\n");
}
