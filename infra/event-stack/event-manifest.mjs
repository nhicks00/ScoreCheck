#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { validateFleetSpec } from "./preflight-capacity.mjs";

const DEFAULT_POOL_SPEC = fileURLToPath(new URL("./compositor-pool.json", import.meta.url));
const EVENT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const FIXED_EVENT_RESOURCES = Object.freeze([
  Object.freeze({ name: "bvm-commentary-01", role: "commentary" }),
  Object.freeze({ name: "bvm-observability-01", role: "observability" }),
  Object.freeze({ name: "bvm-preview-01", role: "ingest" })
]);

export function buildEventManifest({ event, destroyAfter, poolSpec, poolSpecSource }) {
  assertEvent(event);
  assertDate(destroyAfter);
  if (typeof poolSpecSource !== "string" || poolSpecSource.length === 0) {
    throw new Error("pool spec source is required");
  }
  let parsedPoolSpec;
  try {
    parsedPoolSpec = JSON.parse(poolSpecSource);
  } catch {
    throw new Error("pool spec source is not valid JSON");
  }
  if (!isDeepStrictEqual(poolSpec, parsedPoolSpec)) {
    throw new Error("pool spec object does not match the bound source bytes");
  }
  const pool = validateFleetSpec(poolSpec, { desiredCompositors: 8, warmSpares: 1 });
  const poolSpecSha256 = sha256(poolSpecSource);
  const fixedNames = new Set(FIXED_EVENT_RESOURCES.map((resource) => resource.name));
  const collision = pool.workers.find((worker) => fixedNames.has(worker.name));
  if (collision) throw new Error(`fleet worker ${collision.name} collides with a fixed event resource`);
  const workers = pool.workers.map((worker) => (
    worker.warmSpare
      ? { name: worker.name, role: "compositor-spare", warmSpare: true }
      : { name: worker.name, role: "compositor", court: worker.court }
  ));
  return {
    schemaVersion: 1,
    event,
    destroyAfter,
    compositorPool: {
      specSha256: poolSpecSha256,
      region: pool.region,
      size: pool.size,
      image: pool.image,
      desiredCompositors: pool.desiredCompositors,
      warmSpares: pool.warmSpares
    },
    droplets: [...FIXED_EVENT_RESOURCES.map((resource) => ({ ...resource })), ...workers]
  };
}

export function validateEventManifest(manifest, { poolSpec, poolSpecSource }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("event manifest must be an object");
  }
  if (manifest.schemaVersion !== 1) throw new Error("event manifest schemaVersion must be 1");
  if (!manifest.compositorPool || typeof manifest.compositorPool !== "object" || Array.isArray(manifest.compositorPool)) {
    throw new Error("event manifest compositorPool binding is required");
  }
  if (!SHA256.test(manifest.compositorPool.specSha256 ?? "")) {
    throw new Error("event manifest compositor pool digest is invalid");
  }
  const expected = buildEventManifest({
    event: manifest.event,
    destroyAfter: manifest.destroyAfter,
    poolSpec,
    poolSpecSource
  });
  if (!isDeepStrictEqual(manifest, expected)) {
    throw new Error("event manifest does not exactly match the bound compositor pool and fixed service inventory");
  }
  return expected;
}

export function parseArgs(argv) {
  const command = argv[0];
  if (["-h", "--help", "help"].includes(command)) return null;
  if (!new Set(["generate", "validate"]).has(command)) {
    throw new Error("command must be generate or validate");
  }
  const options = {
    command,
    event: null,
    destroyAfter: null,
    output: null,
    manifest: null,
    poolSpec: DEFAULT_POOL_SPEC
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--event") options.event = requiredValue(argv, ++index, argument);
    else if (argument === "--destroy-after") options.destroyAfter = requiredValue(argv, ++index, argument);
    else if (argument === "--output") {
      const output = requiredValue(argv, ++index, argument);
      if (!isAbsolute(output)) throw new Error("--output must be an absolute path");
      options.output = resolve(output);
    }
    else if (argument === "--manifest") options.manifest = resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--pool-spec") options.poolSpec = resolve(requiredValue(argv, ++index, argument));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (command === "generate") {
    assertEvent(options.event);
    assertDate(options.destroyAfter);
    if (!options.output) throw new Error("--output must be an absolute path");
    if (options.manifest) throw new Error("--manifest is not valid for generate");
  } else {
    if (!options.manifest) throw new Error("--manifest is required for validate");
    if (options.event || options.destroyAfter || options.output) {
      throw new Error("--event, --destroy-after, and --output are not valid for validate");
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(
      "Usage:\n"
      + "  node infra/event-stack/event-manifest.mjs generate --event SLUG --destroy-after YYYY-MM-DD --output /ABSOLUTE/PATH [--pool-spec FILE]\n"
      + "  node infra/event-stack/event-manifest.mjs validate --manifest FILE [--pool-spec FILE]\n"
    );
    return;
  }
  const poolSpecSource = await readFile(options.poolSpec, "utf8");
  const poolSpec = JSON.parse(poolSpecSource);
  if (options.command === "generate") {
    const manifest = buildEventManifest({
      event: options.event,
      destroyAfter: options.destroyAfter,
      poolSpec,
      poolSpecSource
    });
    await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary(manifest))}\n`);
    return;
  }
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  const validated = validateEventManifest(manifest, { poolSpec, poolSpecSource });
  process.stdout.write(`${JSON.stringify(summary(validated))}\n`);
}

function summary(manifest) {
  return {
    event: manifest.event,
    destroyAfter: manifest.destroyAfter,
    dropletCount: manifest.droplets.length,
    assignedCompositors: manifest.compositorPool.desiredCompositors,
    warmSpares: manifest.compositorPool.warmSpares,
    poolSpecSha256: manifest.compositorPool.specSha256
  };
}

function assertEvent(value) {
  if (typeof value !== "string" || !EVENT_SLUG.test(value)) throw new Error("event slug is invalid");
}

function assertDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("destroy-after date must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("destroy-after date is not a real calendar date");
  }
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
