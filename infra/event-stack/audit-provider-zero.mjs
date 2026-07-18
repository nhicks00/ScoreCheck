#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DigitalOceanProvider } from "./providers.mjs";
import { YouTubeRehearsalProvider } from "./rehearsal/youtube-provider.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";

const EVENT = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DNS_ZONE = /^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])$/u;
const DO_API = "https://api.digitalocean.com/v2";
const VERCEL_API = "https://api.vercel.com";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`provider-zero audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const environment = { ...process.env, ...await loadProtectedEnv(options.credentialsEnv) };
  const anchors = JSON.parse(await readFile(options.anchors, "utf8"));
  validateAnchors(anchors);
  const cloud = new DigitalOceanProvider({
    token: required(environment, "DIGITALOCEAN_TOKEN"),
    sshKeys: [],
    cloudInitPaths: {}
  });
  const youtube = new YouTubeRehearsalProvider({
    clientId: required(environment, "YOUTUBE_CLIENT_ID"),
    clientSecret: required(environment, "YOUTUBE_CLIENT_SECRET"),
    refreshToken: required(environment, "YOUTUBE_REFRESH_TOKEN")
  });
  const doToken = required(environment, "DIGITALOCEAN_TOKEN");
  const vercelToken = required(environment, "VERCEL_TOKEN");
  const teamId = required(environment, "VERCEL_TEAM_ID");
  const [account, droplets, reservedIpv4, snapshots, tags, volumesResult, projects, dnsRecords, youtubePool] = await Promise.all([
    cloud.getAccount(),
    cloud.listAllDroplets(),
    cloud.listReservedIpv4s(),
    digitalOceanCollection({ token: doToken, path: "/images?private=true&type=snapshot", key: "images" }),
    digitalOceanCollection({ token: doToken, path: "/tags", key: "tags" }),
    optionalDigitalOceanCollection({ token: doToken, path: "/volumes", key: "volumes" }),
    vercelCollection({ token: vercelToken, teamId, path: "/v9/projects?limit=100", key: "projects" }),
    vercelCollection({ token: vercelToken, teamId, path: `/v4/domains/${encodeURIComponent(options.zone)}/records?limit=100`, key: "records" }),
    youtube.resolvePersistentStreamPool()
  ]);
  const audit = classifyProviderZero({
    event: options.event,
    account,
    droplets,
    reservedIpv4,
    expectedReservedIpv4: Object.values(anchors.reservedIpv4),
    snapshots,
    tags,
    volumesResult,
    projects,
    dnsRecords,
    youtubePool
  });
  await writeFile(options.output, `${JSON.stringify(audit, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(options.output, 0o600);
  process.stdout.write(`${JSON.stringify({ pass: audit.pass, checkedAt: audit.checkedAt, event: audit.event, output: options.output, checks: audit.checks }, null, 2)}\n`);
  if (!audit.pass) process.exitCode = 1;
}

export function classifyProviderZero({ event, account, droplets, reservedIpv4, expectedReservedIpv4, snapshots, tags, volumesResult, projects, dnsRecords, youtubePool }) {
  if (!EVENT.test(event ?? "")) throw new Error("provider-zero event is invalid");
  const expectedAddresses = [...expectedReservedIpv4].map(String).sort();
  if (expectedAddresses.length !== 2 || new Set(expectedAddresses).size !== 2) throw new Error("provider-zero audit requires exactly two retained endpoint anchors");
  const actualAddresses = reservedIpv4.map((entry) => String(entry.ip)).sort();
  const eventSnapshots = snapshots
    .filter((entry) => String(entry.name ?? "").startsWith("scorecheck-"))
    .map((entry) => ({ id: String(entry.id), name: String(entry.name) }));
  const eventTags = tags
    .map((entry) => String(entry.name ?? ""))
    .filter((name) => name.startsWith("scorecheck-event:"));
  const rehearsalProjects = projects
    .filter((entry) => String(entry.name ?? "").startsWith("scorecheck-rehearsal-"))
    .map((entry) => ({ id: String(entry.id ?? entry.uid), name: String(entry.name) }));
  const rehearsalDns = dnsRecords
    .filter((entry) => String(entry.name ?? "").includes("rehearsal"))
    .map((entry) => ({ id: String(entry.id ?? entry.uid), name: String(entry.name), type: String(entry.type ?? entry.recordType ?? "") }));
  const pool = Object.values(youtubePool).sort((left, right) => left.court - right.court);
  const youtubePersistentStreamPool = pool.map((entry) => ({
    court: entry.court,
    status: entry.streamStatus,
    health: entry.healthStatus,
    issueCount: entry.configurationIssues.length
  }));
  const checks = {
    accountActive: account.status === "active",
    dropletLimitAtLeast12: Number.isInteger(account.dropletLimit) && account.dropletLimit >= 12,
    dropletsZero: droplets.length === 0,
    reservedExact: JSON.stringify(actualAddresses) === JSON.stringify(expectedAddresses),
    reservedUnassigned: reservedIpv4.every((entry) => entry.dropletId === null && entry.locked === false),
    eventSnapshotsZero: eventSnapshots.length === 0,
    eventTagsZero: eventTags.length === 0,
    rehearsalProjectsZero: rehearsalProjects.length === 0,
    rehearsalDnsZero: rehearsalDns.length === 0,
    youtubePoolExactIdle: pool.length === 8 && pool.every((entry, index) => entry.court === index + 1
      && ["inactive", "ready"].includes(entry.streamStatus)
      && entry.configurationIssues.length === 0),
    volumesZeroWhenReadable: volumesResult.readable === false || volumesResult.items.length === 0
  };
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    event,
    pass: Object.values(checks).every(Boolean),
    account: { status: account.status, dropletLimit: account.dropletLimit },
    droplets: droplets.map((entry) => ({ id: entry.id, name: entry.name, status: entry.status, tags: entry.tags })),
    eventSnapshots,
    eventTags,
    reservedIpv4: reservedIpv4.map((entry) => ({ ip: entry.ip, region: entry.region, assigned: entry.dropletId !== null, locked: entry.locked })),
    rehearsalDns,
    rehearsalProjects,
    youtubePersistentStreamPool,
    providerReadContracts: {
      volumesHttpStatus: volumesResult.status,
      volumesReadable: volumesResult.readable
    },
    checks
  };
}

async function digitalOceanCollection({ token, path, key }) {
  const values = [];
  let url = `${DO_API}${path}`;
  const seen = new Set();
  for (let page = 0; page < 100; page += 1) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`DigitalOcean GET ${new URL(url).pathname} failed with HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload[key])) throw new Error(`DigitalOcean ${key} inventory is invalid`);
    values.push(...payload[key]);
    const next = payload.links?.pages?.next ?? null;
    if (!next) return values;
    if (seen.has(next)) throw new Error(`DigitalOcean ${key} pagination repeated`);
    seen.add(next);
    url = next;
  }
  throw new Error(`DigitalOcean ${key} pagination exceeded the safety limit`);
}

async function optionalDigitalOceanCollection({ token, path, key }) {
  const response = await fetch(`${DO_API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (response.status === 403) return { readable: false, status: 403, items: [] };
  if (!response.ok) throw new Error(`DigitalOcean GET ${path} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload[key])) throw new Error(`DigitalOcean ${key} inventory is invalid`);
  if (payload.links?.pages?.next) throw new Error(`DigitalOcean ${key} inventory pagination is unsupported by the optional read contract`);
  return { readable: true, status: response.status, items: payload[key] };
}

async function vercelCollection({ token, teamId, path, key }) {
  const values = [];
  let cursor = null;
  const seen = new Set();
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`${VERCEL_API}${path}`);
    url.searchParams.set("teamId", teamId);
    if (cursor !== null) url.searchParams.set("until", cursor);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Vercel GET ${url.pathname} failed with HTTP ${response.status}`);
    const payload = await response.json();
    const entries = payload[key] ?? payload;
    if (!Array.isArray(entries)) throw new Error(`Vercel ${key} inventory is invalid`);
    values.push(...entries);
    cursor = payload.pagination?.next == null ? null : String(payload.pagination.next);
    if (cursor === null) return values;
    if (seen.has(cursor)) throw new Error(`Vercel ${key} pagination repeated`);
    seen.add(cursor);
  }
  throw new Error(`Vercel ${key} pagination exceeded the safety limit`);
}

function parseArgs(argv) {
  const result = { event: null, credentialsEnv: null, anchors: null, zone: null, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!["--event", "--credentials-env", "--anchors", "--zone", "--output"].includes(option)) throw new Error(`unsupported provider-zero option ${option}`);
    const value = argv[++index];
    if (!value) throw new Error(`provider-zero option ${option} is incomplete`);
    result[option.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!EVENT.test(result.event ?? "")) throw new Error("provider-zero event is invalid");
  if (!DNS_ZONE.test(result.zone ?? "")) throw new Error("provider-zero DNS zone is invalid");
  for (const key of ["credentialsEnv", "anchors", "output"]) result[key] = requiredPath(result[key], key);
  return result;
}

function validateAnchors(value) {
  if (value?.schemaVersion !== 2 || value.provider !== "digitalocean" || value.retention !== "persistent" || value.status !== "ready"
    || !value.reservedIpv4 || Object.keys(value.reservedIpv4).sort().join(",") !== "commentary,ingest"
    || new Set(Object.values(value.reservedIpv4)).size !== 2) {
    throw new Error("provider-zero endpoint anchors are invalid");
  }
}

function required(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || !value || /[\r\n\0]/u.test(value)) throw new Error(`${key} is required`);
  return value;
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/u.test(value) || resolve(value) !== value) throw new Error(`provider-zero ${label} must be a normalized absolute path`);
  return value;
}

export { parseArgs, validateAnchors };
