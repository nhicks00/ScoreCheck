#!/usr/bin/env node

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const ATTESTATION_SCHEMA_VERSION = 1;
const VALIDITY_MS = 30 * 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const REQUIRED_CHECKS = ["original-created", "resize-down", "resize-up", "replacement-created"];
const REQUIRED_CLEANUP = ["dns", "replacement", "original", "reservedIpv4", "snapshot", "tag", "inventory"];

export const LIFECYCLE_CANARY_CAPABILITIES = Object.freeze([
  "digitalocean.account.read",
  "digitalocean.droplet.create-read-power-resize-delete",
  "digitalocean.reserved-ipv4.create-read-assign-delete",
  "digitalocean.snapshot.create-read-delete",
  "digitalocean.tag.create-read-delete",
  "vercel.dns.create-read-delete",
  "ssh.cloud-init-health-and-snapshot-recovery",
  "stable-ip-dns-reassignment-and-instance-identity"
]);

export async function issueLifecycleAttestation({
  path,
  evidencePath,
  digitalOceanToken,
  vercelToken,
  vercelTeamId = null,
  digitalOceanSshKeys,
  sshPrivateKeyPath,
  now = () => new Date()
}) {
  const targetPath = protectedAbsolutePath(path, "lifecycle attestation path");
  const canaryPath = protectedAbsolutePath(evidencePath, "canary evidence path");
  const evidenceBytes = await readProtectedBytes(canaryPath, "canary evidence");
  const evidence = parseJson(evidenceBytes, "canary evidence");
  validatePassingEvidence(evidence);
  const credentials = await credentialBindings({
    digitalOceanToken,
    vercelToken,
    vercelTeamId,
    digitalOceanSshKeys,
    sshPrivateKeyPath
  });
  const issuedAt = validNow(now);
  const payload = {
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    provider: "digitalocean+vercel",
    accountUuid: evidence.baseline.accountUuid,
    canaryRunId: evidence.runId,
    canaryIdentity: structuredClone(evidence.identity),
    canaryCompletedAt: evidence.completedAt,
    canaryEvidenceSha256: sha256(evidenceBytes),
    capabilities: [...LIFECYCLE_CANARY_CAPABILITIES],
    credentials,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + VALIDITY_MS).toISOString()
  };
  const attestation = {
    ...payload,
    signature: {
      algorithm: "HMAC-SHA256",
      value: sign(payload, normalizedSecret(digitalOceanToken, "DIGITALOCEAN_TOKEN"))
    }
  };
  await writeProtectedJson(targetPath, attestation);
  return attestationSummary(attestation);
}

export async function verifyLifecycleAttestation({
  path,
  account,
  digitalOceanToken,
  vercelToken,
  vercelTeamId = null,
  digitalOceanSshKeys,
  sshPrivateKeyPath,
  expectedRegion,
  expectedDnsZone,
  now = () => new Date()
}) {
  const attestationPath = protectedAbsolutePath(path, "lifecycle attestation path");
  const bytes = await readProtectedBytes(attestationPath, "lifecycle attestation");
  const value = parseJson(bytes, "lifecycle attestation");
  validateAttestationShape(value);

  const payload = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "signature"));
  const expectedSignature = sign(payload, normalizedSecret(digitalOceanToken, "DIGITALOCEAN_TOKEN"));
  if (!safeHexEqual(value.signature.value, expectedSignature)) {
    throw new Error("lifecycle attestation signature does not match the configured DigitalOcean credential");
  }

  const expectedBindings = await credentialBindings({
    digitalOceanToken,
    vercelToken,
    vercelTeamId,
    digitalOceanSshKeys,
    sshPrivateKeyPath
  });
  if (!deepEqual(value.credentials, expectedBindings)) {
    throw new Error("lifecycle attestation does not match the configured provider or SSH credentials");
  }
  if (!account || account.status !== "active") {
    throw new Error(`DigitalOcean account is ${account?.status ?? "unknown"}, not active`);
  }
  if (typeof account.uuid !== "string" || account.uuid !== value.accountUuid) {
    throw new Error("lifecycle attestation belongs to a different DigitalOcean account");
  }
  if (value.canaryIdentity.region !== expectedRegion || value.canaryIdentity.zone !== expectedDnsZone) {
    throw new Error("lifecycle attestation does not match the event region or DNS zone");
  }

  const checkedAt = validNow(now);
  const issuedAt = parseDate(value.issuedAt, "lifecycle attestation issuedAt");
  const expiresAt = parseDate(value.expiresAt, "lifecycle attestation expiresAt");
  const canaryCompletedAt = parseDate(value.canaryCompletedAt, "lifecycle attestation canaryCompletedAt");
  if (canaryCompletedAt.getTime() > issuedAt.getTime()) throw new Error("lifecycle attestation predates its canary completion");
  if (issuedAt.getTime() > checkedAt.getTime() + CLOCK_SKEW_MS) throw new Error("lifecycle attestation issuedAt is in the future");
  if (expiresAt.getTime() - issuedAt.getTime() !== VALIDITY_MS) throw new Error("lifecycle attestation validity window is invalid");
  if (checkedAt.getTime() >= expiresAt.getTime()) throw new Error("lifecycle attestation has expired; rerun the full lifecycle canary");
  return attestationSummary(value);
}

function validatePassingEvidence(value) {
  if (!value || value.schemaVersion !== 2) throw new Error("canary evidence schemaVersion must be 2");
  if (value.phase !== "cleaned" || value.classification !== "PASS" || value.failure || value.cleanupFailure) {
    throw new Error("canary evidence is not a clean PASS");
  }
  if (typeof value.runId !== "string" || !value.runId) throw new Error("canary evidence runId is invalid");
  parseDate(value.completedAt, "canary evidence completedAt");
  if (typeof value.baseline?.accountUuid !== "string" || !value.baseline.accountUuid) {
    throw new Error("canary evidence is missing the DigitalOcean account UUID");
  }
  const identityKeys = ["name", "tag", "snapshotName", "hostname", "zone", "region", "size", "resizeDownSize", "baseImage", "cloudInitSha256"];
  if (!value.identity || !deepEqual(Object.keys(value.identity).sort(), [...identityKeys].sort())) {
    throw new Error("canary evidence identity contract is invalid");
  }
  for (const key of identityKeys) {
    if (typeof value.identity[key] !== "string" || !value.identity[key]) throw new Error(`canary evidence identity ${key} is invalid`);
  }
  if (!value.original?.id || !value.replacement?.id || String(value.original.id) === String(value.replacement.id)) {
    throw new Error("canary evidence does not prove snapshot replacement with a new Droplet id");
  }
  const checkNames = Array.isArray(value.checks) ? value.checks.map((entry) => entry?.name) : [];
  if (!deepEqual(checkNames, REQUIRED_CHECKS) || value.checks.some((entry) => entry.status !== "PASS")) {
    throw new Error("canary evidence is missing a required endpoint or resize PASS");
  }
  for (const name of REQUIRED_CLEANUP) {
    if (value.cleanup?.[name]?.status !== "done") throw new Error(`canary evidence cleanup ${name} is not done`);
  }
  if (!Array.isArray(value.timeline) || !value.timeline.some((entry) => entry?.event === "cleanup-proved")) {
    throw new Error("canary evidence does not contain final cleanup proof");
  }
}

function validateAttestationShape(value) {
  const expectedKeys = [
    "schemaVersion", "provider", "accountUuid", "canaryRunId", "canaryIdentity", "canaryCompletedAt",
    "canaryEvidenceSha256", "capabilities", "credentials", "issuedAt", "expiresAt", "signature"
  ].sort();
  if (!value || !deepEqual(Object.keys(value).sort(), expectedKeys)) throw new Error("lifecycle attestation fields are invalid");
  if (value.schemaVersion !== ATTESTATION_SCHEMA_VERSION) throw new Error(`lifecycle attestation schemaVersion must be ${ATTESTATION_SCHEMA_VERSION}`);
  if (value.provider !== "digitalocean+vercel") throw new Error("lifecycle attestation provider is invalid");
  for (const key of ["accountUuid", "canaryRunId", "canaryCompletedAt", "issuedAt", "expiresAt"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`lifecycle attestation ${key} is invalid`);
  }
  if (!value.canaryIdentity || typeof value.canaryIdentity.region !== "string" || typeof value.canaryIdentity.zone !== "string") {
    throw new Error("lifecycle attestation canaryIdentity is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(value.canaryEvidenceSha256)) throw new Error("lifecycle attestation evidence digest is invalid");
  if (!deepEqual(value.capabilities, LIFECYCLE_CANARY_CAPABILITIES)) throw new Error("lifecycle attestation capability contract is obsolete");
  const expectedCredentialKeys = ["digitalOceanTokenSha256", "vercelTokenSha256", "vercelTeamId", "digitalOceanSshKeysSha256", "sshPrivateKeySha256"].sort();
  if (!value.credentials || !deepEqual(Object.keys(value.credentials).sort(), expectedCredentialKeys)) {
    throw new Error("lifecycle attestation credential bindings are invalid");
  }
  for (const key of ["digitalOceanTokenSha256", "vercelTokenSha256", "digitalOceanSshKeysSha256", "sshPrivateKeySha256"]) {
    if (!/^[a-f0-9]{64}$/.test(value.credentials[key])) throw new Error(`lifecycle attestation ${key} is invalid`);
  }
  if (value.credentials.vercelTeamId !== null && (typeof value.credentials.vercelTeamId !== "string" || !value.credentials.vercelTeamId)) {
    throw new Error("lifecycle attestation vercelTeamId is invalid");
  }
  if (!value.signature || !deepEqual(Object.keys(value.signature).sort(), ["algorithm", "value"])) {
    throw new Error("lifecycle attestation signature fields are invalid");
  }
  if (value.signature.algorithm !== "HMAC-SHA256" || !/^[a-f0-9]{64}$/.test(value.signature.value)) {
    throw new Error("lifecycle attestation signature is invalid");
  }
}

async function credentialBindings({ digitalOceanToken, vercelToken, vercelTeamId, digitalOceanSshKeys, sshPrivateKeyPath }) {
  const sshKeys = normalizedSshKeys(digitalOceanSshKeys);
  const privateKeyPath = protectedAbsolutePath(sshPrivateKeyPath, "SSH private key path");
  const privateKey = await readProtectedBytes(privateKeyPath, "SSH private key");
  return {
    digitalOceanTokenSha256: sha256(normalizedSecret(digitalOceanToken, "DIGITALOCEAN_TOKEN")),
    vercelTokenSha256: sha256(normalizedSecret(vercelToken, "VERCEL_TOKEN")),
    vercelTeamId: normalizedTeamId(vercelTeamId),
    digitalOceanSshKeysSha256: sha256(JSON.stringify(sshKeys)),
    sshPrivateKeySha256: sha256(privateKey)
  };
}

function normalizedSshKeys(value) {
  if (!Array.isArray(value)) throw new Error("DigitalOcean SSH keys must be an array");
  const keys = value.map((entry) => String(entry).trim()).filter(Boolean);
  if (keys.length === 0 || new Set(keys).size !== keys.length) throw new Error("DigitalOcean SSH keys must be nonempty and unique");
  return [...keys].sort();
}

function normalizedSecret(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function normalizedTeamId(value) {
  if (value == null || String(value).trim() === "") return null;
  return String(value).trim();
}

function sign(payload, token) {
  return createHmac("sha256", token).update(JSON.stringify(payload)).digest("hex");
}

function attestationSummary(value) {
  return {
    schemaVersion: value.schemaVersion,
    provider: value.provider,
    accountUuid: value.accountUuid,
    canaryRunId: value.canaryRunId,
    canaryRegion: value.canaryIdentity.region,
    canaryDnsZone: value.canaryIdentity.zone,
    canaryCompletedAt: value.canaryCompletedAt,
    canaryEvidenceSha256: value.canaryEvidenceSha256,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    capabilities: [...value.capabilities]
  };
}

async function readProtectedBytes(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a mode 0600 or stricter regular file`);
  return readFile(path);
}

async function writeProtectedJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function protectedAbsolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function validNow(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("clock returned an invalid date");
  return value;
}

function parseDate(value, label) {
  const date = new Date(value);
  if (typeof value !== "string" || Number.isNaN(date.getTime()) || date.toISOString() !== value) throw new Error(`${label} is invalid`);
  return date;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const LIFECYCLE_ATTESTATION_VALIDITY_MS = VALIDITY_MS;
