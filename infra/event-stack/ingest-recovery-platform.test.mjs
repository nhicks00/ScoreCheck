import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { LocalIngestRecoveryPlatform, asMediamtxAgent, ownerForRestart } from "./ingest-recovery-platform.mjs";

test("requires the retained ingest Reserved IPv4 as an explicit protected input", () => {
  const inputs = fixture();
  assert.throws(() => platform({ ...inputs, anchors: { reservedIpv4: {} } }), /retained ingest Reserved IPv4/u);
});

test("revalidates protected runtime inputs before a resumed recovery command", async () => {
  const inputs = fixture();
  const protectedInputs = await createProtectedInputs(inputs.manifest);
  const instance = platform({ ...inputs, ...protectedInputs });
  await instance.assertProtectedInputs();
  await chmod(protectedInputs.sshPrivateKey, 0o644);
  await assert.rejects(() => instance.assertProtectedInputs(), /SSH private key must be a protected regular file/u);
});

test("hard-cuts the spare monitor agent to an exact MediaMTX-only environment", () => {
  const plan = asMediamtxAgent({
    id: "bvm-compositor-spare",
    role: "worker",
    token: "token-abcdefghijklmnopqrstuvwxyz",
    courts: "",
    publicIpv4: "203.0.113.22",
    privateIpv4: "10.120.0.22",
    environment: {
      MONITOR_AGENT_ROLE: "worker",
      EGRESS_METRICS_URL: "http://127.0.0.1:9090/metrics",
      MONITOR_CONTENT_ANALYZER_COURTS: "8"
    }
  });
  assert.equal(plan.role, "mediamtx");
  assert.equal(plan.environment.MONITOR_AGENT_ROLE, "mediamtx");
  assert.equal(plan.environment.MONITOR_AGENT_COURTS, "");
  assert.equal(plan.environment.MONITOR_AGENT_CONTAINERS, "mediamtx");
  assert.equal(plan.environment.MEDIAMTX_API_URL, "http://127.0.0.1:9997");
  assert.equal(plan.environment.EGRESS_METRICS_URL, "");
  assert.equal(plan.environment.MONITOR_CONTENT_ANALYZER_COURTS, "");
  assert.equal(plan.environment.MONITOR_AGENT_INTERVAL_MS, "5000");
});

test("stages retained TLS, stopped WireGuard, and stopped MediaMTX on the spare", async () => {
  const inputs = fixture();
  const protectedInputs = await createProtectedInputs(inputs.manifest);
  const scripts = [];
  const commands = [];
  const instance = platform({
    ...inputs,
    ...protectedInputs,
    runner: async (command, args) => { commands.push({ command, args }); return { code: 0, stdout: "", stderr: "" }; },
    scriptRunner: async (input) => { scripts.push(input); return { code: 0 }; },
    ingestTlsStateStore: {
      restore: async ({ publicIpv4, hosts }) => {
        assert.equal(publicIpv4, inputs.spare.publicIpv4);
        assert.deepEqual(hosts, ["ingest.beachvolleyballmedia.com"]);
        return { status: "restored", stateSha256: "a".repeat(64) };
      }
    }
  });
  const result = await instance.stageSpareIngest(inputs.topology);
  assert.deepEqual(result, { status: "staged", tlsStateSha256: "a".repeat(64) });
  assert.equal(scripts.length, 2);
  assert.equal(scripts[0].environment.MEDIAMTX_WIREGUARD_MODE, "staged");
  assert.equal(scripts[1].environment.MEDIAMTX_DEPLOY_MODE, "staged");
  assert.equal(scripts[1].environment.MEDIAMTX_PUBLIC_IP, inputs.anchors.reservedIpv4.ingest);
  assert.equal(JSON.parse(scripts[1].environment.MEDIAMTX_CONTENT_ANALYZER_BINDINGS).length, 8);
  assert.match(commands.at(-1).args.at(-1), /status-staged/u);
});

test("moves only the exact firewall tag and preserves immutable output ownership during rebind", async () => {
  const inputs = fixture();
  const calls = [];
  const generation = outputOwner(1);
  const instance = platform({
    ...inputs,
    runner: async (command, args) => { calls.push({ type: command, args }); return { code: 0, stdout: "", stderr: "" }; },
    cloud: {
      attachTagToDroplet: async (...args) => calls.push({ type: "attach", args }),
      detachTagFromDroplet: async (...args) => calls.push({ type: "detach", args })
    },
    egressRuntime: {
      listActive: async () => [{ id: generation.egressId }],
      stopExact: async (input) => calls.push({ type: "stop", input }),
      ensureStarted: async (input) => { calls.push({ type: "start", input }); return { id: "EG_restarted1" }; }
    }
  });
  await instance.attachIngestNetworkPolicy(inputs.spare);
  await instance.rebindCompositorIngress({
    compositor: inputs.topology.compositors[0],
    generation,
    fromPrivateIpv4: inputs.primary.privateIpv4,
    toPrivateIpv4: inputs.spare.privateIpv4
  });
  await instance.resumeOutputGeneration({ compositor: inputs.topology.compositors[0], generation });
  await instance.detachIngestNetworkPolicy(inputs.spare);

  assert.deepEqual(calls.find((entry) => entry.type === "attach").args, ["bvm-preview-01", inputs.spare.dropletId]);
  assert.deepEqual(calls.find((entry) => entry.type === "detach").args, ["bvm-preview-01", inputs.spare.dropletId]);
  assert.deepEqual(calls.find((entry) => entry.type === "stop").input.owner, ownerForRestart(generation));
  assert.deepEqual(calls.find((entry) => entry.type === "start").input.owner, ownerForRestart(generation));
  assert.match(
    calls.find((entry) => entry.type === "ssh" && entry.args.at(-1).includes("rebind-ingest.sh")).args.at(-1),
    new RegExp(`${inputs.primary.privateIpv4} ${inputs.spare.privateIpv4} ingest\\.beachvolleyballmedia\\.com`, "u")
  );
});

test("distinguishes failed-primary health from a reconciled endpoint already moved to the spare", async () => {
  const inputs = fixture();
  const locallyHealthy = platform({
    ...inputs,
    runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    cloud: { getReservedIpv4: async () => ({ dropletId: inputs.primary.dropletId, locked: false }) },
    fetchImpl: async () => ({ ok: false })
  });
  await assert.rejects(() => locallyHealthy.assertPrimaryIngestFailed(inputs.primary), /remains locally healthy/u);

  const failedPrimary = platform({
    ...inputs,
    runner: async () => { throw new Error("ssh failed with exit 255: Connection refused"); },
    cloud: { getReservedIpv4: async () => ({ dropletId: inputs.primary.dropletId, locked: false }) },
    fetchImpl: async () => ({ ok: false })
  });
  await failedPrimary.assertPrimaryIngestFailed(inputs.primary);

  let movedProbeCount = 0;
  const moved = platform({
    ...inputs,
    runner: async () => { movedProbeCount += 1; return { code: 0, stdout: "", stderr: "" }; },
    cloud: { getReservedIpv4: async () => ({ dropletId: inputs.spare.dropletId, locked: false }) },
    fetchImpl: async () => ({ ok: true })
  });
  await assert.rejects(() => moved.assertPrimaryIngestFailed(inputs.primary), /moved before the takeover/u);
  await moved.assertPrimaryIngestFailed(inputs.primary, { allowReservedOnSpare: true });
  assert.equal(movedProbeCount, 0);

  const badCredential = platform({
    ...inputs,
    runner: async () => { throw new Error("ssh failed with exit 255: Permission denied (publickey)"); },
    cloud: { getReservedIpv4: async () => ({ dropletId: inputs.primary.dropletId, locked: false }) },
    fetchImpl: async () => ({ ok: false })
  });
  await assert.rejects(() => badCredential.assertPrimaryIngestFailed(inputs.primary), /could not be verified/u);
});

test("switches monitoring to one MediaMTX agent while excluding the failed primary", async () => {
  const inputs = fixture();
  const protectedInputs = await createProtectedInputs(inputs.manifest);
  const scripts = [];
  const copiedTargets = [];
  const copiedPrometheus = [];
  const runner = async (command, args) => {
    if (command === "rsync") {
      const source = args.at(-2);
      if (basename(source) === "targets.txt") copiedTargets.push(await readFile(source, "utf8"));
      if (basename(source) === "prometheus.yml") copiedPrometheus.push(await readFile(source, "utf8"));
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/v1/snapshot")) return response({
      agents: [{ agentId: inputs.spare.name, role: "mediamtx", state: "HEALTHY", ageMs: 1 }]
    });
    return response({ ok: true });
  };
  const instance = platform({
    ...inputs,
    ...protectedInputs,
    runner,
    scriptRunner: async (input) => { scripts.push(input); return { code: 0 }; },
    fetchImpl
  });
  await instance.switchIngestMonitoring({ from: inputs.primary, to: inputs.spare });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].environment.MONITOR_AGENT_ROLE, "mediamtx");
  assert.equal(copiedTargets.length, 1);
  assert.equal(copiedPrometheus.length, 1);
  assert.equal(copiedTargets[0].split(",").length, 11);
  assert.equal(copiedTargets[0].includes(`${inputs.primary.name}|`), false);
  assert.match(copiedTargets[0], new RegExp(`${inputs.spare.name}\\|mediamtx\\|http://${inputs.spare.privateIpv4}:9108`, "u"));
  assert.doesNotMatch(copiedPrometheus[0], new RegExp(`agent-${inputs.primary.name}`, "u"));
  assert.match(copiedPrometheus[0], new RegExp(`agent-${inputs.spare.name}`, "u"));
  assert.match(copiedPrometheus[0], /credentials: "token-11-abcdefghijklmnopqrstuvwxyz"/u);
});

function platform(overrides = {}) {
  const base = fixture();
  return new LocalIngestRecoveryPlatform({
    repoRoot: "/repo",
    manifest: base.manifest,
    lifecycleState: base.lifecycleState,
    anchors: base.anchors,
    secretsDirectory: "/protected/secrets",
    sshPrivateKey: "/protected/ssh-key",
    knownHostsPath: "/protected/known-hosts",
    ingestTlsStateDirectory: "/protected/tls",
    acmeEmail: "ops@example.com",
    cloud: {},
    runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    scriptRunner: async () => ({ code: 0 }),
    fetchImpl: async () => response({}),
    sleep: async () => {},
    egressRuntime: {
      preflight: async () => ({ healthy: true, active: 0 }),
      listActive: async () => [],
      readOwnership: async () => outputOwner(1),
      reconcileOwned: async () => ({}),
      stopExact: async () => ({}),
      ensureStarted: async () => ({})
    },
    ingestTlsStateStore: { restore: async () => ({ status: "restored", stateSha256: "a".repeat(64) }) },
    ...overrides
  });
}

function fixture() {
  const service = (name, role, extra = {}) => ({ name, providerName: `event-${name}`, role, ...extra });
  const droplets = [
    service("bvm-commentary-01", "commentary", { tag: "bvm-commentary" }),
    service("bvm-observability-01", "observability", { tag: "bvm-observability" }),
    service("bvm-preview-01", "ingest", { tag: "bvm-preview-01" }),
    ...Array.from({ length: 8 }, (_, index) => service(`bvm-compositor-${String.fromCharCode(97 + index)}`, "compositor", { court: index + 1 })),
    service("bvm-compositor-spare", "compositor-spare", { warmSpare: true })
  ];
  const resources = Object.fromEntries(droplets.map((entry, index) => [entry.name, {
    id: String(101 + index),
    status: "active",
    publicIpv4: `203.0.113.${10 + index}`,
    privateIpv4: `10.120.0.${10 + index}`
  }]));
  const manifest = {
    schemaVersion: 6,
    kind: "production",
    event: "recovery-event",
    provider: { vpcCidr: "10.120.0.0/20" },
    endpoints: [
      { role: "ingest", hostname: "ingest.beachvolleyballmedia.com" },
      { role: "observability", hostname: "monitor.beachvolleyballmedia.com" }
    ],
    droplets
  };
  const lifecycleState = { event: "recovery-event", phase: "live", droplets: resources };
  const anchors = { reservedIpv4: { ingest: "198.51.100.20", commentary: "198.51.100.21" } };
  const primary = { ...resources["bvm-preview-01"], name: "bvm-preview-01", dropletId: resources["bvm-preview-01"].id };
  const spare = { ...resources["bvm-compositor-spare"], name: "bvm-compositor-spare", dropletId: resources["bvm-compositor-spare"].id };
  const observability = { ...resources["bvm-observability-01"], name: "bvm-observability-01", dropletId: resources["bvm-observability-01"].id };
  const compositors = Array.from({ length: 8 }, (_, index) => {
    const name = `bvm-compositor-${String.fromCharCode(97 + index)}`;
    return { ...resources[name], name, dropletId: resources[name].id, cameraNumber: index + 1 };
  });
  return {
    manifest,
    lifecycleState,
    anchors,
    primary,
    spare,
    topology: {
      primary,
      spare,
      observability,
      compositors,
      reservedIpv4: anchors.reservedIpv4.ingest,
      ingestHostname: "ingest.beachvolleyballmedia.com",
      vpcCidr: "10.120.0.0/20",
      ingestFirewallTag: "bvm-preview-01"
    }
  };
}

async function createProtectedInputs(manifest) {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-ingest-platform-"));
  await chmod(root, 0o700);
  const secretsDirectory = join(root, "secrets");
  const ingestTlsStateDirectory = join(root, "tls");
  await mkdir(join(secretsDirectory, "wireguard"), { recursive: true, mode: 0o700 });
  await mkdir(join(secretsDirectory, "compositors"), { recursive: true, mode: 0o700 });
  await mkdir(ingestTlsStateDirectory, { mode: 0o700 });
  const sshPrivateKey = join(root, "ssh-key");
  const knownHostsPath = join(root, "known-hosts");
  await writeFile(sshPrivateKey, "test-key\n", { mode: 0o600 });
  await writeFile(knownHostsPath, "test-host\n", { mode: 0o600 });
  await writeFile(join(secretsDirectory, "wireguard/camera-lan.conf"), "[Interface]\n", { mode: 0o600 });
  const tokenConfig = {
    schemaVersion: 1,
    tokens: Object.fromEntries(manifest.droplets.map((entry, index) => [entry.name, `token-${index}-abcdefghijklmnopqrstuvwxyz`]))
  };
  const bodies = {
    "agent-tokens.json": `${JSON.stringify(tokenConfig)}\n`,
    "commentary.env": "COMMENTARY_TEST=1\n",
    "ingest.env": "INGEST_TEST=1\n",
    "observability.env": "MONITOR_API_TOKEN=monitor-test-token\n",
    ...Object.fromEntries([..."abcdefgh"].map((suffix) => [`compositors/bvm-compositor-${suffix}.env`, "COMPOSITOR_TEST=1\n"])),
    "compositors/bvm-compositor-spare.env": "COMPOSITOR_TEST=1\n"
  };
  const files = {};
  for (const [name, body] of Object.entries(bodies)) {
    const path = join(secretsDirectory, name);
    await writeFile(path, body, { mode: 0o600 });
    files[name] = createHash("sha256").update(body).digest("hex");
  }
  await writeFile(join(secretsDirectory, "RENDER_COMPLETE.json"), `${JSON.stringify({ schemaVersion: 1, files })}\n`, { mode: 0o600 });
  return { secretsDirectory, sshPrivateKey, knownHostsPath, ingestTlsStateDirectory };
}

function outputOwner(camera) {
  return {
    schemaVersion: 1,
    event: "recovery-event",
    court: camera,
    destinationId: `broadcast-${camera}`,
    outputGeneration: `generation-${camera}`,
    outputProfile: "1080p30",
    rendererGitSha: "a".repeat(40),
    rendererDeploymentId: "dpl_test123",
    egressId: `EG_test${camera}`,
    requestSha256: "b".repeat(64),
    startedAt: "2026-07-21T11:59:00.000Z"
  };
}

function response(body) {
  return { ok: true, json: async () => body };
}
