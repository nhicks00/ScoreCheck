import assert from "node:assert/strict";
import test from "node:test";

import { DEPLOYMENT_CREATE_TIMEOUT_MS, rehearsalProjectName, VercelRehearsalProvider } from "./vercel-provider.mjs";

function response(status, body = null, contentType = "application/json") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    json: async () => body,
    text: async () => typeof body === "string" ? body : JSON.stringify(body)
  };
}

const name = rehearsalProjectName("abcdefgh12345678");
const teamSlug = "test-team";
const origin = `https://${name}-${teamSlug}.vercel.app`;
const repository = { slug: "nhicks00/ScoreCheck", repoId: "123" };
const project = { id: "prj_test123", name, origin, framework: "nextjs", rootDirectory: "apps/web", repository };
const projectResponse = { id: project.id, name, framework: "nextjs", rootDirectory: "apps/web", link: { type: "github", org: "nhicks00", repo: "ScoreCheck", repoId: 123 } };
const generationId = "generation-1234";
const environment = { NEXT_PUBLIC_SCORECHECK_REHEARSAL: "true", SCORECHECK_REHEARSAL_ORIGIN: origin, PROGRAM_PAGE_TOKEN: "secret" };

function environmentResponse(init) {
  const variables = JSON.parse(init.body);
  return response(201, { created: variables.map(({ key }) => ({ key })), failed: [] });
}

test("creates an isolated Next.js project and adopts it by deterministic name", async () => {
  let created = false;
  const requests = [];
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (init.method === "GET" && !created) return response(404, { error: { code: "not_found" } });
    if (init.method === "POST") { created = true; return response(200, projectResponse); }
    return response(200, projectResponse);
  }});
  assert.equal((await client.ensureProject({ name, repository })).id, "prj_test123");
  assert.equal((await client.ensureProject({ name, repository })).id, "prj_test123");
  assert.equal(requests.filter((entry) => entry.init.method === "POST").length, 1);
  assert.deepEqual(JSON.parse(requests.find((entry) => entry.init.method === "POST").init.body).gitRepository, { type: "github", repo: "nhicks00/ScoreCheck" });
});

test("creates exactly one marked deployment from an exact Git SHA", async () => {
  let deployment = null;
  const requests = [];
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.includes("/v10/projects/") && url.includes("/env")) return environmentResponse(init);
    if (url.includes("/v6/deployments")) return response(200, { deployments: deployment ? [deployment] : [], pagination: {} });
    if (url.includes("/v13/deployments") && init.method === "POST") {
      deployment = { id: "dpl_test123", projectId: project.id, name, target: "production", readyState: "BUILDING", meta: { scorecheckRehearsalGeneration: generationId }, alias: [] };
      return response(200, deployment);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  }});
  const input = { project, generationId, repoId: 123, ref: "codex/turnkey-event-lifecycle", sha: "a".repeat(40), environment };
  assert.equal((await client.ensureDeployment(input)).id, "dpl_test123");
  assert.equal((await client.ensureDeployment(input)).id, "dpl_test123");
  const body = JSON.parse(requests.find((entry) => entry.url.includes("/v13/deployments") && entry.init.method === "POST").init.body);
  assert.equal(body.target, "production");
  assert.equal(body.gitSource.sha, "a".repeat(40));
  assert.equal(body.env, undefined);
  const envRequest = requests.find((entry) => entry.url.includes("/env"));
  assert.equal(new URL(envRequest.url).searchParams.get("upsert"), "true");
  assert.deepEqual(JSON.parse(envRequest.init.body).map(({ key, type, target }) => ({ key, type, target })), [
    { key: "NEXT_PUBLIC_SCORECHECK_REHEARSAL", type: "encrypted", target: ["production"] },
    { key: "PROGRAM_PAGE_TOKEN", type: "encrypted", target: ["production"] },
    { key: "SCORECHECK_REHEARSAL_ORIGIN", type: "encrypted", target: ["production"] }
  ]);
  assert.equal(requests.filter((entry) => entry.url.includes("/v13/deployments") && entry.init.method === "POST").length, 1);
});

test("adopts an ambiguously created deployment after a transient provider failure", async () => {
  let deployment = null;
  let postCount = 0;
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, sleep: async () => {}, fetchImpl: async (url, init) => {
    if (url.includes("/v10/projects/") && url.includes("/env")) return environmentResponse(init);
    if (url.includes("/v6/deployments")) return response(200, { deployments: deployment ? [deployment] : [], pagination: {} });
    if (url.includes("/v13/deployments") && init.method === "POST") {
      postCount += 1;
      deployment = { id: "dpl_ambiguous", projectId: project.id, name, target: "production", readyState: "BUILDING", meta: { scorecheckRehearsalGeneration: generationId }, alias: [] };
      return response(500, { error: { code: "internal_server_error" } });
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  }});
  const result = await client.ensureDeployment({ project, generationId, repoId: 123, ref: "master", sha: "a".repeat(40), environment });
  assert.equal(result.id, "dpl_ambiguous");
  assert.equal(postCount, 1);
});

test("reconciles an ambiguously created deployment after a provider request timeout", async () => {
  let deployment = null;
  let postCount = 0;
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, sleep: async () => {}, fetchImpl: async (url, init) => {
    if (url.includes("/v10/projects/") && url.includes("/env")) return environmentResponse(init);
    if (url.includes("/v6/deployments")) return response(200, { deployments: deployment ? [deployment] : [], pagination: {} });
    if (url.includes("/v13/deployments") && init.method === "POST") {
      postCount += 1;
      deployment = { id: "dpl_timeout", projectId: project.id, name, target: "production", readyState: "BUILDING", meta: { scorecheckRehearsalGeneration: generationId }, alias: [] };
      throw new DOMException("request timed out", "TimeoutError");
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  }});
  const result = await client.ensureDeployment({ project, generationId, repoId: 123, ref: "master", sha: "a".repeat(40), environment });
  assert.equal(result.id, "dpl_timeout");
  assert.equal(postCount, 1);
});

test("gives deployment creation a longer bounded response window", async () => {
  assert.equal(DEPLOYMENT_CREATE_TIMEOUT_MS, 120_000);
  let deploymentSignal;
  let deploymentUrl;
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, fetchImpl: async (url, init) => {
    if (url.includes("/v10/projects/") && url.includes("/env")) return environmentResponse(init);
    if (url.includes("/v6/deployments")) return response(200, { deployments: [], pagination: {} });
    if (url.includes("/v13/deployments") && init.method === "POST") {
      deploymentSignal = init.signal;
      deploymentUrl = new URL(url);
      return response(200, { id: "dpl_slow", projectId: project.id, name, target: "production", readyState: "BUILDING", meta: { scorecheckRehearsalGeneration: generationId }, alias: [] });
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  }});
  const result = await client.ensureDeployment({ project, generationId, repoId: 123, ref: "master", sha: "a".repeat(40), environment });
  assert.equal(result.id, "dpl_slow");
  assert.equal(deploymentSignal.aborted, false);
  assert.ok(deploymentSignal instanceof AbortSignal);
  assert.equal(deploymentUrl.searchParams.get("forceNew"), "1");
  assert.equal(deploymentUrl.searchParams.get("skipAutoDetectionConfirmation"), "1");
  assert.equal(deploymentUrl.searchParams.get("teamId"), "team");
});

test("retries a definite transient deployment failure only after bounded absence proof", async () => {
  let postCount = 0;
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, sleep: async () => {}, fetchImpl: async (url, init) => {
    if (url.includes("/v10/projects/") && url.includes("/env")) return environmentResponse(init);
    if (url.includes("/v6/deployments")) return response(200, { deployments: [], pagination: {} });
    if (url.includes("/v13/deployments") && init.method === "POST") {
      postCount += 1;
      if (postCount === 1) return response(500, { error: { code: "internal_server_error" } });
      return response(200, { id: "dpl_retry", projectId: project.id, name, target: "production", readyState: "BUILDING", meta: { scorecheckRehearsalGeneration: generationId }, alias: [] });
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  }});
  const result = await client.ensureDeployment({ project, generationId, repoId: 123, ref: "master", sha: "a".repeat(40), environment });
  assert.equal(result.id, "dpl_retry");
  assert.equal(postCount, 2);
});

test("requires the isolated alias before accepting READY", async () => {
  let includeAlias = false;
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, sleep: async () => {}, fetchImpl: async () => response(200, {
    id: "dpl_test123", projectId: project.id, name, target: "production", readyState: "READY", meta: { scorecheckRehearsalGeneration: generationId }, alias: includeAlias ? [new URL(origin).hostname] : []
  }) });
  await assert.rejects(() => client.waitReady({ deploymentId: "dpl_test123", project, generationId }), /without its isolated project alias/);
  includeAlias = true;
  assert.equal((await client.waitReady({ deploymentId: "dpl_test123", project, generationId })).state, "READY");
});

test("fails closed when Vercel does not confirm the complete project environment", async () => {
  const client = new VercelRehearsalProvider({
    token: "token",
    teamId: "team",
    teamSlug,
    fetchImpl: async (url) => url.includes("/env")
      ? response(201, { created: [{ key: "PROGRAM_PAGE_TOKEN" }], failed: [] })
      : response(200, { deployments: [], pagination: {} })
  });
  await assert.rejects(
    () => client.ensureDeployment({ project, generationId, repoId: 123, ref: "master", sha: "a".repeat(40), environment }),
    /incomplete key set/
  );
});

test("probes the token-gated Program document before event resources are created", async () => {
  const requests = [];
  const client = new VercelRehearsalProvider({
    token: "token",
    teamId: "team",
    teamSlug,
    fetchImpl: async () => response(500),
    publicFetchImpl: async (url, init) => {
      requests.push({ url, init });
      return url.includes("invalid-rehearsal-token")
        ? response(404, "not found", "text/plain")
        : response(200, '<div class="program-root"></div>', "text/html; charset=utf-8");
    }
  });
  const result = await client.verifyProgramPage({ project, token: "x".repeat(32) });
  assert.equal(result.status, "healthy");
  assert.equal(requests.length, 2);
  assert.ok(requests.every((entry) => entry.init.redirect === "error"));
  assert.ok(requests.every((entry) => !entry.init.headers.authorization));
});

test("retries a cold Program document until the isolated route is ready", async () => {
  let acceptedAttempts = 0;
  const client = new VercelRehearsalProvider({
    token: "token",
    teamId: "team",
    teamSlug,
    sleep: async () => {},
    publicFetchImpl: async (url) => {
      if (url.includes("invalid-rehearsal-token")) return response(404, "not found", "text/plain");
      acceptedAttempts += 1;
      if (acceptedAttempts === 1) throw new DOMException("cold request timed out", "TimeoutError");
      if (acceptedAttempts === 2) return response(503, "warming", "text/plain");
      return response(200, '<div class="program-root"></div>', "text/html");
    }
  });
  assert.equal((await client.verifyProgramPage({ project, token: "x".repeat(32) })).status, "healthy");
  assert.equal(acceptedAttempts, 3);
});

test("fails Program preflight on deployment protection, wrong content, or a weak token gate", async () => {
  for (const [accepted, rejected] of [
    [response(401, "protected", "text/html"), response(404, "not found", "text/plain")],
    [response(200, "wrong page", "text/html"), response(404, "not found", "text/plain")],
    [response(200, '<div class="program-root"></div>', "text/html"), response(200, '<div class="program-root"></div>', "text/html")]
  ]) {
    const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, publicFetchImpl: async (url) => url.includes("invalid-rehearsal-token") ? rejected : accepted });
    await assert.rejects(() => client.verifyProgramPage({ project, token: "x".repeat(32) }), /preflight|wrong document|token rejection/);
  }
});

test("derives the isolated production origin from the authenticated Vercel team", async () => {
  const requests = [];
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team_123", fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.includes("/v9/projects/")) return response(404, { error: { code: "not_found" } });
    if (url.includes("/v2/teams/team_123")) return response(200, { id: "team_123", slug: "volleyfest" });
    if (init.method === "POST") return response(200, { ...projectResponse, origin: undefined });
    throw new Error(`unexpected ${init.method} ${url}`);
  }});
  const created = await client.ensureProject({ name, repository });
  assert.equal(created.origin, `https://${name}-volleyfest.vercel.app`);
  assert.equal(requests.filter((entry) => entry.url.includes("/v2/teams/")).length, 1);
});

test("rejects an existing isolated project that is not linked to the exact repository", async () => {
  const client = new VercelRehearsalProvider({
    token: "token",
    teamId: "team",
    teamSlug,
    fetchImpl: async () => response(200, { ...projectResponse, link: null })
  });
  await assert.rejects(() => client.ensureProject({ name, repository }), /Git repository contract/);
});

test("rejects production web origins and Supabase environment", async () => {
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, fetchImpl: async (url, init) => url.includes("/env") ? environmentResponse(init) : response(200, { deployments: [], pagination: {} }) });
  for (const changed of [
    { ...environment, SUPABASE_URL: "https://example.supabase.co" },
    { ...environment, SCORECHECK_REHEARSAL_ORIGIN: "https://score.beachvolleyballmedia.com" }
  ]) {
    await assert.rejects(() => client.ensureDeployment({ project, generationId, repoId: 123, ref: "branch", sha: "a".repeat(40), environment: changed }), /Supabase|production web origin|origin does not match/);
  }
});

test("deletes one exact project id and proves absence", async () => {
  const calls = [];
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", teamSlug, fetchImpl: async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return init.method === "DELETE" ? response(204) : response(404, { error: { code: "not_found" } });
  }});
  assert.deepEqual(await client.deleteProject("prj_test123"), { absent: true });
  assert.match(calls[0], /DELETE .*\/v9\/projects\/prj_test123/);
});
