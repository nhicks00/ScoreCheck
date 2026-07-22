#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONTRACTS = Object.freeze({
  programSession: "program-session-v1",
  overlayState: "overlay-state-v1",
  commentary: "commentary-v1",
  browserHeartbeat: "browser-heartbeat-v5"
});

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  if (options.command === "capture") {
    const result = await captureRendererBinding(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const binding = await loadRendererBinding(options.binding);
  process.stdout.write(`${JSON.stringify({ status: "PASS", ...binding }, null, 2)}\n`);
}

export async function captureRendererBinding({ origin, output }, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const sourceOrigin = externalHttpsOrigin(origin);
  const first = await fetchBinding(sourceOrigin, fetchImpl);
  const second = await fetchBinding(first.origin, fetchImpl);
  if (stableJson(first) !== stableJson(second)) throw new Error("renderer identity differs between the production and generated deployment origins");
  const target = normalizedAbsolute(output, "renderer binding output");
  const parent = await stat(dirname(target));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error("renderer binding parent must be mode 0700 or stricter");
  try {
    await stat(target);
    throw new Error("renderer binding output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const value = validateRendererBinding({ ...first, capturedAt: now().toISOString(), sourceOrigin });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(target, 0o600);
  return { status: "PASS", output: target, deploymentId: value.deploymentId, gitSha: value.gitSha, sha256: sha256(await readFile(target)) };
}

export async function loadRendererBinding(path) {
  const target = normalizedAbsolute(path, "renderer binding");
  const information = await stat(target);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("renderer binding must be a mode-0600 protected file");
  return validateRendererBinding(JSON.parse(await readFile(target, "utf8")));
}

export function validateRendererBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || value.provider !== "vercel") {
    throw new Error("renderer binding schema is invalid");
  }
  const origin = generatedVercelOrigin(value.origin);
  if (!/^dpl_[A-Za-z0-9]+$/.test(value.deploymentId ?? "")) throw new Error("renderer binding deployment id is invalid");
  if (!/^[a-f0-9]{40}$/.test(value.gitSha ?? "")) throw new Error("renderer binding Git SHA is invalid");
  if (value.assetNamespace !== value.deploymentId) throw new Error("renderer asset namespace is not deployment-bound");
  if (stableJson(value.contracts) !== stableJson(CONTRACTS)) throw new Error("renderer contract versions are invalid");
  if (value.capturedAt !== undefined && !Number.isFinite(Date.parse(value.capturedAt))) throw new Error("renderer binding capture time is invalid");
  if (value.sourceOrigin !== undefined) externalHttpsOrigin(value.sourceOrigin);
  return {
    schemaVersion: 1,
    provider: "vercel",
    origin,
    deploymentId: value.deploymentId,
    gitSha: value.gitSha,
    assetNamespace: value.assetNamespace,
    contracts: { ...CONTRACTS },
    ...(value.capturedAt === undefined ? {} : { capturedAt: value.capturedAt }),
    ...(value.sourceOrigin === undefined ? {} : { sourceOrigin: value.sourceOrigin })
  };
}

async function fetchBinding(origin, fetchImpl) {
  const response = await fetchImpl(`${origin}/api/program/renderer-binding`, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    headers: { "user-agent": "ScoreCheck-Renderer-Binding/1" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`renderer binding endpoint returned HTTP ${response.status}`);
  return validateRendererBinding(await response.json());
}

function parseArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (!new Set(["capture", "verify"]).has(argv[0])) throw new Error("first argument must be capture or verify");
  const values = { command: argv[0] };
  const mapping = argv[0] === "capture" ? new Map([["--origin", "origin"], ["--output", "output"]]) : new Map([["--binding", "binding"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    values[key] = value;
  }
  for (const key of mapping.values()) if (!values[key]) throw new Error(`${key} is required`);
  if (values.output) values.output = normalizedAbsolute(values.output, "--output");
  if (values.binding) values.binding = normalizedAbsolute(values.binding, "--binding");
  return values;
}

function externalHttpsOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== value || ["localhost", "127.0.0.1"].includes(parsed.hostname)) {
    throw new Error("renderer source must be an external HTTPS origin");
  }
  return parsed.origin;
}

function generatedVercelOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel.app") || parsed.origin !== value) {
    throw new Error("renderer origin must be a generated Vercel deployment origin");
  }
  return parsed.origin;
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function usage() {
  process.stdout.write("usage:\n  renderer-binding.mjs capture --origin <https-origin> --output </protected/renderer.json>\n  renderer-binding.mjs verify --binding </protected/renderer.json>\n");
}
