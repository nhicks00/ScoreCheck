import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertRehearsalGitIdentity, createEventBundle, parseBundleArgs } from "./create-event-bundle.mjs";

const createFixtureBundle = (options) => createEventBundle(options, { verifyGitIdentity: async () => {} });

async function fixture(kind = "rehearsal") {
  const parent = await mkdtemp(join(tmpdir(), "scorecheck-bundle-"));
  await chmod(parent, 0o700);
  const protectedFiles = {};
  for (const name of ["provider.env", "ssh-key", "attestation.json", "anchors.json"]) {
    protectedFiles[name] = join(parent, name);
    await writeFile(protectedFiles[name], name === "anchors.json" ? `${JSON.stringify({
      schemaVersion: 2,
      provider: "digitalocean",
      region: "sfo2",
      retention: "persistent",
      reservedIpv4: {
        commentary: "192.0.2.10",
        ingest: "192.0.2.11"
      }
    }, null, 2)}\n` : "test\n", { mode: 0o600 });
  }
  for (const name of ["ffmpeg", "lk"]) {
    protectedFiles[name] = join(parent, name);
    await writeFile(protectedFiles[name], "#!/bin/sh\n", { mode: 0o700 });
  }
  const network = JSON.parse(await readFile(new URL("./network-contract.json", import.meta.url), "utf8"));
  for (const firewall of network.firewalls) {
    const ssh = firewall.inboundRules.find((rule) => rule.protocol === "tcp" && rule.ports === "22" && rule.sources.addresses);
    ssh.sources.addresses = ["1.1.1.1/32"];
  }
  protectedFiles["network.json"] = join(parent, "network.json");
  await writeFile(protectedFiles["network.json"], `${JSON.stringify(network, null, 2)}\n`, { mode: 0o600 });
  const productionSource = kind === "production" ? await productionSourceFixture(parent) : null;
  return {
    command: "create",
    event: `bundle-${kind}`,
    kind,
    destroyAfter: "2026-08-01",
    root: join(parent, "event"),
    credentialsEnv: protectedFiles["provider.env"],
    sshKey: protectedFiles["ssh-key"],
    lifecycleAttestation: protectedFiles["attestation.json"],
    networkSpec: protectedFiles["network.json"],
    ...(kind === "production" ? { anchors: protectedFiles["anchors.json"], productionSource } : {
      gitRepoId: "123",
      gitRef: "codex/turnkey-event-lifecycle",
      gitSha: "a".repeat(40),
      ffmpegPath: protectedFiles.ffmpeg,
      liveKitCliPath: protectedFiles.lk,
      soakDurationSeconds: 1_800
    })
  };
}

test("creates a complete protected rehearsal bundle and exact one-command invocation", async () => {
  const options = await fixture();
  const result = await createFixtureBundle(options);
  const eventProfile = JSON.parse(await readFile(result.eventProfile, "utf8"));
  const rehearsalProfile = JSON.parse(await readFile(result.rehearsalProfile, "utf8"));
  const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
  const binding = JSON.parse(await readFile(eventProfile.anchors, "utf8"));
  assert.equal(manifest.kind, "rehearsal");
  assert.ok(manifest.network.firewalls.every((firewall) => firewall.inboundRules
    .some((rule) => rule.protocol === "tcp" && rule.ports === "22" && rule.sources.addresses?.includes("1.1.1.1/32"))));
  assert.ok(manifest.endpoints.every((entry) => entry.addressMode === "dynamic-ipv4"));
  assert.deepEqual(binding.reservedIpv4, {});
  assert.equal(eventProfile.rehearsalEvidence, rehearsalProfile.rehearsalEvidence);
  assert.equal(result.nextCommand.args.at(-1), `FULL-DRY-RUN:${manifest.event}`);
  assert.equal((await stat(options.root)).mode & 0o077, 0);
  for (const name of ["manifest.json", "event-profile.json", "rehearsal-profile.json", "rehearsal-endpoint-binding.json", "BUNDLE.json"]) {
    assert.equal((await stat(join(options.root, name))).mode & 0o077, 0);
  }
  await assert.rejects(() => createFixtureBundle(options), /already exists/);
});

test("creates a production bundle bound to existing persistent anchors", async () => {
  const options = await fixture("production");
  const result = await createFixtureBundle(options);
  const profile = JSON.parse(await readFile(result.eventProfile, "utf8"));
  assert.equal(result.rehearsalProfile, null);
  assert.equal(profile.anchors, options.anchors);
  assert.equal(profile.rehearsalEvidence, null);
  assert.equal((await stat(profile.secrets)).mode & 0o077, 0);
  assert.equal((await stat(join(profile.secrets, "RENDER_COMPLETE.json"))).mode & 0o077, 0);
});

test("rejects weak input permissions and incomplete mode-specific options", async () => {
  const rehearsal = await fixture();
  await chmod(rehearsal.credentialsEnv, 0o644);
  await assert.rejects(() => createFixtureBundle(rehearsal), /protected file/);
  const production = await fixture("production");
  await assert.rejects(() => createFixtureBundle({ ...production, anchors: undefined }), /requires --anchors/);
  await assert.rejects(() => createFixtureBundle({ ...production, productionSource: undefined }), /requires --production-source/);
  await assert.rejects(() => createFixtureBundle({ ...production, networkSpec: undefined }), /networkSpec is required/);
  await writeFile(production.anchors, "{}\n", { mode: 0o600 });
  await assert.rejects(() => createFixtureBundle(production), /schemaVersion must be 2/);
  assert.throws(() => parseBundleArgs(["create", "--root", "relative"]), /absolute path/);
});

test("rejects a protected but nondeployable template network", async () => {
  const options = await fixture();
  const template = await readFile(new URL("./network-contract.json", import.meta.url), "utf8");
  await writeFile(options.networkSpec, template, { mode: 0o600 });
  await assert.rejects(() => createFixtureBundle(options), /public operator host address/u);
});

test("requires the rehearsal SHA to match local and remote branch tips exactly", async () => {
  const sha = "a".repeat(40);
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    return args[0] === "rev-parse" ? `${sha}\n` : `${sha}\trefs/heads/master\n`;
  };
  await assertRehearsalGitIdentity({ ref: "master", sha }, { runGit });
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "--end-of-options", "master^{commit}"],
    ["ls-remote", "--exit-code", "origin", "refs/heads/master"]
  ]);
  await assert.rejects(() => assertRehearsalGitIdentity({ ref: "master", sha: "b".repeat(40) }, { runGit }), /does not match local/);
  await assert.rejects(() => assertRehearsalGitIdentity({ ref: "master", sha }, { runGit: async (args) => args[0] === "rev-parse" ? `${sha}\n` : `${"b".repeat(40)}\trefs\/heads\/master\n` }), /does not match remote/);
});

async function productionSourceFixture(parent) {
  const root = join(parent, "production-source");
  await mkdir(join(root, "wireguard"), { recursive: true, mode: 0o700 });
  const encoding = { width: "1280", height: "720", framerate: "30", videoBitrate: "4000", audioBitrate: "128", audioFrequency: "48000", keyframeInterval: "2" };
  const material = {
    schemaVersion: 1,
    programPageToken: "program-page-token-abcdefghijklmnopqrstuvwxyz",
    commentary: { apiKey: "commentary-key-123", apiSecret: "commentary-secret-abcdefghijklmnopqrstuvwxyz" },
    publishers: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, {
      user: `camera-${index + 1}`,
      password: `publisher-password-${index + 1}-abcdefghijklmnopqrstuvwxyz`,
      source: index < 5 ? "publisher" : `srt://10.89.0.${index + 1}:10${index + 1}?mode=caller`
    }])),
    compositors: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, {
      apiKey: `local-key-${index + 1}-1234567890`,
      apiSecret: `local-secret-${index + 1}-abcdefghijklmnopqrstuvwxyz`,
      rtmpsBase: "rtmps://a.rtmps.youtube.com/live2",
      streamKey: `youtube-key-${index + 1}-abcdefghijk`,
      encoding
    }]))
  };
  const requiredMonitoring = [
    "ALERTMANAGER_WEBHOOK_TOKEN", "HEALTHCHECKS_ACTIVE_CHECK_ID", "HEALTHCHECKS_ACTIVE_PING_URL", "HEALTHCHECKS_API_KEY",
    "HEALTHCHECKS_BASELINE_CHECK_ID", "HEALTHCHECKS_BASELINE_PING_URL", "MONITOR_API_TOKEN", "MONITOR_BROWSER_ALLOWED_ORIGINS",
    "MONITOR_BROWSER_HEARTBEAT_SECRET", "MONITOR_DASHBOARD_URL", "MONITOR_PUBLIC_HOST", "PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"
  ];
  const monitoring = requiredMonitoring.map((name) => `${name}=${JSON.stringify(`${name.toLowerCase()}-abcdefghijklmnopqrstuvwxyz`)}`).join("\n") + "\n";
  const files = {
    "material.json": `${JSON.stringify(material, null, 2)}\n`,
    "monitoring.env": monitoring,
    "web-runtime.env": "PROGRAM_PAGE_TOKEN=\"program-page-token-abcdefghijklmnopqrstuvwxyz\"\n",
    "wireguard/camera-lan.conf": "[Interface]\nAddress = 10.89.0.1/24\nListenPort = 51820\nPrivateKey = protected\n\n[Peer]\nPublicKey = protected\nAllowedIPs = 10.89.0.2/32, 192.168.8.0/24\n",
    "wireguard/camera-lan.key": "protected-private-key\n",
    "wireguard/camera-lan.pub": "protected-public-key\n"
  };
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body, { mode: 0o600 });
  const marker = {
    schemaVersion: 1,
    createdAt: "2026-07-15T00:00:00Z",
    captureSha256: "a".repeat(64),
    files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, createHash("sha256").update(body).digest("hex")]))
  };
  await writeFile(join(root, "SOURCE_COMPLETE.json"), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return root;
}
