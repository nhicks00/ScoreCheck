#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_API = "https://api.digitalocean.com/v2";
const COMPOSITOR_TAG = "bvm-compositor";

export function evaluateCapacity(input) {
  const dropletLimit = positiveInteger(input.account?.droplet_limit, "account droplet limit");
  const accountStatus = String(input.account?.status ?? "unknown");
  const desiredCompositors = boundedInteger(input.desiredCompositors, "desired compositor count", 1, 32);
  const warmSpares = boundedInteger(input.warmSpares, "warm spare count", 0, 16);
  const droplets = completeCollection(input.dropletsPayload, "droplets");
  const sizes = completeCollection(input.sizesPayload, "sizes");
  const size = sizes.find((entry) => entry?.slug === input.sizeSlug) ?? null;
  const allCompositors = droplets.filter((droplet) => Array.isArray(droplet?.tags) && droplet.tags.includes(COMPOSITOR_TAG));
  const matchingCompositors = allCompositors.filter((droplet) => (
    droplet?.status === "active"
      && droplet?.size_slug === input.sizeSlug
      && droplet?.region?.slug === input.region
  ));
  const targetCompositors = desiredCompositors + warmSpares;
  const additionsRequired = Math.max(0, targetCompositors - matchingCompositors.length);
  const totalAfterProvisioning = droplets.length + additionsRequired;
  const sizeVcpus = numberOrNull(size?.vcpus);
  const sizeMemoryMiB = numberOrNull(size?.memory);
  const priceHourly = numberOrNull(size?.price_hourly);
  const priceMonthly = numberOrNull(size?.price_monthly);
  const blockers = [];

  if (accountStatus !== "active") blockers.push(`DigitalOcean account status is ${accountStatus}, not active.`);
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
        }))
    },
    incrementalCost: {
      hourly: priceHourly === null ? null : roundCurrency(priceHourly * additionsRequired),
      monthlyEquivalent: priceMonthly === null ? null : roundCurrency(priceMonthly * additionsRequired)
    },
    blockers
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
    warmSpares: 0,
    sizeSlug: "c-4",
    region: "sfo2",
    apiBase: process.env.SCORECHECK_DO_API_BASE?.trim() || DEFAULT_API
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--desired-compositors") options.desiredCompositors = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--warm-spares") options.warmSpares = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--size") options.sizeSlug = requiredValue(argv, ++index, argument);
    else if (argument === "--region") options.region = requiredValue(argv, ++index, argument);
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
    process.stdout.write("Usage: DIGITALOCEAN_TOKEN=... node infra/event-stack/preflight-capacity.mjs [--desired-compositors 8] [--warm-spares 0] [--size c-4] [--region sfo2]\n");
    return;
  }
  const token = process.env.DIGITALOCEAN_TOKEN?.trim();
  if (!token) throw new Error("DIGITALOCEAN_TOKEN is required.");
  const base = options.apiBase.replace(/\/$/, "");
  const [accountPayload, dropletsPayload, sizesPayload] = await Promise.all([
    fetchJson(`${base}/account`, token),
    fetchJson(`${base}/droplets?per_page=200`, token),
    fetchJson(`${base}/sizes?per_page=200`, token)
  ]);
  const result = evaluateCapacity({
    ...options,
    account: accountPayload.account,
    dropletsPayload,
    sizesPayload
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
