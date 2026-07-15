import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEventBundle, parseBundleArgs } from "./create-event-bundle.mjs";

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
  return {
    command: "create",
    event: `bundle-${kind}`,
    kind,
    destroyAfter: "2026-08-01",
    root: join(parent, "event"),
    credentialsEnv: protectedFiles["provider.env"],
    sshKey: protectedFiles["ssh-key"],
    lifecycleAttestation: protectedFiles["attestation.json"],
    ...(kind === "production" ? { anchors: protectedFiles["anchors.json"] } : {
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
  const result = await createEventBundle(options);
  const eventProfile = JSON.parse(await readFile(result.eventProfile, "utf8"));
  const rehearsalProfile = JSON.parse(await readFile(result.rehearsalProfile, "utf8"));
  const manifest = JSON.parse(await readFile(result.manifest, "utf8"));
  const binding = JSON.parse(await readFile(eventProfile.anchors, "utf8"));
  assert.equal(manifest.kind, "rehearsal");
  assert.ok(manifest.endpoints.every((entry) => entry.addressMode === "dynamic-ipv4"));
  assert.deepEqual(binding.reservedIpv4, {});
  assert.equal(eventProfile.rehearsalEvidence, rehearsalProfile.rehearsalEvidence);
  assert.equal(result.nextCommand.args.at(-1), `FULL-DRY-RUN:${manifest.event}`);
  assert.equal((await stat(options.root)).mode & 0o077, 0);
  for (const name of ["manifest.json", "event-profile.json", "rehearsal-profile.json", "rehearsal-endpoint-binding.json", "BUNDLE.json"]) {
    assert.equal((await stat(join(options.root, name))).mode & 0o077, 0);
  }
  await assert.rejects(() => createEventBundle(options), /already exists/);
});

test("creates a production bundle bound to existing persistent anchors", async () => {
  const options = await fixture("production");
  const result = await createEventBundle(options);
  const profile = JSON.parse(await readFile(result.eventProfile, "utf8"));
  assert.equal(result.rehearsalProfile, null);
  assert.equal(profile.anchors, options.anchors);
  assert.equal(profile.rehearsalEvidence, null);
});

test("rejects weak input permissions and incomplete mode-specific options", async () => {
  const rehearsal = await fixture();
  await chmod(rehearsal.credentialsEnv, 0o644);
  await assert.rejects(() => createEventBundle(rehearsal), /protected file/);
  const production = await fixture("production");
  await assert.rejects(() => createEventBundle({ ...production, anchors: undefined }), /requires --anchors/);
  await writeFile(production.anchors, "{}\n", { mode: 0o600 });
  await assert.rejects(() => createEventBundle(production), /schemaVersion must be 2/);
  assert.throws(() => parseBundleArgs(["create", "--root", "relative"]), /absolute path/);
});
