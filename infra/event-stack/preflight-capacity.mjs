#!/usr/bin/env node

import process from "node:process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_API = "https://api.digitalocean.com/v2";
const COMPOSITOR_TAG = "bvm-compositor";
const DEFAULT_FLEET_SPEC = fileURLToPath(new URL("./compositor-pool.json", import.meta.url));

export function evaluateCapacity(input) {
  const dropletLimit = positiveInteger(input.account?.droplet_limit, "account droplet limit");
  const accountStatus = String(input.account?.status ?? "unknown");
  const desiredCompositors = boundedInteger(input.desiredCompositors, "desired compositor count", 1, 32);
  const warmSpares = boundedInteger(input.warmSpares, "warm spare count", 0, 16);
  const droplets = completeCollection(input.dropletsPayload, "droplets");
  const sizes = completeCollection(input.sizesPayload, "sizes");
  const fleetSpec = input.fleetSpec === undefined
    ? null
    : validateFleetSpec(input.fleetSpec, {
        desiredCompositors,
        warmSpares,
        sizeSlug: input.sizeSlug,
        region: input.region
      });
  const size = sizes.find((entry) => entry?.slug === input.sizeSlug) ?? null;
  const allCompositors = droplets.filter((droplet) => Array.isArray(droplet?.tags) && droplet.tags.includes(COMPOSITOR_TAG));
  const exactPlan = fleetSpec === null ? null : evaluateExactFleetPlan(fleetSpec, droplets, allCompositors);
  const matchingCompositors = exactPlan === null
    ? allCompositors.filter((droplet) => (
        droplet?.status === "active"
          && droplet?.size_slug === input.sizeSlug
          && droplet?.region?.slug === input.region
      ))
    : exactPlan.matchingDroplets;
  const targetCompositors = desiredCompositors + warmSpares;
  const additionsRequired = exactPlan === null
    ? Math.max(0, targetCompositors - matchingCompositors.length)
    : exactPlan.missingSlots.length;
  const totalAfterProvisioning = droplets.length + additionsRequired;
  const sizeVcpus = numberOrNull(size?.vcpus);
  const sizeMemoryMiB = numberOrNull(size?.memory);
  const priceHourly = numberOrNull(size?.price_hourly);
  const priceMonthly = numberOrNull(size?.price_monthly);
  const blockers = [];

  if (accountStatus !== "active") blockers.push(`DigitalOcean account status is ${accountStatus}, not active.`);
  if (exactPlan !== null) {
    for (const conflict of exactPlan.conflicts) {
      blockers.push(`Planned worker ${conflict.name} conflicts with existing inventory: ${conflict.reasons.join("; ")}.`);
    }
    if (exactPlan.extraTagged.length > 0) {
      blockers.push(`Tagged compositor inventory contains workers outside the approved pool: ${exactPlan.extraTagged.join(", ")}.`);
    }
  }
  if (!size) {
    blockers.push(`Droplet size ${input.sizeSlug} is not exposed to this account.`);
  } else {
    if (size.available !== true) blockers.push(`Droplet size ${input.sizeSlug} is not available.`);
    if (!Array.isArray(size.regions) || !size.regions.includes(input.region)) {
      blockers.push(`Droplet size ${input.sizeSlug} is not available in ${input.region}.`);
    }
  }
  if (totalAfterProvisioning > dropletLimit) {
    blockers.push(`Account limit ${dropletLimit} cannot fit ${totalAfterProvisioning} total Droplets.`);
  }

  return {
    status: blockers.length === 0 ? "PASS" : "BLOCKED",
    region: input.region,
    size: size ? {
      slug: size.slug,
      vcpus: sizeVcpus,
      memoryMiB: sizeMemoryMiB,
      priceHourly,
      priceMonthly
    } : { slug: input.sizeSlug, vcpus: null, memoryMiB: null, priceHourly: null, priceMonthly: null },
    account: {
      status: accountStatus,
      currentDroplets: droplets.length,
      dropletLimit,
      freeSlots: Math.max(0, dropletLimit - droplets.length)
    },
    compositors: {
      matchingActive: matchingCompositors.length,
      taggedTotal: allCompositors.length,
      desired: desiredCompositors,
      warmSpares,
      target: targetCompositors,
      additionsRequired,
      totalDropletsAfterProvisioning: totalAfterProvisioning,
      incompatibleTagged: allCompositors
        .filter((droplet) => !matchingCompositors.includes(droplet))
        .map((droplet) => ({
          name: String(droplet?.name ?? "unknown"),
          status: String(droplet?.status ?? "unknown"),
          region: String(droplet?.region?.slug ?? "unknown"),
          size: String(droplet?.size_slug ?? "unknown")
        })),
      exactPlan: exactPlan === null ? null : {
        schemaVersion: fleetSpec.schemaVersion,
        complete: exactPlan.missingSlots.length === 0 && exactPlan.conflicts.length === 0 && exactPlan.extraTagged.length === 0,
        matchedNames: exactPlan.matchingDroplets.map((droplet) => String(droplet.name)).sort(),
        missingSlots: exactPlan.missingSlots,
        conflicts: exactPlan.conflicts,
        extraTagged: exactPlan.extraTagged
      }
    },
    incrementalCost: {
      hourly: priceHourly === null ? null : roundCurrency(priceHourly * additionsRequired),
      monthlyEquivalent: priceMonthly === null ? null : roundCurrency(priceMonthly * additionsRequired)
    },
    blockers
  };
}

export function timestampCapacityResult(result, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("capacity preflight timestamp is invalid.");
  return { ...result, checkedAt: now.toISOString() };
}

export function validateFleetSpec(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fleet spec must be an object.");
  if (value.schemaVersion !== 1) throw new Error("fleet spec schemaVersion must be 1.");
  if (typeof value.region !== "string" || !/^[a-z0-9-]{1,20}$/.test(value.region)) {
    throw new Error("fleet spec region is invalid.");
  }
  if (typeof value.size !== "string" || !/^[a-z0-9-]{1,40}$/.test(value.size)) {
    throw new Error("fleet spec size is invalid.");
  }
  if (typeof value.image !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.image)) {
    throw new Error("fleet spec image is invalid.");
  }
  const desiredCompositors = boundedInteger(value.desiredCompositors, "fleet desired compositor count", 1, 8);
  const warmSpares = boundedInteger(value.warmSpares, "fleet warm spare count", 0, 4);
  if (!Array.isArray(value.workers)) throw new Error("fleet spec workers must be an array.");
  if (value.workers.length !== desiredCompositors + warmSpares) {
    throw new Error("fleet spec worker count does not match desired compositors plus warm spares.");
  }

  const names = new Set();
  const courts = new Set();
  let spareCount = 0;
  const workers = value.workers.map((worker, index) => {
    if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
      throw new Error(`fleet worker ${index + 1} must be an object.`);
    }
    const name = worker.name;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
      throw new Error(`fleet worker ${index + 1} has an invalid name.`);
    }
    if (names.has(name)) throw new Error(`fleet worker name ${name} is duplicated.`);
    names.add(name);
    const hasCourt = Number.isInteger(worker.court);
    const isWarmSpare = worker.warmSpare === true;
    if (hasCourt === isWarmSpare) throw new Error(`fleet worker ${name} must have exactly one assignment.`);
    if (hasCourt) {
      if (worker.court < 1 || worker.court > desiredCompositors) throw new Error(`fleet worker ${name} has an invalid court.`);
      if (courts.has(worker.court)) throw new Error(`fleet court ${worker.court} is duplicated.`);
      courts.add(worker.court);
      return { name, court: worker.court };
    }
    spareCount += 1;
    return { name, warmSpare: true };
  });
  if (courts.size !== desiredCompositors) throw new Error("fleet spec must assign every court exactly once.");
  if (spareCount !== warmSpares) throw new Error("fleet spec warm spare count does not match its declaration.");

  const normalized = {
    schemaVersion: 1,
    region: value.region,
    size: value.size,
    image: value.image,
    desiredCompositors,
    warmSpares,
    workers
  };
  if (expected.desiredCompositors !== undefined && desiredCompositors !== expected.desiredCompositors) {
    throw new Error("fleet spec desired compositor count does not match the requested count.");
  }
  if (expected.warmSpares !== undefined && warmSpares !== expected.warmSpares) {
    throw new Error("fleet spec warm spare count does not match the requested count.");
  }
  if (expected.sizeSlug !== undefined && normalized.size !== expected.sizeSlug) {
    throw new Error("fleet spec size does not match the requested size.");
  }
  if (expected.region !== undefined && normalized.region !== expected.region) {
    throw new Error("fleet spec region does not match the requested region.");
  }
  return normalized;
}

function evaluateExactFleetPlan(spec, droplets, allCompositors) {
  const matchingDroplets = [];
  const missingSlots = [];
  const conflicts = [];
  const plannedNames = new Set(spec.workers.map((worker) => worker.name));
  for (const worker of spec.workers) {
    const candidates = droplets.filter((droplet) => droplet?.name === worker.name);
    if (candidates.length === 0) {
      missingSlots.push(worker);
      continue;
    }
    const reasons = [];
    if (candidates.length !== 1) reasons.push(`${candidates.length} Droplets use this name`);
    const droplet = candidates[0];
    if (droplet?.status !== "active") reasons.push(`status is ${String(droplet?.status ?? "unknown")}`);
    if (droplet?.size_slug !== spec.size) reasons.push(`size is ${String(droplet?.size_slug ?? "unknown")}`);
    if (droplet?.region?.slug !== spec.region) reasons.push(`region is ${String(droplet?.region?.slug ?? "unknown")}`);
    if (droplet?.image?.slug !== spec.image && String(droplet?.image?.id ?? "") !== spec.image) {
      reasons.push(`image is ${String(droplet?.image?.slug ?? droplet?.image?.id ?? "unknown")}`);
    }
    if (!Array.isArray(droplet?.tags) || !droplet.tags.includes(COMPOSITOR_TAG)) reasons.push(`tag ${COMPOSITOR_TAG} is missing`);
    if (reasons.length > 0) conflicts.push({ name: worker.name, reasons });
    else matchingDroplets.push(droplet);
  }
  return {
    matchingDroplets,
    missingSlots,
    conflicts,
    extraTagged: allCompositors
      .filter((droplet) => !plannedNames.has(String(droplet?.name ?? "")))
      .map((droplet) => String(droplet?.name ?? "unknown"))
      .sort()
  };
}

export function completeCollection(payload, name) {
  const values = payload?.[name];
  if (!Array.isArray(values)) throw new Error(`${name} response is missing its collection.`);
  const total = payload?.meta?.total;
  if (!Number.isInteger(total) || total < 0) throw new Error(`${name} response is missing a valid total.`);
  if (values.length !== total) throw new Error(`${name} response is incomplete (${values.length}/${total}).`);
  return values;
}

function parseArgs(argv) {
  const options = {
    desiredCompositors: 8,
    warmSpares: 1,
    sizeSlug: "c-4",
    region: "sfo2",
    fleetSpecPath: DEFAULT_FLEET_SPEC,
    apiBase: process.env.SCORECHECK_DO_API_BASE?.trim() || DEFAULT_API
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--desired-compositors") options.desiredCompositors = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--warm-spares") options.warmSpares = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--size") options.sizeSlug = requiredValue(argv, ++index, argument);
    else if (argument === "--region") options.region = requiredValue(argv, ++index, argument);
    else if (argument === "--fleet-spec") options.fleetSpecPath = resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--help" || argument === "-h") return null;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  boundedInteger(options.desiredCompositors, "desired compositor count", 1, 32);
  boundedInteger(options.warmSpares, "warm spare count", 0, 16);
  if (!/^[a-z0-9-]{1,40}$/.test(options.sizeSlug)) throw new Error("Invalid size slug.");
  if (!/^[a-z0-9-]{1,20}$/.test(options.region)) throw new Error("Invalid region.");
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

async function fetchJson(url, token) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`DigitalOcean request failed with HTTP ${response.status}.`);
  return response.json();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write("Usage: DIGITALOCEAN_TOKEN=... node infra/event-stack/preflight-capacity.mjs [--desired-compositors 8] [--warm-spares 1] [--size c-4] [--region sfo2] [--fleet-spec FILE]\n");
    return;
  }
  const token = process.env.DIGITALOCEAN_TOKEN?.trim();
  if (!token) throw new Error("DIGITALOCEAN_TOKEN is required.");
  const fleetSpec = JSON.parse(await readFile(options.fleetSpecPath, "utf8"));
  const base = options.apiBase.replace(/\/$/, "");
  const [accountPayload, dropletsPayload, sizesPayload] = await Promise.all([
    fetchJson(`${base}/account`, token),
    fetchJson(`${base}/droplets?per_page=200`, token),
    fetchJson(`${base}/sizes?per_page=200`, token)
  ]);
  const result = evaluateCapacity({
    ...options,
    fleetSpec,
    account: accountPayload.account,
    dropletsPayload,
    sizesPayload
  });
  process.stdout.write(`${JSON.stringify(timestampCapacityResult(result), null, 2)}\n`);
  if (result.status !== "PASS") process.exitCode = 2;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function roundCurrency(value) {
  return Math.round(value * 100_000) / 100_000;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`capacity preflight error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
