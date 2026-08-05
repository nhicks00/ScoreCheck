#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DigitalOceanProvider, VercelDnsProvider } from "../event-stack/providers.mjs";
import { loadProtectedEnv } from "../event-stack/stack-deployer.mjs";

const CREATE_CONFIRMATION = "CREATE:PERSISTENT-UNIFI-CONTROLLER";
const NAME = "bvm-unifi-controller";
const ROLE_TAG = "scorecheck-role:unifi-controller";
const PERSISTENT_TAG = "scorecheck-persistent";
const REGION = "sfo2";
const SIZE = "s-1vcpu-2gb";
const IMAGE = "ubuntu-24-04-x64";
const VPC_UUID = "6ece4819-6f6a-4ab9-934c-f6a92660aab2";
const ZONE = "beachvolleyballmedia.com";
const HOSTNAME = `unifi.${ZONE}`;
const CLOUD_INIT = resolve(dirname(fileURLToPath(import.meta.url)), "cloud-init.yaml");

export function parseArgs(argv) {
  const command = argv[0];
  if (!new Set(["up", "status"]).has(command)) throw new Error("first argument must be up or status");
  const options = { command, credentialsEnv: null, state: null, confirm: null };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--credentials-env") options.credentialsEnv = absolute(value, flag);
    else if (flag === "--state") options.state = absolute(value, flag);
    else if (flag === "--confirm") options.confirm = value;
    else throw new Error(`unsupported option ${flag}`);
  }
  if (!options.credentialsEnv) throw new Error("--credentials-env is required");
  if (!options.state) throw new Error("--state is required");
  if (command === "up" && options.confirm !== CREATE_CONFIRMATION) {
    throw new Error(`confirmation must be exactly ${CREATE_CONFIRMATION}`);
  }
  if (command === "status" && options.confirm !== null) throw new Error("status does not accept --confirm");
  return options;
}

export function buildRequest({ sshKeys, cloudInitSha256 }) {
  return {
    name: NAME,
    region: REGION,
    vpcUuid: VPC_UUID,
    size: SIZE,
    image: IMAGE,
    sshKeys,
    tags: [ROLE_TAG, PERSISTENT_TAG],
    userDataProfile: "unifi",
    userDataSha256: cloudInitSha256
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await assertProtectedFile(options.credentialsEnv, "provider credentials");
  const credentials = await loadProtectedEnv(options.credentialsEnv);
  const sshKeys = (credentials.SCORECHECK_DO_SSH_KEYS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!credentials.DIGITALOCEAN_TOKEN) throw new Error("DIGITALOCEAN_TOKEN is required");
  if (!credentials.VERCEL_TOKEN) throw new Error("VERCEL_TOKEN is required");
  if (sshKeys.length === 0) throw new Error("SCORECHECK_DO_SSH_KEYS is required");

  const cloudInit = await readFile(CLOUD_INIT, "utf8");
  const cloud = new DigitalOceanProvider({
    token: credentials.DIGITALOCEAN_TOKEN,
    sshKeys,
    cloudInitPaths: { unifi: CLOUD_INIT }
  });
  const dns = new VercelDnsProvider({
    token: credentials.VERCEL_TOKEN,
    teamId: credentials.VERCEL_TEAM_ID || null
  });

  if (options.command === "status") {
    const state = await readState(options.state);
    const droplet = await cloud.getDroplet(state.dropletId);
    assertIdentity(state, droplet);
    process.stdout.write(`${JSON.stringify(publicStatus(state, droplet), null, 2)}\n`);
    return;
  }

  const existing = await readState(options.state, true);
  if (existing) {
    const droplet = await cloud.getDroplet(existing.dropletId);
    assertIdentity(existing, droplet);
    process.stdout.write(`${JSON.stringify(publicStatus(existing, droplet), null, 2)}\n`);
    return;
  }

  const matches = await cloud.findDropletsByName(NAME);
  if (matches.length !== 0) throw new Error(`refusing creation because ${NAME} already exists without protected state`);
  await cloud.ensureTag(ROLE_TAG);
  await cloud.ensureTag(PERSISTENT_TAG);
  const request = buildRequest({ sshKeys, cloudInitSha256: sha256(cloudInit) });
  const created = await cloud.createDroplet(request);
  let state = {
    schemaVersion: 1,
    name: NAME,
    dropletId: created.id,
    region: REGION,
    size: SIZE,
    image: IMAGE,
    hostname: HOSTNAME,
    cloudInitSha256: request.userDataSha256,
    createdAt: new Date().toISOString(),
    dnsChange: null,
    readyAt: null
  };
  await writeState(options.state, state);

  const active = await cloud.waitDropletActive(created.id);
  const dnsChange = await dns.upsertARecord({ zone: ZONE, hostname: HOSTNAME, value: active.publicIpv4, ttl: 60 });
  const dnsReady = await dns.waitARecordReady({ zone: ZONE, hostname: HOSTNAME, value: active.publicIpv4 });
  state = { ...state, dnsChange, readyAt: dnsReady.readyAt };
  await writeState(options.state, state);
  process.stdout.write(`${JSON.stringify(publicStatus(state, active), null, 2)}\n`);
}

function assertIdentity(state, droplet) {
  if (droplet.name !== NAME || droplet.region !== REGION || droplet.size !== SIZE) {
    throw new Error("cloud UniFi controller identity does not match protected state");
  }
  if (!droplet.tags.includes(ROLE_TAG) || !droplet.tags.includes(PERSISTENT_TAG)) {
    throw new Error("cloud UniFi controller is missing its persistent ownership tags");
  }
}

function publicStatus(state, droplet) {
  return {
    name: state.name,
    dropletId: state.dropletId,
    status: droplet.status,
    region: droplet.region,
    size: droplet.size,
    hostname: state.hostname,
    createdAt: state.createdAt,
    readyAt: state.readyAt
  };
}

async function readState(path, optional = false) {
  try {
    await assertProtectedFile(path, "cloud UniFi controller state");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.schemaVersion !== 1 || !value.dropletId || value.name !== NAME || value.hostname !== HOSTNAME) {
      throw new Error("cloud UniFi controller state is invalid");
    }
    return value;
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeState(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function assertProtectedFile(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a mode-0600 protected file`);
}

function absolute(value, flag) {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) {
    throw new Error(`${flag} must be a normalized absolute path`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`cloud UniFi controller failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
