#!/usr/bin/env node

import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { loadProtectedEnv } from "./stack-deployer.mjs";

const INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const environment = await loadProtectedEnv(options.environment);
  const pingUrl = validateHttpsUrl(environment.HEALTHCHECKS_SENTINEL_PING_URL, "Healthchecks sentinel ping URL");
  await mkdir(dirname(options.output), { recursive: true, mode: 0o700 });
  const handle = await open(options.output, "a", 0o600);
  await chmod(options.output, 0o600);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      const startedAt = Date.now();
      const result = await runPlatformSentinel({
        event: options.event,
        endpoints: options.endpoints,
        pingUrl,
        fetchImpl: globalThis.fetch,
        now: () => new Date()
      });
      await handle.write(`${JSON.stringify(result)}\n`);
      await handle.sync();
      process.stdout.write(`${result.passed ? "SENTINEL_OK" : "SENTINEL_FAIL"} ${result.observedAt}\n`);
      if (options.once || stopped) break;
      await delay(Math.max(0, INTERVAL_MS - (Date.now() - startedAt)));
    } while (!stopped);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await handle.close();
  }
}

export async function runPlatformSentinel({ event, endpoints, pingUrl, fetchImpl, now }) {
  validateIdentifier(event, "event");
  const validatedEndpoints = validateEndpoints(endpoints);
  const validatedPing = validateHttpsUrl(pingUrl, "Healthchecks sentinel ping URL");
  const observedAt = now().toISOString();
  const observations = [];
  for (const endpoint of validatedEndpoints) {
    try {
      const response = await fetchImpl(endpoint.url, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        headers: { "user-agent": "ScoreCheck-External-Sentinel/1" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      observations.push({ name: endpoint.name, url: endpoint.url, status: response.status, ok: response.status === endpoint.expectedStatus });
    } catch (error) {
      observations.push({ name: endpoint.name, url: endpoint.url, status: null, ok: false, error: safeError(error) });
    }
  }
  const problems = observations.filter((entry) => !entry.ok).map((entry) => `${entry.name} ${entry.status === null ? entry.error : `returned HTTP ${entry.status}`}`);
  let healthchecksDelivery = { ok: true, status: null };
  try {
    const response = await fetchImpl(healthchecksResultUrl(validatedPing, problems.length === 0), {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    healthchecksDelivery = { ok: response.ok, status: response.status };
    if (!response.ok) problems.push(`Healthchecks sentinel delivery returned HTTP ${response.status}`);
  } catch (error) {
    healthchecksDelivery = { ok: false, status: null, error: safeError(error) };
    problems.push(`Healthchecks sentinel delivery failed: ${healthchecksDelivery.error}`);
  }
  return {
    schemaVersion: 1,
    event,
    observedAt,
    passed: problems.length === 0,
    endpoints: observations,
    healthchecksDelivery,
    problems
  };
}

export function healthchecksResultUrl(pingUrl, passed) {
  const url = new URL(validateHttpsUrl(pingUrl, "Healthchecks sentinel ping URL"));
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = passed ? base : `${base}/fail`;
  return url.toString();
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("platform sentinel arguments must be --name value pairs");
    if (values[key]) throw new Error(`duplicate platform sentinel argument ${key}`);
    values[key] = value;
  }
  const event = values["--event"];
  validateIdentifier(event, "event");
  const environment = requiredPath(values["--environment"], "sentinel environment");
  const output = requiredPath(values["--output"], "sentinel output");
  return {
    event,
    environment,
    output,
    once: values["--once"] === "true",
    endpoints: [
      { name: "monitor", url: values["--monitor-url"], expectedStatus: 200 },
      { name: "ingest", url: values["--ingest-url"], expectedStatus: 200 },
      { name: "commentary", url: values["--commentary-url"], expectedStatus: 200 },
      { name: "renderer", url: values["--renderer-url"], expectedStatus: 200 }
    ]
  };
}

function validateEndpoints(endpoints) {
  const names = ["monitor", "ingest", "commentary", "renderer"];
  if (!Array.isArray(endpoints) || endpoints.length !== names.length || JSON.stringify(endpoints.map((entry) => entry.name)) !== JSON.stringify(names)) throw new Error("platform sentinel endpoint set is incomplete");
  return endpoints.map((entry) => ({ name: entry.name, url: validateHttpsUrl(entry.url, `${entry.name} sentinel URL`), expectedStatus: entry.expectedStatus }));
}

function validateHttpsUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} is invalid`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label} must be an HTTPS URL without credentials or fragments`);
  return url.toString();
}

function validateIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value)) throw new Error(`platform sentinel ${label} is invalid`);
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return resolve(value);
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 300);
}
