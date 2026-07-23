import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildProductionRendererEnvironment,
  destroyProductionRenderer,
  prepareProductionRenderer,
  redactRendererState
} from "./production-renderer.mjs";
import { validateEnvironment } from "./rehearsal/vercel-provider.mjs";

const event = "physical-qualification-r1";
const gitSha = "a".repeat(40);
const origin = "https://scorecheck-rehearsal-physical-qualification-test.vercel.app";
const deploymentOrigin = "https://scorecheck-rehearsal-physical-qualification-test-abc123.vercel.app";
const webEnv = {
  LIVEKIT_COMMENTARY_API_KEY: "livekit-key",
  LIVEKIT_COMMENTARY_API_SECRET: "livekit-secret",
  MEDIAMTX_WHEP_BASE_URL: "https://preview.example.test",
  MONITOR_BROWSER_HEARTBEAT_SECRET: "monitor-secret",
  MONITOR_PUBLIC_URL: "https://monitor.example.test",
  NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL: "wss://rtc.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.test",
  PROGRAM_PAGE_TOKEN: "program-token",
  SUPABASE_SERVICE_ROLE_KEY: "service-role"
};

test("builds the exact Program renderer environment without operator or output credentials", () => {
  const environment = buildProductionRendererEnvironment(webEnv, origin);
  assert.equal(environment.NEXT_PUBLIC_SITE_URL, origin);
  assert.equal(environment.NEXT_PUBLIC_COURT_COUNT, "8");
  assert.equal(environment.ADMIN_SECRET, undefined);
  assert.equal(environment.YOUTUBE_CLIENT_SECRET, undefined);
  validateEnvironment(environment, origin, "production-renderer");
  assert.throws(() => validateEnvironment({ ...environment, ADMIN_SECRET: "forbidden" }, origin, "production-renderer"), /exact allowlist/);
  assert.throws(() => validateEnvironment({ ...environment, NEXT_PUBLIC_SITE_URL: "https://other.vercel.app" }, origin, "production-renderer"), /origin/);
});

test("prepares one protected immutable renderer binding and reuses it only for the same event/release", async () => {
  const root = await mkdirProtectedRoot();
  const output = join(root, "renderer");
  const calls = [];
  const provider = fakeProvider(calls);
  try {
    const first = await prepareProductionRenderer({ event, gitSha, repo: "nhicks00/ScoreCheck", repoId: "1130613388", output, provider, webEnv, now: () => new Date("2026-07-23T14:00:00.000Z"), capture: fakeCapture });
    assert.equal(first.status, "READY");
    assert.equal(first.deployment.id, "dpl_renderer123");
    assert.ok(calls.includes("ensureProject"));
    assert.ok(calls.includes("verifyProgramPage"));
    const binding = JSON.parse(await readFile(join(output, "renderer-binding.json"), "utf8"));
    assert.equal(binding.gitSha, gitSha);
    assert.equal(binding.deploymentId, "dpl_renderer123");
    assert.equal(redactRendererState(first).environmentKeys.includes("SUPABASE_SERVICE_ROLE_KEY"), true);
    const second = await prepareProductionRenderer({ event, gitSha, repo: "nhicks00/ScoreCheck", repoId: "1130613388", output, provider, webEnv, capture: fakeCapture });
    assert.deepEqual(second, first);
    assert.equal(calls.filter((call) => call === "ensureProject").length, 1);
    await assert.rejects(
      () => prepareProductionRenderer({ event, gitSha: "b".repeat(40), repo: "nhicks00/ScoreCheck", repoId: "1130613388", output, provider, webEnv, capture: fakeCapture }),
      /different event or release/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deletes only the exact renderer project after the caller provides the event-scoped confirmation", async () => {
  const root = await mkdirProtectedRoot();
  const output = join(root, "renderer");
  const calls = [];
  const provider = fakeProvider(calls);
  try {
    await prepareProductionRenderer({ event, gitSha, repo: "nhicks00/ScoreCheck", repoId: "1130613388", output, provider, webEnv, capture: fakeCapture });
    await assert.rejects(() => destroyProductionRenderer({ event, output, confirmation: "wrong", provider }), /confirmation/);
    const result = await destroyProductionRenderer({ event, output, confirmation: `DESTROY-RENDERER:${event}`, provider, now: () => new Date("2026-07-23T14:05:00.000Z") });
    assert.equal(result.status, "DESTROYED");
    assert.deepEqual(calls.filter((call) => call.startsWith("delete:")), ["delete:prj_renderer123"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeProvider(calls) {
  const project = { id: "prj_renderer123", name: "scorecheck-rehearsal-physical-qualificatio", origin, framework: "nextjs", rootDirectory: "apps/web", repository: { slug: "nhicks00/ScoreCheck", repoId: "1130613388" } };
  const deployment = { id: "dpl_renderer123", projectId: project.id, name: project.name, state: "READY", target: "production", url: deploymentOrigin, aliases: [new URL(origin).hostname], marker: "physical-qualification-r1-aaaaaaaaaaaa" };
  return {
    async ensureProject() { calls.push("ensureProject"); return project; },
    async ensureDeployment(input) { calls.push("ensureDeployment"); validateEnvironment(input.environment, origin, "production-renderer"); return deployment; },
    async waitReady() { calls.push("waitReady"); return deployment; },
    async verifyProgramPage() { calls.push("verifyProgramPage"); return { status: "healthy" }; },
    async deleteProject(id) { calls.push(`delete:${id}`); return { absent: true }; }
  };
}

async function fakeCapture({ origin: captureOrigin, output }) {
  const value = {
    schemaVersion: 1,
    provider: "vercel",
    origin: captureOrigin,
    deploymentId: "dpl_renderer123",
    gitSha,
    assetNamespace: "dpl_renderer123",
    contracts: {
      programSession: "program-session-v1",
      overlayState: "overlay-state-v1",
      commentary: "commentary-v1",
      browserHeartbeat: "browser-heartbeat-v5"
    }
  };
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(output, 0o600);
  return { sha256: "a".repeat(64) };
}

async function mkdirProtectedRoot() {
  const root = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "scorecheck-production-renderer-"));
  await chmod(root, 0o700);
  return root;
}
