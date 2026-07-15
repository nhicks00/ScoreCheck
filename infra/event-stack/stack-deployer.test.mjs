import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { buildAgentPlans, loadProtectedEnv, serializeAgentTargets } from "./stack-deployer.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "deploy-test", destroyAfter: "2026-08-01", ...inputs });

function stateFixture() {
  return {
    droplets: Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, {
      id: String(1000 + index),
      publicIpv4: `198.51.100.${index + 1}`,
      privateIpv4: `10.20.0.${index + 1}`
    }]))
  };
}

function tokenFixture() {
  return {
    schemaVersion: 1,
    tokens: Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, `token-${String(index).padStart(2, "0")}-abcdefghijklmnopqrstuvwxyz`]))
  };
}

test("builds one private monitoring target per exact event resource", () => {
  const plans = buildAgentPlans({ manifest, state: stateFixture(), tokenConfig: tokenFixture() });
  assert.equal(plans.length, 12);
  assert.equal(new Set(plans.map((entry) => entry.id)).size, 12);
  assert.deepEqual(plans.filter((entry) => entry.role === "compositor").map((entry) => entry.courts), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  const spare = plans.find((entry) => entry.id === "bvm-compositor-spare");
  assert.equal(spare.role, "worker");
  assert.equal(spare.courts, "");
  assert.equal(plans.find((entry) => entry.id === "bvm-preview-01").role, "mediamtx");
  const serialized = serializeAgentTargets(plans);
  assert.equal(serialized.split(",").length, 12);
  assert.match(serialized, /bvm-compositor-a\|compositor\|http:\/\/10\.20\.0\.4:9108\|[^|]+\|1/);
});

test("rejects missing, extra, short, or duplicated token ownership", () => {
  const state = stateFixture();
  const missing = tokenFixture();
  delete missing.tokens[manifest.droplets[0].name];
  assert.throws(() => buildAgentPlans({ manifest, state, tokenConfig: missing }), /exactly one token/);
  const extra = tokenFixture();
  extra.tokens.unexpected = "abcdefghijklmnopqrstuvwxyz123456";
  assert.throws(() => buildAgentPlans({ manifest, state, tokenConfig: extra }), /exactly one token/);
  const short = tokenFixture();
  short.tokens[manifest.droplets[0].name] = "short";
  assert.throws(() => buildAgentPlans({ manifest, state, tokenConfig: short }), /token is invalid/);
});

test("loads only protected, bounded KEY=VALUE environment files", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-env-test-"));
  const path = join(root, "service.env");
  await writeFile(path, 'PLAIN=value\nQUOTED="value with space"\n# comment\n', { mode: 0o600 });
  assert.deepEqual(await loadProtectedEnv(path), { PLAIN: "value", QUOTED: "value with space" });
  await chmod(path, 0o644);
  await assert.rejects(() => loadProtectedEnv(path), /protected regular file/);
  await chmod(path, 0o600);
  await writeFile(path, "DUP=one\nDUP=two\n", { mode: 0o600 });
  await assert.rejects(() => loadProtectedEnv(path), /invalid or duplicate/);
});
