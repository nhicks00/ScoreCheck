#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_CREDENTIALS = `${homedir()}/.config/scorecheck/peplink/incontrol-client.json`;
const REQUEST_TIMEOUT_MS = 10_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const STATUS_ENDPOINTS = ["info.firmware", "status.wan.connection", "status.pepvpn"];
export const SNAPSHOT_ENDPOINTS = [
  ...STATUS_ENDPOINTS,
  "status.wan.connection.allowance",
  "status.lan.profile",
  "status.client",
  "config.wan.connection",
  "config.port",
  "config.ssid.profile",
  "config.speedfusionConnectProtect",
  "config.snmp.info"
];

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = await loadCredentials(options.credentials);
  const accessToken = await grantAccessToken({ credentials, fetchImpl: globalThis.fetch });

  if (options.command === "status" || options.command === "snapshot") {
    const endpoints = options.command === "snapshot" ? SNAPSHOT_ENDPOINTS : STATUS_ENDPOINTS;
    const responses = await collectRouterEndpoints({ credentials, accessToken, endpoints, fetchImpl: globalThis.fetch });
    process.stdout.write(`${JSON.stringify(redactSensitive(responses), null, 2)}\n`);
    return;
  }

  let body;
  if (options.body) {
    const text = await readFile(options.body, "utf8");
    if (Buffer.byteLength(text) > 65_536) throw new Error("Peplink request body must be 64 KiB or smaller");
    body = JSON.parse(text);
  }
  const response = await routerRequest({
    credentials,
    accessToken,
    endpoint: options.endpoint,
    method: options.command === "post" ? "POST" : "GET",
    body,
    fetchImpl: globalThis.fetch
  });
  process.stdout.write(`${JSON.stringify(redactSensitive(response), null, 2)}\n`);
}

export function parseArgs(args) {
  const command = args[0];
  if (!new Set(["status", "snapshot", "get", "post"]).has(command)) throw new Error(usage());
  let credentials = DEFAULT_CREDENTIALS;
  let body;
  let confirmWrite = false;
  const positional = [];
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--credentials" || value === "--body") {
      const next = args[index + 1];
      if (!next) throw new Error(`${value} requires a value`);
      if (value === "--credentials") credentials = requiredAbsolutePath(next, "credentials");
      else body = requiredAbsolutePath(next, "request body");
      index += 1;
    } else if (value === "--confirm-write") {
      confirmWrite = true;
    } else if (value.startsWith("--")) {
      throw new Error(`unknown option ${value}`);
    } else {
      positional.push(value);
    }
  }

  if (command === "status" || command === "snapshot") {
    if (positional.length || body || confirmWrite) throw new Error(usage());
    return { command, credentials };
  }
  if (positional.length !== 1) throw new Error(usage());
  const endpoint = validateEndpoint(positional[0]);
  if (command === "get") {
    if (body || confirmWrite) throw new Error(usage());
    return { command, credentials, endpoint };
  }
  if (!body || !confirmWrite) throw new Error("post requires --body /absolute/request.json and --confirm-write");
  return { command, credentials, endpoint, body };
}

export async function loadCredentials(path) {
  const resolved = requiredAbsolutePath(path, "credentials");
  const metadata = await stat(resolved);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Peplink credentials must not be accessible by group or other users");
  const parsed = JSON.parse(await readFile(resolved, "utf8"));
  if (!/^[A-Za-z0-9_-]{24,}$/.test(parsed.clientId ?? "")) throw new Error("Peplink client ID is invalid");
  if (!/^[A-Za-z0-9_-]{24,}$/.test(parsed.clientSecret ?? "")) throw new Error("Peplink client secret is invalid");
  if (!/^[0-9A-F]{4}(?:-[0-9A-F]{4}){2}$/i.test(parsed.deviceSerial ?? "")) throw new Error("Peplink device serial is invalid");
  const tokenEndpoint = new URL(parsed.tokenEndpoint ?? "");
  if (tokenEndpoint.href !== "https://api.ic.peplink.com/api/oauth2/token") throw new Error("Peplink token endpoint is not approved");
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, deviceSerial: parsed.deviceSerial, tokenEndpoint: tokenEndpoint.href };
}

export async function grantAccessToken({ credentials, fetchImpl }) {
  const response = await fetchImpl(credentials.tokenEndpoint, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: "client_credentials"
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const payload = await readJsonResponse(response, "InControl token grant");
  if (!response.ok || !/^[A-Za-z0-9._~-]{24,}$/.test(payload.access_token ?? "")) throw new Error(`InControl token grant failed with HTTP ${response.status}`);
  return payload.access_token;
}

export async function routerRequest({ credentials, accessToken, endpoint, method, body, fetchImpl }) {
  const validatedMethod = method === "POST" ? "POST" : method === "GET" ? "GET" : null;
  if (!validatedMethod) throw new Error("Peplink request method must be GET or POST");
  const url = new URL(`/api/${validateEndpoint(endpoint)}`, remoteAdminBase(credentials.deviceSerial));
  const response = await fetchImpl(url, {
    method: validatedMethod,
    redirect: "follow",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(validatedMethod === "POST" ? { "content-type": "application/json" } : {})
    },
    ...(validatedMethod === "POST" ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const payload = await readJsonResponse(response, `Peplink ${validatedMethod} ${endpoint}`);
  if (!response.ok || payload.stat !== "ok") throw new Error(`Peplink ${validatedMethod} ${endpoint} failed: ${payload.message ?? `HTTP ${response.status}`}`);
  return payload.response ?? null;
}

export async function collectRouterEndpoints({ credentials, accessToken, endpoints, fetchImpl }) {
  const responses = {};
  for (const endpoint of endpoints) {
    responses[endpoint] = await routerRequest({ credentials, accessToken, endpoint, method: "GET", fetchImpl });
  }
  return responses;
}

export function remoteAdminBase(serial) {
  if (!/^[0-9A-F]{4}(?:-[0-9A-F]{4}){2}$/i.test(serial)) throw new Error("Peplink device serial is invalid");
  return `https://${serial.toLowerCase()}-ic.rwa.peplink.com`;
}

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    isSensitiveKey(key)
      ? "[REDACTED]"
      : redactSensitive(item)
  ]));
}

function isSensitiveKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return /^(?:eid|iccid|imei|imsi|key|meid|mtn)$/u.test(normalized)
    || /(?:accessToken|authKey|clientSecret|credential|passphrase|password|preSharedKey|privateKey|psk|secret|streamKey|token|wpaKey)$/iu.test(normalized);
}

function validateEndpoint(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9.]+(?:\?[A-Za-z0-9._~!$&'()*+,;=:%-]*)?$/.test(value)) throw new Error("Peplink API endpoint is invalid");
  return value;
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return resolve(value);
}

function usage() {
  return [
    "usage:",
    "  peplinkctl.mjs status [--credentials /absolute/client.json]",
    "  peplinkctl.mjs snapshot [--credentials /absolute/client.json]",
    "  peplinkctl.mjs get API_ENDPOINT [--credentials /absolute/client.json]",
    "  peplinkctl.mjs post API_ENDPOINT --body /absolute/request.json --confirm-write [--credentials /absolute/client.json]"
  ].join("\n");
}

async function readJsonResponse(response, label) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${label} returned HTTP ${response.status} with content-type ${contentType || "unknown"}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON with HTTP ${response.status}`);
  }
}
