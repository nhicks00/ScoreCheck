import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  issueLifecycleAttestation,
  LIFECYCLE_ATTESTATION_VALIDITY_MS,
  LIFECYCLE_CANARY_CAPABILITIES,
  verifyLifecycleAttestation
} from "./lifecycle-attestation.mjs";

const DIGITALOCEAN_TOKEN = "dop_v1_test_full_lifecycle_token";
const VERCEL_TOKEN = "vercel_test_dns_token";
const TEAM_ID = "team_test";
const SSH_KEYS = ["57633065"];
const ISSUED_AT = new Date("2026-07-15T01:00:00.000Z");

test("issues a protected token-, account-, DNS-, and SSH-bound PASS attestation", async () => {
  const setup = await fixture();
  const issued = await setup.issue();

  assert.equal((await stat(setup.attestationPath)).mode & 0o777, 0o600);
  assert.equal(issued.accountUuid, "account-uuid");
  assert.deepEqual(issued.capabilities, LIFECYCLE_CANARY_CAPABILITIES);
  assert.equal(new Date(issued.expiresAt).getTime() - new Date(issued.issuedAt).getTime(), LIFECYCLE_ATTESTATION_VALIDITY_MS);

  const verified = await setup.verify({ now: () => new Date("2026-07-16T01:00:00.000Z") });
  assert.equal(verified.canaryRunId, "20260715pass");
  assert.equal(verified.expiresAt, issued.expiresAt);
});

test("rejects replaced provider, team, SSH identity, and account before provisioning", async () => {
  const setup = await fixture();
  await setup.issue();

  await assert.rejects(() => setup.verify({ digitalOceanToken: "replacement-do-token" }), /signature does not match/);
  await assert.rejects(() => setup.verify({ vercelToken: "replacement-vercel-token" }), /provider or SSH credentials/);
  await assert.rejects(() => setup.verify({ vercelTeamId: "different-team" }), /provider or SSH credentials/);
  await assert.rejects(() => setup.verify({ digitalOceanSshKeys: ["other-key"] }), /provider or SSH credentials/);
  await assert.rejects(() => setup.verify({ account: { uuid: "different-account", status: "active" } }), /different DigitalOcean account/);
  await assert.rejects(() => setup.verify({ expectedRegion: "nyc3" }), /event region or DNS zone/);

  await writeFile(setup.sshPrivateKeyPath, "different-private-key\n", { mode: 0o600 });
  await assert.rejects(() => setup.verify(), /provider or SSH credentials/);
});

test("rejects expired, tampered, and obsolete capability attestations", async () => {
  const setup = await fixture();
  await setup.issue();
  const afterExpiry = new Date(ISSUED_AT.getTime() + LIFECYCLE_ATTESTATION_VALIDITY_MS + 1);
  await assert.rejects(() => setup.verify({ now: () => afterExpiry }), /has expired/);

  const tampered = JSON.parse(await readFile(setup.attestationPath, "utf8"));
  tampered.capabilities = tampered.capabilities.slice(0, -1);
  await writeFile(setup.attestationPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(() => setup.verify(), /capability contract is obsolete/);
});

test("does not attest failed, incomplete, or pre-account-identity evidence", async () => {
  const setup = await fixture();
  const evidence = JSON.parse(await readFile(setup.evidencePath, "utf8"));
  evidence.classification = "FAIL";
  evidence.phase = "cleaned-after-failure";
  evidence.failure = "injected failure";
  await writeFile(setup.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(() => setup.issue(), /not a clean PASS/);
  await assert.rejects(() => access(setup.attestationPath));

  evidence.classification = "PASS";
  evidence.phase = "cleaned";
  evidence.failure = null;
  delete evidence.baseline.accountUuid;
  await writeFile(setup.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(() => setup.issue(), /missing the DigitalOcean account UUID/);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-lifecycle-attestation-"));
  await chmod(root, 0o700);
  const evidencePath = join(root, "canary-evidence.json");
  const attestationPath = join(root, "lifecycle-attestation.json");
  const sshPrivateKeyPath = join(root, "scorecheck_do");
  await writeFile(evidencePath, `${JSON.stringify(passingEvidence(), null, 2)}\n`, { mode: 0o600 });
  await writeFile(sshPrivateKeyPath, "test-private-key\n", { mode: 0o600 });

  const defaults = {
    path: attestationPath,
    digitalOceanToken: DIGITALOCEAN_TOKEN,
    vercelToken: VERCEL_TOKEN,
    vercelTeamId: TEAM_ID,
    digitalOceanSshKeys: SSH_KEYS,
    sshPrivateKeyPath,
    expectedRegion: "sfo2",
    expectedDnsZone: "beachvolleyballmedia.com",
    now: () => ISSUED_AT
  };
  return {
    evidencePath,
    attestationPath,
    sshPrivateKeyPath,
    issue: (overrides = {}) => issueLifecycleAttestation({ ...defaults, evidencePath, ...overrides }),
    verify: (overrides = {}) => verifyLifecycleAttestation({
      ...defaults,
      account: { uuid: "account-uuid", status: "active" },
      now: () => new Date("2026-07-16T01:00:00.000Z"),
      ...overrides
    })
  };
}

function passingEvidence() {
  const checks = ["original-created", "resize-down", "resize-up", "replacement-created"]
    .map((name) => ({ name, status: "PASS" }));
  const cleanup = Object.fromEntries(["dns", "replacement", "original", "reservedIpv4", "snapshot", "tag", "inventory"]
    .map((name) => [name, { status: "done", at: "2026-07-15T00:59:00.000Z" }]));
  return {
    schemaVersion: 2,
    runId: "20260715pass",
    phase: "cleaned",
    classification: "PASS",
    failure: null,
    cleanupFailure: null,
    baseline: { accountUuid: "account-uuid", dropletIds: ["10", "11"] },
    identity: {
      name: "scorecheck-lifecycle-canary-20260715pass",
      tag: "scorecheck-lifecycle-canary:20260715pass",
      snapshotName: "scorecheck-lifecycle-canary-20260715pass",
      hostname: "lifecycle-20260715pass.beachvolleyballmedia.com",
      zone: "beachvolleyballmedia.com",
      region: "sfo2",
      size: "c-4",
      resizeDownSize: "c-2",
      baseImage: "ubuntu-24-04-x64",
      cloudInitSha256: "a".repeat(64)
    },
    original: { id: "100" },
    replacement: { id: "101" },
    checks,
    cleanup,
    timeline: [{ at: "2026-07-15T00:59:00.000Z", event: "cleanup-proved", details: {} }],
    completedAt: "2026-07-15T00:59:00.000Z"
  };
}
