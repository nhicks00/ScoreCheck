import { setTimeout as delay } from "node:timers/promises";

const API = "https://api.vercel.com";
const PROJECT_NAME = /^scorecheck-rehearsal-[a-z0-9-]{8,40}$/;
const SHA = /^[a-f0-9]{40}$/;

export class VercelRehearsalProvider {
  constructor({ token, teamId, teamSlug = null, fetchImpl = globalThis.fetch, publicFetchImpl = globalThis.fetch, sleep = delay }) {
    this.token = required(token, "Vercel token");
    this.teamId = required(teamId, "Vercel team id");
    this.team = teamSlug === null ? null : normalizeTeam({ id: this.teamId, slug: teamSlug }, this.teamId);
    this.fetchImpl = fetchImpl;
    this.publicFetchImpl = publicFetchImpl;
    this.sleep = sleep;
  }

  async ensureProject({ name }) {
    validateProjectName(name);
    const existing = await this.findProject(name);
    if (existing) return existing;
    const team = await this.#team();
    const created = await this.#request("POST", "/v11/projects", {
      name,
      framework: "nextjs",
      rootDirectory: "apps/web"
    });
    return normalizeProject(created, name, projectOrigin(name, team.slug));
  }

  async findProject(name) {
    validateProjectName(name);
    const [existing, team] = await Promise.all([this.#projectOrNull(name), this.#team()]);
    return existing ? normalizeProject(existing, name, projectOrigin(name, team.slug)) : null;
  }

  async ensureDeployment({ project, generationId, repoId, ref, sha, environment }) {
    const normalizedProject = normalizeProject(project, project.name, project.origin);
    validateGeneration(generationId);
    validateGitSource({ repoId, ref, sha });
    validateEnvironment(environment, normalizedProject.origin);
    const existing = await this.#markedDeployment(normalizedProject, generationId);
    if (existing) return existing;
    const body = {
      name: normalizedProject.name,
      project: normalizedProject.id,
      target: "production",
      gitSource: { type: "github", repoId, ref, sha },
      projectSettings: { framework: "nextjs", rootDirectory: "apps/web" },
      env: environment,
      meta: { scorecheckRehearsalGeneration: generationId }
    };
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return normalizeDeployment(await this.#request("POST", "/v13/deployments", body), normalizedProject, generationId);
      } catch (error) {
        if (!(error instanceof VercelRequestError) || error.status < 500) throw error;
        lastError = error;
      }
      const reconciled = await this.#waitForMarkedDeployment(normalizedProject, generationId);
      if (reconciled) return reconciled;
    }
    throw new VercelRequestError("Vercel deployment creation could not be reconciled after transient provider failures", lastError?.status ?? 500);
  }

  async getDeployment(deploymentId, project, generationId) {
    validateProviderId(deploymentId, "deployment id");
    const value = await this.#request("GET", `/v13/deployments/${encodeURIComponent(deploymentId)}`);
    return normalizeDeployment(value, normalizeProject(project, project.name, project.origin), generationId);
  }

  async waitReady({ deploymentId, project, generationId, timeoutMs = 15 * 60_000, intervalMs = 5_000 }) {
    const startedAt = Date.now();
    let current;
    while (Date.now() - startedAt <= timeoutMs) {
      current = await this.getDeployment(deploymentId, project, generationId);
      if (current.state === "READY") {
        if (!current.aliases.includes(project.origin.slice("https://".length))) {
          throw new Error("Vercel rehearsal deployment is ready without its isolated project alias");
        }
        return current;
      }
      if (["ERROR", "CANCELED"].includes(current.state)) throw new Error(`Vercel rehearsal deployment entered ${current.state}`);
      await this.sleep(intervalMs);
    }
    throw new Error(`Vercel rehearsal deployment did not become ready (last state ${current?.state ?? "unknown"})`);
  }

  async verifyProgramPage({ project, token }) {
    const normalized = normalizeProject(project, project.name, project.origin);
    if (typeof token !== "string" || token.length < 24 || /[\r\n\0]/u.test(token)) throw new Error("Vercel rehearsal Program token is invalid");
    const pageUrl = `${normalized.origin}/program/court/1?token=${encodeURIComponent(token)}&scene=0`;
    const invalidUrl = `${normalized.origin}/program/court/1?token=invalid-rehearsal-token&scene=0`;
    const request = (url) => this.publicFetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: { "user-agent": "ScoreCheck-Rehearsal-Preflight/1" },
      signal: AbortSignal.timeout(30_000),
      cache: "no-store"
    });
    const [accepted, rejected] = await Promise.all([request(pageUrl), request(invalidUrl)]);
    if (accepted.status !== 200 || !accepted.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      throw new Error(`Vercel rehearsal Program page preflight returned HTTP ${accepted.status}`);
    }
    const body = await accepted.text();
    if (!body.includes("program-root")) throw new Error("Vercel rehearsal Program page preflight returned the wrong document");
    if (rejected.status !== 404) throw new Error(`Vercel rehearsal Program token rejection returned HTTP ${rejected.status}`);
    return { status: "healthy", origin: normalized.origin, acceptedStatus: 200, rejectedStatus: 404 };
  }

  async deleteProject(projectId) {
    validateProviderId(projectId, "project id");
    try {
      await this.#request("DELETE", `/v9/projects/${encodeURIComponent(projectId)}`);
    } catch (error) {
      if (error instanceof VercelNotFoundError) return { absent: true };
      throw error;
    }
    const current = await this.#projectOrNull(projectId);
    if (current) throw new Error("Vercel rehearsal project still exists after exact-id deletion");
    return { absent: true };
  }

  async #projectOrNull(idOrName) {
    try {
      return await this.#request("GET", `/v9/projects/${encodeURIComponent(idOrName)}`);
    } catch (error) {
      if (error instanceof VercelNotFoundError) return null;
      throw error;
    }
  }

  async #listDeployments(projectId) {
    const values = [];
    let until = null;
    const seen = new Set();
    for (let page = 0; page < 100; page += 1) {
      const suffix = until ? `&until=${encodeURIComponent(until)}` : "";
      const result = await this.#request("GET", `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=100${suffix}`);
      if (!Array.isArray(result.deployments)) throw new Error("Vercel deployment inventory is invalid");
      values.push(...result.deployments);
      until = result.pagination?.next == null ? null : String(result.pagination.next);
      if (!until) return values;
      if (seen.has(until)) throw new Error("Vercel deployment pagination repeated");
      seen.add(until);
    }
    throw new Error("Vercel deployment pagination exceeded the safety limit");
  }

  async #markedDeployment(project, generationId) {
    const matches = (await this.#listDeployments(project.id))
      .filter((entry) => entry.meta?.scorecheckRehearsalGeneration === generationId);
    if (matches.length > 1) throw new Error("Vercel returned multiple deployments for the rehearsal generation");
    return matches.length === 1 ? normalizeDeployment(matches[0], project, generationId) : null;
  }

  async #waitForMarkedDeployment(project, generationId, polls = 12, intervalMs = 5_000) {
    for (let poll = 0; poll < polls; poll += 1) {
      const deployment = await this.#markedDeployment(project, generationId);
      if (deployment) return deployment;
      if (poll + 1 < polls) await this.sleep(intervalMs);
    }
    return null;
  }

  async #team() {
    if (this.team) return this.team;
    this.team = normalizeTeam(await this.#request("GET", `/v2/teams/${encodeURIComponent(this.teamId)}`), this.teamId);
    return this.team;
  }

  async #request(method, path, body = undefined) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await this.fetchImpl(`${API}${path}${separator}teamId=${encodeURIComponent(this.teamId)}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000)
    });
    if (response.status === 404) throw new VercelNotFoundError("Vercel rehearsal resource was not found");
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const code = payload.error?.code ?? "unknown";
      throw new VercelRequestError(`Vercel ${method} ${path.split("?")[0]} failed with HTTP ${response.status} (${code})`, response.status);
    }
    if (response.status === 204) return null;
    return response.json();
  }
}

export function rehearsalProjectName(namespace) {
  if (typeof namespace !== "string" || !/^[a-z0-9-]{8,40}$/.test(namespace)) throw new Error("rehearsal namespace is invalid");
  const name = `scorecheck-rehearsal-${namespace}`.slice(0, 52).replace(/-+$/u, "");
  validateProjectName(name);
  return name;
}

function normalizeProject(value, expectedName, expectedOrigin) {
  if (!value || typeof value !== "object" || String(value.name) !== expectedName || value.framework !== "nextjs" || value.rootDirectory !== "apps/web") {
    throw new Error("Vercel rehearsal project contract is invalid");
  }
  validateProviderId(String(value.id), "project id");
  validateProjectName(value.name);
  validateProjectOrigin(expectedOrigin, value.name);
  if (value.origin !== undefined && value.origin !== expectedOrigin) throw new Error("Vercel rehearsal project origin changed");
  return { id: String(value.id), name: value.name, origin: expectedOrigin, framework: value.framework, rootDirectory: value.rootDirectory };
}

function normalizeTeam(value, expectedId) {
  if (!value || String(value.id) !== expectedId || typeof value.slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(value.slug)) {
    throw new Error("Vercel rehearsal team contract is invalid");
  }
  return { id: expectedId, slug: value.slug };
}

function projectOrigin(name, teamSlug) {
  const origin = `https://${name}-${teamSlug}.vercel.app`;
  validateProjectOrigin(origin, name);
  return origin;
}

function validateProjectOrigin(value, name) {
  if (typeof value !== "string" || !value.startsWith(`https://${name}-`) || !/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(value) || new URL(value).hostname.length > 253) {
    throw new Error("Vercel rehearsal project origin is invalid");
  }
}

function normalizeDeployment(value, project, generationId) {
  if (!value || typeof value !== "object" || String(value.projectId ?? value.project?.id ?? "") !== project.id || value.name !== project.name || value.target !== "production") {
    throw new Error("Vercel rehearsal deployment ownership is invalid");
  }
  validateProviderId(String(value.id ?? value.uid), "deployment id");
  if (value.meta?.scorecheckRehearsalGeneration !== generationId) throw new Error("Vercel rehearsal deployment marker is invalid");
  const state = String(value.readyState ?? value.state ?? "");
  if (!new Set(["QUEUED", "BUILDING", "INITIALIZING", "READY", "ERROR", "CANCELED"]).has(state)) throw new Error("Vercel rehearsal deployment state is invalid");
  const aliases = Array.isArray(value.alias) ? value.alias.filter((entry) => typeof entry === "string") : [];
  return {
    id: String(value.id ?? value.uid),
    projectId: project.id,
    name: project.name,
    state,
    target: "production",
    url: typeof value.url === "string" && value.url ? `https://${value.url}` : null,
    aliases,
    marker: generationId,
    createdAt: Number.isFinite(value.createdAt) ? new Date(value.createdAt).toISOString() : null
  };
}

function validateEnvironment(value, expectedOrigin) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) throw new Error("Vercel rehearsal environment is required");
  if (value.NEXT_PUBLIC_SCORECHECK_REHEARSAL !== "true") throw new Error("Vercel rehearsal environment marker is missing");
  if (Object.keys(value).some((key) => key.startsWith("SUPABASE_"))) throw new Error("Vercel rehearsal must not use production Supabase configuration");
  const serialized = JSON.stringify(value);
  if (serialized.includes("score.beachvolleyballmedia.com") || serialized.includes("www.beachvolleyballmedia.com")) throw new Error("Vercel rehearsal environment references a production web origin");
  if (value.SCORECHECK_REHEARSAL_ORIGIN !== expectedOrigin) throw new Error("Vercel rehearsal origin does not match the isolated project");
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof raw !== "string" || /[\r\n\0]/.test(raw)) throw new Error("Vercel rehearsal environment is invalid");
  }
}

function validateGitSource({ repoId, ref, sha }) {
  if (!(Number.isInteger(repoId) && repoId > 0) && !(typeof repoId === "string" && /^\d+$/.test(repoId))) throw new Error("Vercel rehearsal GitHub repository id is invalid");
  if (typeof ref !== "string" || !/^[a-zA-Z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) throw new Error("Vercel rehearsal Git ref is invalid");
  if (!SHA.test(sha)) throw new Error("Vercel rehearsal Git SHA is invalid");
}

function validateProjectName(value) {
  if (typeof value !== "string" || !PROJECT_NAME.test(value)) throw new Error("Vercel rehearsal project name is invalid");
}

function validateGeneration(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(value)) throw new Error("Vercel rehearsal generation id is invalid");
}

function validateProviderId(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{3,100}$/.test(value)) throw new Error(`Vercel ${label} is invalid`);
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${label} is required`);
  return value.trim();
}

export class VercelNotFoundError extends Error {
  constructor(message) { super(message); this.status = 404; }
}

export class VercelRequestError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
