import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { buildAgentPlans, commentaryEndpointHosts, loadProtectedEnv, roleConfigBindings, serializeAgentTargets, servicePublicIpv4 } from "./stack-deployer.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "deploy-test", kind: "production", destroyAfter: "2026-08-01", ...inputs });
const rehearsalManifest = buildEventManifest({ event: "deploy-test", kind: "rehearsal", destroyAfter: "2026-08-01", ...inputs });

function stateFixture() {
  return {
    addressSlots: {
      commentary: { ip: "192.0.2.11" },
      ingest: { ip: "192.0.2.10" }
    },
    droplets: Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, {
      id: String(1000 + index),
      publicIpv4: `198.51.100.${index + 1}`,
      privateIpv4: `10.20.0.${index + 1}`
    }]))
  };
}

test("uses stable Reserved IPv4s in production and exact Droplet IPv4s in rehearsal", () => {
  const state = stateFixture();
  const productionSpec = manifest.droplets.find((entry) => entry.role === "ingest");
  const rehearsalSpec = rehearsalManifest.droplets.find((entry) => entry.role === "ingest");
  assert.equal(servicePublicIpv4({ manifest, state, spec: productionSpec, resource: state.droplets[productionSpec.name] }), "192.0.2.10");
  assert.equal(servicePublicIpv4({ manifest: rehearsalManifest, state: { ...state, addressSlots: {} }, spec: rehearsalSpec, resource: state.droplets[rehearsalSpec.name] }), state.droplets[rehearsalSpec.name].publicIpv4);
});

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

test("selects exact production and rehearsal commentary TLS hosts", () => {
  assert.deepEqual(commentaryEndpointHosts(manifest), {
    rtc: "rtc.beachvolleyballmedia.com",
    turn: "turn.beachvolleyballmedia.com"
  });
  const rehearsal = commentaryEndpointHosts(rehearsalManifest);
  assert.equal(rehearsal.rtc, `rtc-${rehearsalManifest.namespace}.beachvolleyballmedia.com`);
  assert.equal(rehearsal.turn, `turn-${rehearsalManifest.namespace}.beachvolleyballmedia.com`);
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

test("binds each role to exact remote reconstruction config paths", () => {
  const repoRoot = "/repo";
  const secrets = "/secrets";
  const ingest = roleConfigBindings(repoRoot, secrets, { role: "ingest", name: "bvm-preview-01" });
  assert.deepEqual(ingest.map((entry) => entry[1]), [
    "/opt/mediamtx/docker-compose.yml",
    "/opt/mediamtx/mediamtx.yml",
    "/opt/mediamtx/Caddyfile",
    "/opt/mediamtx/scorecheck-ffmpeg-runner.sh"
  ]);
  const compositor = roleConfigBindings(repoRoot, secrets, { role: "compositor", name: "bvm-compositor-a" });
  assert.ok(compositor.some(([local, remote]) => local === "/secrets/compositors/bvm-compositor-a.env" && remote === "/opt/compositor/.env"));
  assert.throws(() => roleConfigBindings(repoRoot, secrets, { role: "unknown", name: "unknown" }), /unsupported deployment role/);
});
