#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);
const GIT_SHA = /^[a-f0-9]{40}$/u;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/u;

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string")
  );
  const result = await buildLocalRendererBundle({ ...options, environment });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function buildLocalRendererBundle({
  repoRoot,
  gitSha,
  deploymentId,
  rendererOrigin,
  environment,
  output
}, {
  runner = run,
  now = () => new Date()
} = {}) {
  const root = normalizedDirectory(repoRoot, "repository root");
  const target = normalizedOutput(output);
  if (!GIT_SHA.test(gitSha ?? "")) throw new Error("local renderer Git SHA is invalid");
  if (!DEPLOYMENT_ID.test(deploymentId ?? "")) throw new Error("local renderer deployment id is invalid");
  const origin = generatedVercelOrigin(rendererOrigin);
  const head = (await runner("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  if (head !== gitSha) throw new Error("local renderer checkout does not match the admitted Git SHA");
  const status = (await runner("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root })).stdout.trim();
  if (status) throw new Error("local renderer checkout must be clean");

  const parent = dirname(target);
  const parentInformation = await stat(parent);
  if (!parentInformation.isDirectory() || (parentInformation.mode & 0o077) !== 0) {
    throw new Error("local renderer bundle parent must be mode 0700 or stricter");
  }
  try {
    await lstat(target);
    throw new Error("local renderer bundle already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const webRoot = join(root, "apps/web");
  const buildEnvironment = rendererBuildEnvironment({
    environment,
    gitSha,
    deploymentId,
    rendererOrigin: origin
  });
  await runner("npm", ["ci", "--include=dev"], { cwd: webRoot, env: buildEnvironment });
  await runner("npm", ["run", "build"], { cwd: webRoot, env: buildEnvironment });

  const standalone = join(webRoot, ".next/standalone");
  const server = join(standalone, "server.js");
  if (!(await stat(server)).isFile()) throw new Error("Next standalone renderer did not produce server.js");
  const staging = join(parent, `.local-renderer-${process.pid}-${Date.now()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await cp(standalone, staging, { recursive: true, force: false, dereference: true });
    await mkdir(join(staging, ".next"), { recursive: true });
    await cp(join(webRoot, ".next/static"), join(staging, ".next/static"), { recursive: true, force: false, dereference: true });
    try {
      await cp(join(webRoot, "public"), join(staging, "public"), { recursive: true, force: false, dereference: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await removeImageOptimizerDependencies(staging);
    const manifest = {
      schemaVersion: 1,
      gitSha,
      deploymentId,
      rendererOrigin: origin,
      createdAt: now().toISOString()
    };
    await writeFile(join(staging, "scorecheck-renderer.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await assertPortableRendererTree(staging);
    const temporary = `${target}.tmp-${process.pid}`;
    await runner("tar", ["-czf", temporary, "-C", staging, "."], { cwd: root });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  const information = await stat(target);
  return {
    schemaVersion: 1,
    path: target,
    sha256: sha256(await readFile(target)),
    bytes: information.size,
    gitSha,
    deploymentId
  };
}

export async function assertNoSymlinks(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const information = await lstat(path);
    if (information.isSymbolicLink()) throw new Error(`local renderer artifact contains a symbolic link: ${entry.name}`);
    if (information.isDirectory()) await assertNoSymlinks(path);
  }
}

export async function assertPortableRendererTree(root) {
  await assertNoSymlinks(root);
  await assertNoNativeAddons(root);
}

async function assertNoNativeAddons(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await assertNoNativeAddons(path);
    else if (entry.name.endsWith(".node")) throw new Error(`local renderer artifact contains a native addon: ${entry.name}`);
  }
}

async function removeImageOptimizerDependencies(root) {
  await rm(join(root, "node_modules", "sharp"), { recursive: true, force: true });
  await rm(join(root, "node_modules", "@img"), { recursive: true, force: true });
}

export function rendererBuildEnvironment({ environment, gitSha, deploymentId, rendererOrigin }) {
  if (!GIT_SHA.test(gitSha ?? "") || !DEPLOYMENT_ID.test(deploymentId ?? "")) throw new Error("renderer build identity is invalid");
  const origin = generatedVercelOrigin(rendererOrigin);
  return {
    ...environment,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    VERCEL_GIT_COMMIT_SHA: gitSha,
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: gitSha,
    VERCEL_DEPLOYMENT_ID: deploymentId,
    VERCEL_URL: new URL(origin).hostname,
    NEXT_PUBLIC_VERCEL_URL: new URL(origin).hostname
  };
}

export function validateLocalRendererArtifact(value, expected = {}) {
  if (!value || value.schemaVersion !== 1 || !GIT_SHA.test(value.gitSha ?? "") || !DEPLOYMENT_ID.test(value.deploymentId ?? "")) {
    throw new Error("local renderer artifact contract is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256 ?? "") || !Number.isInteger(value.bytes) || value.bytes <= 0) {
    throw new Error("local renderer artifact digest is invalid");
  }
  if (expected.gitSha && value.gitSha !== expected.gitSha) throw new Error("local renderer artifact Git SHA does not match");
  if (expected.deploymentId && value.deploymentId !== expected.deploymentId) throw new Error("local renderer artifact deployment does not match");
  return { ...value };
}

function parseArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (argv[0] !== "build") throw new Error("first argument must be build");
  const values = { command: "build" };
  const mapping = new Map([
    ["--repo-root", "repoRoot"],
    ["--git-sha", "gitSha"],
    ["--deployment-id", "deploymentId"],
    ["--renderer-origin", "rendererOrigin"],
    ["--output", "output"]
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const key = mapping.get(argv[index]);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${argv[index - 1]} is unknown or missing a value`);
    values[key] = value;
  }
  for (const key of mapping.values()) if (!values[key]) throw new Error(`${key} is required`);
  return values;
}

function normalizedDirectory(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be an absolute path`);
  return value;
}

function normalizedOutput(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error("local renderer output must be an absolute path");
  return value;
}

function generatedVercelOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel.app") || parsed.origin !== value) {
    throw new Error("renderer origin must be a generated Vercel deployment origin");
  }
  return parsed.origin;
}

async function run(command, args, options) {
  return execFileAsync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: command === "npm" ? 20 * 60_000 : 2 * 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function usage() {
  process.stdout.write("usage: local-renderer-bundle.mjs build --repo-root /repo --git-sha SHA --deployment-id dpl_ID --renderer-origin https://generated.vercel.app --output /protected/local-renderer.tar.gz\n");
}
