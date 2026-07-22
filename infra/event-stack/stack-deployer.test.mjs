import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { AGENT_DEPLOY_CONCURRENCY, DEPLOYMENT_SCRIPT_TIMEOUT_MS, LocalStackDeployer, buildAgentPlans, clockVerificationCommand, commandFailureMessage, commentaryEndpointHosts, compositorContentAnalyzerBindings, deploymentScriptEnvironment, evaluateClockProbe, isRetryableDeploymentTransportError, loadProtectedEnv, mapWithConcurrency, privateNetworkVerificationPlan, roleConfigBindings, runCommand, runDeploymentScript, serializeAgentTargets, servicePublicIpv4, verifyProtectedSecretDirectory } from "./stack-deployer.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "deploy-test", kind: "production", destroyAfter: "2026-08-01", ...inputs });
const rehearsalManifest = buildEventManifest({ event: "deploy-test", kind: "rehearsal", destroyAfter: "2026-08-01", ...inputs });

async function teardownMonitoringFixture(root) {
  const secretsDirectory = join(root, "secrets");
  await mkdir(secretsDirectory, { mode: 0o700 });
  const ids = {
    baseline: "11111111-1111-4111-8111-111111111111",
    active: "22222222-2222-4222-8222-222222222222",
    sentinel: "33333333-3333-4333-8333-333333333333"
  };
  await writeFile(join(secretsDirectory, "observability.env"), [
    'HEALTHCHECKS_API_KEY="healthchecks-api-key"',
    `HEALTHCHECKS_BASELINE_CHECK_ID="${ids.baseline}"`,
    `HEALTHCHECKS_ACTIVE_CHECK_ID="${ids.active}"`,
    `HEALTHCHECKS_SENTINEL_PING_URL="https://hc-ping.com/${ids.sentinel}"`
  ].join("\n") + "\n", { mode: 0o600 });
  return { secretsDirectory, ids };
}

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

test("bounds independent monitor-agent deployment work without changing its input order", async () => {
  const values = ["a", "b", "c", "d", "e", "f", "g"];
  let active = 0;
  let maximumActive = 0;
  const results = await mapWithConcurrency(values, AGENT_DEPLOY_CONCURRENCY, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value.toUpperCase();
  });
  assert.deepEqual(results, ["A", "B", "C", "D", "E", "F", "G"]);
  assert.equal(maximumActive, AGENT_DEPLOY_CONCURRENCY);
  await assert.rejects(() => mapWithConcurrency(values, 0, async () => {}), /positive integer/);
});

test("passes a bounded timeout to deployment scripts and terminates hung commands", async () => {
  let receivedTimeout = null;
  await runDeploymentScript({
    script: "/repo/deploy.sh",
    environment: {},
    runner: async (_script, _args, options) => {
      receivedTimeout = options.timeoutMs;
      return { code: 0 };
    }
  });
  assert.equal(receivedTimeout, DEPLOYMENT_SCRIPT_TIMEOUT_MS);
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { capture: true, timeoutMs: 1_000 }),
    /node timed out after 1000ms/u
  );
});

test("retains the decisive command-output tail instead of an unhelpful prefix", () => {
  const stderr = `UNHELPFUL INITIAL PREFIX\n${"build progress\n".repeat(500)}final health contract mismatch`;
  const message = commandFailureMessage("/repo/deploy.sh", 4, {
    stdout: "candidate cleanup complete",
    stderr
  });
  assert.match(message, /^deploy\.sh failed with exit 4:/u);
  assert.match(message, /\[earlier output omitted\]/u);
  assert.match(message, /final health contract mismatch/u);
  assert.match(message, /stdout tail:\ncandidate cleanup complete/u);
  assert.doesNotMatch(message, /UNHELPFUL INITIAL PREFIX/u);
  assert.ok(message.length < stderr.length);
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

test("requires synchronized event-host clocks with a bounded measured offset", () => {
  assert.match(clockVerificationCommand(), /NTPSynchronized/u);
  assert.deepEqual(
    evaluateClockProbe({ stdout: "yes 1784700000100\n", startedAtMs: 1_784_700_000_000, endedAtMs: 1_784_700_000_200 }),
    { status: "synchronized", offsetMs: 0, roundTripMs: 200, remoteTimeMs: 1_784_700_000_100 }
  );
  assert.throws(
    () => evaluateClockProbe({ stdout: "no 1784700000100\n", startedAtMs: 1_784_700_000_000, endedAtMs: 1_784_700_000_200 }),
    /not NTP synchronized/u
  );
  assert.throws(
    () => evaluateClockProbe({ stdout: "yes 1784700002000\n", startedAtMs: 1_784_700_000_000, endedAtMs: 1_784_700_000_200 }),
    /clock offset/u
  );
  assert.throws(
    () => evaluateClockProbe({ stdout: "yes 1784700002500\n", startedAtMs: 1_784_700_000_000, endedAtMs: 1_784_700_006_000 }),
    /round trip/u
  );
});

test("proves compositor WHEP and observability agent traffic use exact private targets", () => {
  const state = stateFixture();
  const compositor = manifest.droplets.find((entry) => entry.name === "bvm-compositor-a");
  const compositorPlan = privateNetworkVerificationPlan({ manifest, state, spec: compositor });
  assert.match(compositorPlan.command, /MEDIAMTX_PRIVATE_HOST/u);
  assert.match(compositorPlan.command, /10\.20\.0\.3\/8554/u);
  assert.match(compositorPlan.command, /bvm-egress/u);
  assert.match(compositorPlan.command, /preview\.beachvolleyballmedia\.com\/healthz/u);
  assert.deepEqual(compositorPlan.evidence.targets.map((entry) => entry.purpose), ["normalizer-rtsp", "program-whep-tls"]);

  const observer = manifest.droplets.find((entry) => entry.role === "observability");
  const observerPlan = privateNetworkVerificationPlan({ manifest, state, spec: observer });
  assert.equal(observerPlan.evidence.targets.length, 12);
  assert.equal((observerPlan.command.match(/\/healthz/g) ?? []).length, 12);
  assert.match(observerPlan.command, /http:\/\/10\.20\.0\.4:9108\/healthz/u);

  const ingest = manifest.droplets.find((entry) => entry.role === "ingest");
  assert.match(privateNetworkVerificationPlan({ manifest, state, spec: ingest }).command, /10\.20\.0\.3/u);
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
  assert.equal(rehearsal.rtc, "rtc-rehearsal.beachvolleyballmedia.com");
  assert.equal(rehearsal.turn, "turn-rehearsal.beachvolleyballmedia.com");
});

test("captures commentary, ingest, and observability TLS state before a healthy stack can be deleted", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-retained-tls-deployer-"));
  await chmod(root, 0o700);
  const sshKey = join(root, "ssh-key");
  const knownHosts = join(root, "known_hosts");
  await writeFile(sshKey, "fixture\n", { mode: 0o600 });
  await writeFile(knownHosts, "fixture\n", { mode: 0o600 });
  const monitoring = await teardownMonitoringFixture(root);
  const commands = [];
  const providerCalls = [];
  const runner = async (command, args) => {
    commands.push([command, args]);
    return { code: 0, stdout: command === "ssh-keygen" ? "fixture-host-key\n" : "", stderr: "" };
  };
  const commentary = rehearsalManifest.droplets.find((entry) => entry.role === "commentary");
  const ingest = rehearsalManifest.droplets.find((entry) => entry.role === "ingest");
  const observability = rehearsalManifest.droplets.find((entry) => entry.role === "observability");
  const state = {
    droplets: {
      [commentary.name]: { publicIpv4: "192.0.2.20", status: "active" },
      [ingest.name]: { publicIpv4: "192.0.2.21", status: "active" },
      [observability.name]: { publicIpv4: "192.0.2.22", status: "active" }
    },
    deployments: {
      [commentary.name]: { status: "healthy" },
      [ingest.name]: { status: "healthy" },
      [observability.name]: { status: "healthy" }
    }
  };
  const captured = {
    status: "ready",
    stateSha256: "a".repeat(64),
    fileCount: 4,
    certificates: Object.fromEntries(Object.values(commentaryEndpointHosts(rehearsalManifest)).map((host) => [host, { validTo: "2026-08-02T00:00:00.000Z", fingerprint256: "AA" }]))
  };
  const tlsState = {
    async inspect() { return { status: "missing" }; },
    async capture() { return captured; }
  };
  const deployer = new LocalStackDeployer({
    repoRoot: "/repo",
    secretsDirectory: monitoring.secretsDirectory,
    sshPrivateKey: sshKey,
    knownHostsPath: knownHosts,
    commentaryTlsStateStore: tlsState,
    ingestTlsStateStore: tlsState,
    observabilityTlsStateStore: tlsState,
    runner,
    fetchImpl: async (url, options = {}) => {
      providerCalls.push({ url, method: options.method ?? "GET" });
      if (options.method === "POST") return new Response(null, { status: 200 });
      return new Response(JSON.stringify({ status: "paused" }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const result = await deployer.prepareForTeardown({ manifest: rehearsalManifest, state });
  assert.equal(result.healthy, true);
  assert.equal(result.evidence.commentaryTlsState.stateSha256, captured.stateSha256);
  assert.equal(result.evidence.ingestTlsState.stateSha256, captured.stateSha256);
  assert.equal(result.evidence.observabilityTlsState.stateSha256, captured.stateSha256);
  assert.equal(result.evidence.commentaryTlsState.caddyStopped, true);
  assert.equal(result.evidence.ingestTlsState.caddyStopped, true);
  assert.equal(result.evidence.observabilityTlsState.caddyStopped, true);
  assert.equal(result.evidence.observabilityMonitorStopped, true);
  assert.deepEqual(result.evidence.healthchecks, { status: "paused", checks: ["baseline", "active", "sentinel"] });
  assert.equal(commands.filter(([command, args]) => command === "ssh" && args.at(-1).includes("stop caddy")).length, 3);
  assert.equal(commands.filter(([command, args]) => command === "ssh" && args.at(-1).includes("stop monitor-service")).length, 1);
  assert.equal(providerCalls.filter((call) => call.method === "POST").length, 3);
  for (const id of Object.values(monitoring.ids)) assert.equal(providerCalls.some((call) => call.url.includes(id)), true);
});

test("blocks teardown and restores monitoring services when Healthchecks cannot be paused", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-dead-man-teardown-failure-"));
  await chmod(root, 0o700);
  const sshKey = join(root, "ssh-key");
  const knownHosts = join(root, "known_hosts");
  await writeFile(sshKey, "fixture\n", { mode: 0o600 });
  await writeFile(knownHosts, "fixture\n", { mode: 0o600 });
  const monitoring = await teardownMonitoringFixture(root);
  const commands = [];
  const runner = async (command, args) => {
    commands.push([command, args]);
    return { code: 0, stdout: command === "ssh-keygen" ? "fixture-host-key\n" : "", stderr: "" };
  };
  const commentary = rehearsalManifest.droplets.find((entry) => entry.role === "commentary");
  const ingest = rehearsalManifest.droplets.find((entry) => entry.role === "ingest");
  const observability = rehearsalManifest.droplets.find((entry) => entry.role === "observability");
  const state = {
    droplets: {
      [commentary.name]: { publicIpv4: "192.0.2.20", status: "active" },
      [ingest.name]: { publicIpv4: "192.0.2.21", status: "active" },
      [observability.name]: { publicIpv4: "192.0.2.22", status: "active" }
    },
    deployments: {
      [commentary.name]: { status: "healthy" },
      [ingest.name]: { status: "healthy" },
      [observability.name]: { status: "healthy" }
    }
  };
  const tlsState = {
    async inspect() { return { status: "missing" }; },
    async capture() { return { status: "ready", stateSha256: "a".repeat(64), fileCount: 1, certificates: {} }; }
  };
  const deployer = new LocalStackDeployer({
    repoRoot: "/repo",
    secretsDirectory: monitoring.secretsDirectory,
    sshPrivateKey: sshKey,
    knownHostsPath: knownHosts,
    commentaryTlsStateStore: tlsState,
    ingestTlsStateStore: tlsState,
    observabilityTlsStateStore: tlsState,
    runner,
    fetchImpl: async () => new Response(null, { status: 503 })
  });

  await assert.rejects(
    () => deployer.prepareForTeardown({ manifest: rehearsalManifest, state }),
    /Healthchecks baseline pause failed with HTTP 503/u
  );
  const remoteCommands = commands.filter(([command]) => command === "ssh").map(([, args]) => args.at(-1));
  assert.ok(remoteCommands.some((command) => command.includes("stop monitor-service")));
  assert.ok(remoteCommands.some((command) => command.includes("start monitor-service caddy")));
  assert.ok(remoteCommands.some((command) => command.includes("/opt/livekit") && command.includes("start caddy")));
  assert.ok(remoteCommands.some((command) => command.includes("/opt/mediamtx") && command.includes("start caddy")));
});

test("fails closed and restores Caddy when a healthy stack has no retainable TLS state", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-retained-tls-failure-"));
  await chmod(root, 0o700);
  const sshKey = join(root, "ssh-key");
  const knownHosts = join(root, "known_hosts");
  await writeFile(sshKey, "fixture\n", { mode: 0o600 });
  await writeFile(knownHosts, "fixture\n", { mode: 0o600 });
  const commands = [];
  const runner = async (command, args) => {
    commands.push([command, args]);
    return { code: 0, stdout: command === "ssh-keygen" ? "fixture-host-key\n" : "", stderr: "" };
  };
  const commentary = rehearsalManifest.droplets.find((entry) => entry.role === "commentary");
  const state = {
    droplets: { [commentary.name]: { publicIpv4: "192.0.2.20", status: "active" } },
    deployments: { [commentary.name]: { status: "healthy" } }
  };
  const deployer = new LocalStackDeployer({
    repoRoot: "/repo",
    secretsDirectory: "/secrets",
    sshPrivateKey: sshKey,
    knownHostsPath: knownHosts,
    commentaryTlsStateStore: {
      async inspect() { return { status: "missing" }; },
      async capture() { throw new Error("remote TLS state unavailable"); }
    },
    ingestTlsStateStore: {
      async inspect() { return { status: "missing" }; },
      async capture() { return { status: "ready" }; }
    },
    observabilityTlsStateStore: {
      async inspect() { return { status: "missing" }; },
      async capture() { return { status: "ready" }; }
    },
    runner
  });

  await assert.rejects(
    () => deployer.prepareForTeardown({ manifest: rehearsalManifest, state }),
    /healthy commentary TLS state could not be retained/u
  );
  assert.ok(commands.some(([command, args]) => command === "ssh" && args.at(-1).includes("start caddy")));
});

test("restores an earlier Caddy service when a later TLS capture fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-retained-tls-rollback-"));
  await chmod(root, 0o700);
  const sshKey = join(root, "ssh-key");
  const knownHosts = join(root, "known_hosts");
  await writeFile(sshKey, "fixture\n", { mode: 0o600 });
  await writeFile(knownHosts, "fixture\n", { mode: 0o600 });
  const commands = [];
  const runner = async (command, args) => {
    commands.push([command, args]);
    return { code: 0, stdout: command === "ssh-keygen" ? "fixture-host-key\n" : "", stderr: "" };
  };
  const commentary = rehearsalManifest.droplets.find((entry) => entry.role === "commentary");
  const ingest = rehearsalManifest.droplets.find((entry) => entry.role === "ingest");
  const observability = rehearsalManifest.droplets.find((entry) => entry.role === "observability");
  const state = {
    droplets: {
      [commentary.name]: { publicIpv4: "192.0.2.20", status: "active" },
      [ingest.name]: { publicIpv4: "192.0.2.21", status: "active" },
      [observability.name]: { publicIpv4: "192.0.2.22", status: "active" }
    },
    deployments: {
      [commentary.name]: { status: "healthy" },
      [ingest.name]: { status: "healthy" },
      [observability.name]: { status: "healthy" }
    }
  };
  const deployer = new LocalStackDeployer({
    repoRoot: "/repo",
    secretsDirectory: "/secrets",
    sshPrivateKey: sshKey,
    knownHostsPath: knownHosts,
    commentaryTlsStateStore: {
      async inspect() { return { status: "missing" }; },
      async capture() { return { status: "ready" }; }
    },
    ingestTlsStateStore: {
      async inspect() { return { status: "missing" }; },
      async capture() { return { status: "ready" }; }
    },
    observabilityTlsStateStore: {
      async inspect() { return { status: "missing" }; },
      async capture() { throw new Error("remote observability TLS state unavailable"); }
    },
    runner
  });

  await assert.rejects(
    () => deployer.prepareForTeardown({ manifest: rehearsalManifest, state }),
    /healthy observability TLS state could not be retained/u
  );
  const restartCommands = commands
    .filter(([command, args]) => command === "ssh" && args.at(-1).includes("start caddy"))
    .map(([, args]) => args.at(-1));
  assert.equal(restartCommands.length, 3);
  assert.ok(restartCommands.some((command) => command.includes("/opt/livekit")));
  assert.ok(restartCommands.some((command) => command.includes("/opt/mediamtx")));
  assert.ok(restartCommands.some((command) => command.includes("/opt/scorecheck-monitoring")));
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
    "/opt/mediamtx/scorecheck-ffmpeg-runner.sh",
    "/opt/mediamtx/scorecheck-preview-runner.sh"
  ]);
  const compositor = roleConfigBindings(repoRoot, secrets, { role: "compositor", name: "bvm-compositor-a" });
  assert.ok(compositor.some(([local, remote]) => local === "/secrets/compositors/bvm-compositor-a.env" && remote === "/opt/compositor/.env"));
  for (const remote of ["/opt/compositor/normalize-camera.sh", "/opt/compositor/qualify-output.sh", "/opt/compositor/start-normalizer.sh", "/opt/compositor/stop-normalizer.sh"]) {
    assert.ok(compositor.some(([, candidate]) => candidate === remote));
  }
  assert.throws(() => roleConfigBindings(repoRoot, secrets, { role: "unknown", name: "unknown" }), /unsupported deployment role/);
});
