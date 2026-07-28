import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoSymlinks, assertPortableRendererTree, rendererBuildEnvironment, validateLocalRendererArtifact } from "./local-renderer-bundle.mjs";

const gitSha = "a".repeat(40);
const deploymentId = "dpl_renderer123";
const rendererOrigin = "https://scorecheck-renderer-abc-team.vercel.app";

test("binds the local build to the immutable renderer identity", () => {
  const environment = rendererBuildEnvironment({
    environment: { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co" },
    gitSha,
    deploymentId,
    rendererOrigin
  });
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.VERCEL_GIT_COMMIT_SHA, gitSha);
  assert.equal(environment.VERCEL_DEPLOYMENT_ID, deploymentId);
  assert.equal(environment.VERCEL_URL, "scorecheck-renderer-abc-team.vercel.app");
});

test("validates artifact identity and digest", () => {
  const artifact = validateLocalRendererArtifact({
    schemaVersion: 1,
    path: "/protected/local-renderer.tar.gz",
    sha256: "b".repeat(64),
    bytes: 123,
    gitSha,
    deploymentId
  }, { gitSha, deploymentId });
  assert.equal(artifact.bytes, 123);
  assert.throws(
    () => validateLocalRendererArtifact({ ...artifact, deploymentId: "dpl_other" }, { deploymentId }),
    /does not match/u
  );
});

test("rejects a renderer artifact tree that could escape through a symlink", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorecheck-renderer-symlink-"));
  try {
    await mkdir(path.join(directory, "safe"));
    await writeFile(path.join(directory, "safe", "server.js"), "module.exports = {};\n");
    await symlink("/tmp", path.join(directory, "node_modules"));
    await assert.rejects(() => assertNoSymlinks(directory), /symbolic link/u);
    await rm(path.join(directory, "node_modules"));
    await assert.doesNotReject(() => assertNoSymlinks(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects platform-specific native addons in a renderer artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorecheck-renderer-native-"));
  try {
    await mkdir(path.join(directory, "node_modules"));
    await writeFile(path.join(directory, "node_modules", "sharp.node"), "not-a-real-addon");
    await assert.rejects(() => assertPortableRendererTree(directory), /native addon/u);
    await rm(path.join(directory, "node_modules", "sharp.node"));
    await assert.doesNotReject(() => assertPortableRendererTree(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
