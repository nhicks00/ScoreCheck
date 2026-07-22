#!/usr/bin/env node

import { chmod, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SupabaseFaultProxy } from "./supabase-fault-proxy.mjs";

const SNAPSHOT_INTERVAL_MS = 1_000;

if (isDirectInvocation()) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export async function runSupabaseFaultProxyService(options, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date());
  const processImpl = dependencies.processImpl ?? process;
  const setIntervalImpl = dependencies.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = dependencies.clearIntervalImpl ?? clearInterval;
  const proxy = dependencies.proxy ?? new SupabaseFaultProxy({
    upstream: options.upstream,
    generationId: options.generation,
    pathPrefix: options.pathPrefix,
    host: "127.0.0.1",
    port: options.port,
    now
  });
  const writeSnapshot = dependencies.writeSnapshot ?? ((snapshot) => writeProtectedSnapshot(options.state, snapshot));
  let operation = Promise.resolve();
  let closing = false;
  const persist = () => writeSnapshot({ ...proxy.snapshot(), writtenAt: timestamp(now) });
  const enqueue = (task) => {
    const next = operation.catch(() => {}).then(task).then(persist);
    operation = next;
    next.catch((error) => {
      processImpl.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      processImpl.exitCode = 1;
    });
    return next;
  };

  await proxy.start();
  await persist();
  const interval = setIntervalImpl(() => void enqueue(async () => {}), SNAPSHOT_INTERVAL_MS);

  const fault = () => void enqueue(async () => {
    proxy.fault(`FAULT-SUPABASE:${options.generation}`);
  });
  const restore = () => void enqueue(async () => {
    proxy.restore(`RESTORE-SUPABASE:${options.generation}`);
  });
  const close = () => {
    if (closing) return;
    closing = true;
    clearIntervalImpl(interval);
    void enqueue(async () => {
      await proxy.close();
    }).finally(() => processImpl.exit(processImpl.exitCode ?? 0));
  };

  processImpl.on("SIGUSR1", fault);
  processImpl.on("SIGUSR2", restore);
  processImpl.on("SIGTERM", close);
  processImpl.on("SIGINT", close);
  return { proxy, persist, close, settle: () => operation };
}

export function parseArgs(argv) {
  const values = { upstream: null, generation: null, pathPrefix: null, state: null, port: 54329 };
  const seen = new Set();
  const fields = new Map([
    ["--upstream", "upstream"],
    ["--generation", "generation"],
    ["--path-prefix", "pathPrefix"],
    ["--state", "state"],
    ["--port", "port"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = fields.get(flag);
    const raw = argv[++index];
    if (!key || !raw || raw.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    if (seen.has(key)) throw new Error(`${flag} may be specified only once`);
    seen.add(key);
    values[key] = key === "port" ? Number(raw) : raw;
  }
  for (const key of ["upstream", "generation", "pathPrefix", "state"]) if (!values[key]) throw new Error(`--${kebab(key)} is required`);
  if (!Number.isInteger(values.port) || values.port < 1024 || values.port > 65_535) throw new Error("--port must be from 1024 through 65535");
  const state = normalizedAbsolute(values.state, "--state");
  if (dirname(state) === "/") throw new Error("--state must use a protected state directory");
  return { ...values, state };
}

async function main() {
  await runSupabaseFaultProxyService(parseArgs(process.argv.slice(2)));
}

async function writeProtectedSnapshot(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Supabase fault proxy service clock is invalid");
  return date.toISOString();
}

function kebab(value) {
  return value.replace(/[A-Z]/gu, (match) => `-${match.toLowerCase()}`);
}

function isDirectInvocation() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
