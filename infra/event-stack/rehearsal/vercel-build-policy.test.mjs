import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("always builds isolated rehearsals while retaining unchanged production build skipping", async () => {
  const config = JSON.parse(await readFile(join(repositoryRoot, "apps/web/vercel.json"), "utf8"));
  assert.equal(typeof config.ignoreCommand, "string");

  const root = await mkdtemp(join(os.tmpdir(), "scorecheck-vercel-policy-"));
  const web = join(root, "apps/web");
  await mkdir(web, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@scorecheck.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "ScoreCheck Test"], { cwd: root });
  await writeFile(join(web, "page.txt"), "stable\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "web"], { cwd: root });
  await writeFile(join(root, "outside.txt"), "non-web change\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "outside"], { cwd: root });

  const production = spawnSync("sh", ["-c", config.ignoreCommand], { cwd: web, env: { ...process.env, VERCEL_PROJECT_NAME: "scorecheck" } });
  const rehearsal = spawnSync("sh", ["-c", config.ignoreCommand], { cwd: web, env: { ...process.env, VERCEL_PROJECT_NAME: "scorecheck-rehearsal-test" } });
  assert.equal(production.status, 0, "unchanged production web build should be skipped");
  assert.equal(rehearsal.status, 1, "isolated rehearsal must always continue its build");
});
