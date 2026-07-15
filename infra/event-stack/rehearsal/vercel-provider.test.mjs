import assert from "node:assert/strict";
import test from "node:test";

import { rehearsalProjectName, VercelRehearsalProvider } from "./vercel-provider.mjs";

function response(status, body = null) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

const name = rehearsalProjectName("abcdefgh12345678");
const project = { id: "prj_test123", name, framework: "nextjs", rootDirectory: "apps/web" };
const generationId = "generation-1234";
const environment = { NEXT_PUBLIC_SCORECHECK_REHEARSAL: "true", SCORECHECK_REHEARSAL_ORIGIN: `https://${name}.vercel.app`, PROGRAM_PAGE_TOKEN: "secret" };

test("creates an isolated Next.js project and adopts it by deterministic name", async () => {
  let created = false;
  const requests = [];
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (init.method === "GET" && !created) return response(404, { error: { code: "not_found" } });
    if (init.method === "POST") { created = true; return response(200, project); }
    return response(200, project);
  }});
  assert.equal((await client.ensureProject({ name })).id, "prj_test123");
  assert.equal((await client.ensureProject({ name })).id, "prj_test123");
  assert.equal(requests.filter((entry) => entry.init.method === "POST").length, 1);
});

test("creates exactly one marked deployment from an exact Git SHA", async () => {
  let deployment = null;
  const requests = [];
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.includes("/v6/deployments")) return response(200, { deployments: deployment ? [deployment] : [], pagination: {} });
    if (url.includes("/v13/deployments") && init.method === "POST") {
      deployment = { id: "dpl_test123", projectId: project.id, name, target: "production", readyState: "BUILDING", meta: { scorecheckRehearsalGeneration: generationId }, alias: [] };
      return response(200, deployment);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  }});
  const input = { project: { ...project, origin: `https://${name}.vercel.app` }, generationId, repoId: 123, ref: "codex/turnkey-event-lifecycle", sha: "a".repeat(40), environment };
  assert.equal((await client.ensureDeployment(input)).id, "dpl_test123");
  assert.equal((await client.ensureDeployment(input)).id, "dpl_test123");
  const body = JSON.parse(requests.find((entry) => entry.init.method === "POST").init.body);
  assert.equal(body.target, "production");
  assert.equal(body.gitSource.sha, "a".repeat(40));
  assert.equal(requests.filter((entry) => entry.init.method === "POST").length, 1);
});

test("requires the isolated alias before accepting READY", async () => {
  let includeAlias = false;
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", sleep: async () => {}, fetchImpl: async () => response(200, {
    id: "dpl_test123", projectId: project.id, name, target: "production", readyState: "READY", meta: { scorecheckRehearsalGeneration: generationId }, alias: includeAlias ? [`${name}.vercel.app`] : []
  }) });
  await assert.rejects(() => client.waitReady({ deploymentId: "dpl_test123", project: { ...project, origin: `https://${name}.vercel.app` }, generationId }), /without its isolated project alias/);
  includeAlias = true;
  assert.equal((await client.waitReady({ deploymentId: "dpl_test123", project: { ...project, origin: `https://${name}.vercel.app` }, generationId })).state, "READY");
});

test("rejects production web origins and Supabase environment", async () => {
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", fetchImpl: async () => response(200, { deployments: [], pagination: {} }) });
  for (const changed of [
    { ...environment, SUPABASE_URL: "https://example.supabase.co" },
    { ...environment, SCORECHECK_REHEARSAL_ORIGIN: "https://score.beachvolleyballmedia.com" }
  ]) {
    await assert.rejects(() => client.ensureDeployment({ project: { ...project, origin: `https://${name}.vercel.app` }, generationId, repoId: 123, ref: "branch", sha: "a".repeat(40), environment: changed }), /Supabase|production web origin|origin does not match/);
  }
});

test("deletes one exact project id and proves absence", async () => {
  const calls = [];
  const client = new VercelRehearsalProvider({ token: "token", teamId: "team", fetchImpl: async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return init.method === "DELETE" ? response(204) : response(404, { error: { code: "not_found" } });
  }});
  assert.deepEqual(await client.deleteProject("prj_test123"), { absent: true });
  assert.match(calls[0], /DELETE .*\/v9\/projects\/prj_test123/);
});
