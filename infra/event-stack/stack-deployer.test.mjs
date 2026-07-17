import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { buildAgentPlans, commentaryEndpointHosts, compositorContentAnalyzerBindings, deploymentScriptEnvironment, isRetryableDeploymentTransportError, loadProtectedEnv, roleConfigBindings, runDeploymentScript, serializeAgentTargets, servicePublicIpv4, verifyProtectedSecretDirectory } from "./stack-deployer.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "deploy-test", kind: "production", destroyAfter: "2026-08-01", ...inputs });
const rehearsalManifest = buildEventManifest({ event: "deploy-test", kind: "rehearsal", destroyAfter: "2026-08-01", ...inputs });

test("makes the exact lifecycle Node runtime available to every deployment script", () => {
  const value = deploymentScriptEnvironment({ SERVICE_VALUE: "configured", PATH: "/untrusted" }, { PATH: "/usr/bin:/bin", HOME: "/tmp/home" }, process.execPath);
  assert.deepEqual(value.PATH.split(":"), [dirname(process.execPath), "/usr/bin", "/bin"]);
  assert.equal(value.HOME, "/tmp/home");
  assert.equal(value.SERVICE_VALUE, "configured");
  assert.equal(value.PATH.includes("/untrusted"), false);
});

test("retries only exact transient SSH transport failures", () => {
  for (const message of [
    "ssh failed with exit 255: Connection timed out during banner exchange\nConnection to 192.0.2.1 port 22 timed out",
    "ssh failed: Connection reset by peer",
    "rsync failed: kex_exchange_identification: read: Connection reset by peer"
  ]) assert.equal(isRetryableDeploymentTransportError(new Error(message)), true);
  for (const message of [
    "Permission denied (publickey)",
    "host key verification failed",
    "deployment did not pass its health gate",
    "docker compose returned exit 1",
    "connect to host 192.0.2.1 port 22: No route to host"
  ]) assert.equal(isRetryableDeploymentTransportError(new Error(message)), false);
});

test("bounds transient deployment retries and never retries a configuration failure", async () => {
  const waits = [];
  let attempts = 0;
  const result = await runDeploymentScript({
    script: "/repo/deploy.sh",
    environment: {},
    wait: async (milliseconds) => { waits.push(milliseconds); },
    runner: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ssh failed: Connection timed out during banner exchange");
      return { code: 0 };
    }
  });
  assert.deepEqual(result, { code: 0 });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2_000, 4_000]);

  let configurationAttempts = 0;
  await assert.rejects(() => runDeploymentScript({
    script: "/repo/deploy.sh",
    environment: {},
    wait: async () => assert.fail("configuration failure must not wait"),
    runner: async () => { configurationAttempts += 1; throw new Error("invalid rendered configuration"); }
  }), /invalid rendered configuration/);
  assert.equal(configurationAttempts, 1);
});

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
  assert.equal(spare.environment.MONITOR_CONTENT_ANALYZER_COURTS, undefined);
  assert.equal(spare.environment.MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL, undefined);
  assert.equal(plans.find((entry) => entry.id === "bvm-preview-01").role, "mediamtx");
  const compositor = plans.find((entry) => entry.id === "bvm-compositor-a");
  assert.equal(compositor.environment.MONITOR_CONTENT_ANALYZER_COURTS, "1");
  assert.equal(compositor.environment.MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL, "rtsp://10.20.0.3:8554");
  assert.deepEqual(compositorContentAnalyzerBindings({ manifest, state: stateFixture() }), [
    { ip: "10.20.0.4", courts: [1] }, { ip: "10.20.0.5", courts: [2] },
    { ip: "10.20.0.6", courts: [3] }, { ip: "10.20.0.7", courts: [4] },
    { ip: "10.20.0.8", courts: [5] }, { ip: "10.20.0.9", courts: [6] },
    { ip: "10.20.0.10", courts: [7] }, { ip: "10.20.0.11", courts: [8] }
  ]);
  const serialized = serializeAgentTargets(plans);
  assert.equal(serialized.split(",").length, 12);
  assert.match(serialized, /bvm-compositor-a\|compositor\|http:\/\/10\.20\.0\.4:9108\|[^|]+\|1/);
});

test("fails closed when analyzer source ownership or private addresses are incomplete", () => {
  const state = stateFixture();
  delete state.droplets["bvm-preview-01"].privateIpv4;
  assert.throws(() => buildAgentPlans({ manifest, state, tokenConfig: tokenFixture() }), /ingest service is missing private IPv4/u);

  const missingCompositor = stateFixture();
  delete missingCompositor.droplets["bvm-compositor-h"].privateIpv4;
  assert.throws(() => compositorContentAnalyzerBindings({ manifest, state: missingCompositor }), /every assigned compositor/u);

  const duplicated = stateFixture();
  duplicated.droplets["bvm-compositor-h"].privateIpv4 = duplicated.droplets["bvm-compositor-g"].privateIpv4;
  assert.throws(() => compositorContentAnalyzerBindings({ manifest, state: duplicated }), /must be unique/u);

  const duplicatedCourt = structuredClone(manifest);
  duplicatedCourt.droplets.find((entry) => entry.name === "bvm-compositor-h").court = 7;
  assert.throws(() => compositorContentAnalyzerBindings({ manifest: duplicatedCourt, state: stateFixture() }), /courts must be unique/u);
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

test("requires an intact protected secret render before deployment", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-secrets-test-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "compositors"), { mode: 0o700 });
  const names = [
    "agent-tokens.json", "commentary.env", "ingest.env", "observability.env",
    ...["a", "b", "c", "d", "e", "f", "g", "h"].map((suffix) => `compositors/bvm-compositor-${suffix}.env`),
    "compositors/bvm-compositor-spare.env"
  ];
  const files = {};
  for (const name of names) {
    const body = `${name}\n`;
    await writeFile(join(root, name), body, { mode: 0o600 });
    files[name] = createHash("sha256").update(body).digest("hex");
  }
  await writeFile(join(root, "RENDER_COMPLETE.json"), `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, { mode: 0o600 });

  const marker = await verifyProtectedSecretDirectory(root);
  assert.equal(Object.keys(marker.files).length, names.length);

  await writeFile(join(root, names[0]), "tampered\n", { mode: 0o600 });
  await assert.rejects(() => verifyProtectedSecretDirectory(root), /failed integrity verification/);

  delete files[names.at(-1)];
  await writeFile(join(root, "RENDER_COMPLETE.json"), `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(() => verifyProtectedSecretDirectory(root), /missing a required deployment file/);
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
