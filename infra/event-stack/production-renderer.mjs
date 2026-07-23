#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { captureRendererBinding, loadRendererBinding } from "./renderer-binding.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";
import { rehearsalProjectName, VercelRehearsalProvider } from "./rehearsal/vercel-provider.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EVENT = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const PROVIDER_ID = /^prj_[A-Za-z0-9]+$/u;
const STATE_FILE = "renderer-state.json";
const BINDING_FILE = "renderer-binding.json";
const ALLOWED_WEB_KEYS = Object.freeze([
  "LIVEKIT_COMMENTARY_API_KEY",
  "LIVEKIT_COMMENTARY_API_SECRET",
  "MEDIAMTX_WHEP_BASE_URL",
  "MONITOR_BROWSER_HEARTBEAT_SECRET",
  "MONITOR_PUBLIC_URL",
  "NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "PROGRAM_PAGE_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY"
]);

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  if (options.command === "prepare") {
    const providerEnv = await loadProtectedEnv(options.credentialsEnv);
    const webEnv = await loadProtectedEnv(options.webRuntimeEnv);
    const provider = new VercelRehearsalProvider({
      token: required(providerEnv.VERCEL_TOKEN, "VERCEL_TOKEN"),
      teamId: required(providerEnv.VERCEL_TEAM_ID, "VERCEL_TEAM_ID"),
      mode: "production-renderer"
    });
    const result = await prepareProductionRenderer({ ...options, provider, webEnv });
    process.stdout.write(`${JSON.stringify(redactRendererState(result), null, 2)}\n`);
    return;
  }
  const state = JSON.parse(await readFile(options.state, "utf8"));
  if (state.phase !== "destroyed" || state.event !== options.event) throw new Error("renderer deletion requires the matching destroyed event lifecycle state");
  const providerEnv = await loadProtectedEnv(options.credentialsEnv);
  const provider = new VercelRehearsalProvider({
    token: required(providerEnv.VERCEL_TOKEN, "VERCEL_TOKEN"),
    teamId: required(providerEnv.VERCEL_TEAM_ID, "VERCEL_TEAM_ID"),
    mode: "production-renderer"
  });
  const result = await destroyProductionRenderer({ ...options, provider });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function buildProductionRendererEnvironment(webEnv, origin) {
  const value = Object.fromEntries(ALLOWED_WEB_KEYS.map((key) => [key, required(webEnv?.[key], key)]));
  return {
    ...value,
    NEXT_PUBLIC_COURT_COUNT: "8",
    NEXT_PUBLIC_DEFAULT_TIMEZONE: "America/Chicago",
    NEXT_PUBLIC_SITE_URL: validOrigin(origin)
  };
}

export async function prepareProductionRenderer({ event, gitSha, repo, repoId, output, provider, webEnv, now = () => new Date(), capture = captureRendererBinding }) {
  validateEvent(event);
  validateSha(gitSha);
  validateRepository(repo, repoId);
  const root = protectedRoot(output, "renderer output");
  const existing = await readRendererStateOrNull(root);
  if (existing) {
    if (existing.event !== event || existing.gitSha !== gitSha || existing.repo !== repo || existing.repoId !== String(repoId)) throw new Error("renderer state belongs to a different event or release");
    await loadRendererBinding(join(root, BINDING_FILE));
    return existing;
  }
  await assertProtectedParent(root);
  const project = await provider.ensureProject({ name: rehearsalProjectName(event), repository: { slug: repo, repoId: String(repoId) } });
  const generationId = `${event}-${gitSha.slice(0, 12)}`;
  const environment = buildProductionRendererEnvironment(webEnv, project.origin);
  const deployment = await provider.ensureDeployment({ project, generationId, repoId: String(repoId), ref: "master", sha: gitSha, environment });
  const ready = await provider.waitReady({ deploymentId: deployment.id, project, generationId });
  await provider.verifyProgramPage({ project, deployment: ready, gitSha, token: environment.PROGRAM_PAGE_TOKEN });
  const temporary = `${root}.preparing-${process.pid}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    const captured = await capture({ origin: ready.url, output: join(temporary, BINDING_FILE) });
    const binding = await loadRendererBinding(join(temporary, BINDING_FILE));
    if (binding.gitSha !== gitSha || binding.deploymentId !== ready.id || binding.origin !== ready.url) {
      throw new Error("renderer binding does not match the admitted deployment");
    }
    const state = {
      schemaVersion: 1,
      status: "READY",
      event,
      preparedAt: now().toISOString(),
      gitSha,
      repo,
      repoId: String(repoId),
      project: { id: project.id, name: project.name, origin: project.origin },
      deployment: { id: ready.id, origin: ready.url, generationId },
      binding: { path: join(root, BINDING_FILE), sha256: captured.sha256 },
      environmentKeys: Object.keys(environment).sort()
    };
    await writeProtectedJson(join(temporary, STATE_FILE), state);
    await rename(temporary, root);
    await chmod(root, 0o700);
    return state;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function destroyProductionRenderer({ event, output, confirmation, provider, now = () => new Date() }) {
  validateEvent(event);
  if (confirmation !== `DESTROY-RENDERER:${event}`) throw new Error("renderer destruction confirmation is invalid");
  const root = protectedRoot(output, "renderer output");
  const state = await readRendererState(root);
  if (state.event !== event) throw new Error("renderer state belongs to a different event");
  await provider.deleteProject(state.project.id);
  const result = { schemaVersion: 1, status: "DESTROYED", event, destroyedAt: now().toISOString(), projectId: state.project.id };
  await writeProtectedJson(join(root, "renderer-destroyed.json"), result);
  return result;
}

export function redactRendererState(state) {
  return {
    status: state.status,
    event: state.event,
    gitSha: state.gitSha,
    project: state.project,
    deployment: state.deployment,
    binding: state.binding,
    environmentKeys: state.environmentKeys
  };
}

async function readRendererStateOrNull(root) {
  try { return await readRendererState(root); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readRendererState(root) {
  const information = await stat(root);
  if (!information.isDirectory() || (information.mode & 0o077) !== 0) throw new Error("renderer output must be a protected directory");
  const source = join(root, STATE_FILE);
  const file = await stat(source);
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error("renderer state must be protected");
  return validateRendererState(JSON.parse(await readFile(source, "utf8")));
}

function validateRendererState(value) {
  if (!value || value.schemaVersion !== 1 || value.status !== "READY") throw new Error("renderer state is invalid");
  validateEvent(value.event);
  validateSha(value.gitSha);
  validateRepository(value.repo, value.repoId);
  if (!PROVIDER_ID.test(value.project?.id ?? "") || typeof value.project?.name !== "string" || typeof value.project?.origin !== "string") throw new Error("renderer project state is invalid");
  validOrigin(value.project.origin);
  if (!/^dpl_[A-Za-z0-9]+$/u.test(value.deployment?.id ?? "") || typeof value.deployment?.generationId !== "string") throw new Error("renderer deployment state is invalid");
  validOrigin(value.deployment.origin);
  if (typeof value.binding?.path !== "string" || !/^[a-f0-9]{64}$/u.test(value.binding?.sha256 ?? "")) throw new Error("renderer binding state is invalid");
  if (!Array.isArray(value.environmentKeys) || JSON.stringify(value.environmentKeys) !== JSON.stringify([...value.environmentKeys].sort())) throw new Error("renderer environment state is invalid");
  return value;
}

async function writeProtectedJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function assertProtectedParent(path) {
  const parent = await stat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error("renderer output parent must be a protected directory");
}

function protectedRoot(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return resolve(path);
}

function validOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel.app") || parsed.origin !== value) throw new Error("renderer origin is invalid");
  return parsed.origin;
}

function validateEvent(value) {
  if (!EVENT.test(value ?? "")) throw new Error("renderer event is invalid");
}

function validateSha(value) {
  if (!SHA.test(value ?? "")) throw new Error("renderer Git SHA is invalid");
}

function validateRepository(repo, repoId) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) || !/^\d+$/u.test(String(repoId ?? ""))) {
    throw new Error("renderer repository is invalid");
  }
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/u.test(value)) throw new Error(`${label} is required`);
  return value.trim();
}

function parseArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  const command = argv[0];
  const mapping = command === "prepare"
    ? new Map([["--event", "event"], ["--git-sha", "gitSha"], ["--repo", "repo"], ["--repo-id", "repoId"], ["--credentials-env", "credentialsEnv"], ["--web-runtime-env", "webRuntimeEnv"], ["--output", "output"]])
    : command === "destroy"
      ? new Map([["--event", "event"], ["--credentials-env", "credentialsEnv"], ["--output", "output"], ["--state", "state"], ["--confirm", "confirmation"]])
      : null;
  if (!mapping) throw new Error("first argument must be prepare or destroy");
  const values = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const key = mapping.get(argv[index]);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${argv[index - 1]} is unknown or missing a value`);
    values[key] = value;
  }
  for (const key of mapping.values()) if (!values[key]) throw new Error(`${key} is required`);
  return values;
}

function usage() {
  process.stdout.write("Usage:\n  production-renderer.mjs prepare --event EVENT --git-sha SHA --repo OWNER/REPO --repo-id ID --credentials-env /protected/provider.env --web-runtime-env /protected/web-runtime.env --output /protected/renderer\n  production-renderer.mjs destroy --event EVENT --credentials-env /protected/provider.env --output /protected/renderer --state /protected/lifecycle-state.json --confirm DESTROY-RENDERER:EVENT\n");
}
