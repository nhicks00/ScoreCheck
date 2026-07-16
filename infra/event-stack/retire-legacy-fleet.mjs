#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { DigitalOceanProvider, PushoverNotifier } from "./providers.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HEALTHCHECKS_API = "https://healthchecks.io/api/v3";
const PLAN_VALIDITY_MS = 30 * 60_000;
const EXPECTED_COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const [providerEnv, monitorEnv, fleet, anchors] = await Promise.all([
    loadProtectedEnv(options.credentialsEnv),
    loadProtectedEnv(options.monitorEnv),
    readJson(options.fleetSpec, "legacy fleet specification"),
    readProtectedJson(options.anchors, "endpoint anchors")
  ]);
  const cloud = new DigitalOceanProvider({
    token: required(providerEnv.DIGITALOCEAN_TOKEN, "DIGITALOCEAN_TOKEN"),
    sshKeys: [],
    cloudInitPaths: {}
  });
  const monitor = new MonitorClient({
    url: options.monitorUrl,
    token: required(monitorEnv.MONITOR_API_TOKEN, "MONITOR_API_TOKEN")
  });
  const healthchecks = new HealthchecksMaintenance({
    apiKey: required(monitorEnv.HEALTHCHECKS_API_KEY, "HEALTHCHECKS_API_KEY"),
    baselineCheckId: required(monitorEnv.HEALTHCHECKS_BASELINE_CHECK_ID, "HEALTHCHECKS_BASELINE_CHECK_ID"),
    activeCheckId: required(monitorEnv.HEALTHCHECKS_ACTIVE_CHECK_ID, "HEALTHCHECKS_ACTIVE_CHECK_ID")
  });
  const notifier = new PushoverNotifier({
    appToken: required(monitorEnv.PUSHOVER_APP_TOKEN ?? providerEnv.PUSHOVER_APP_TOKEN, "PUSHOVER_APP_TOKEN"),
    userKey: required(monitorEnv.PUSHOVER_USER_KEY ?? providerEnv.PUSHOVER_USER_KEY, "PUSHOVER_USER_KEY")
  });
  const dependencies = { cloud, monitor, healthchecks, notifier };
  let result;
  if (options.command === "plan") {
    result = await createRetirementPlan({ ...dependencies, fleet, anchors, now: new Date() });
    await writeProtectedJson(options.plan, result);
  } else if (options.command === "execute") {
    const plan = await readProtectedJson(options.plan, "retirement plan");
    result = await executeRetirement({ ...dependencies, fleet, anchors, plan, statePath: options.state, confirmation: options.confirm, now: () => new Date() });
  } else if (options.command === "status") {
    result = await readProtectedJson(options.state, "retirement state");
  } else throw new Error(`unsupported retirement command ${options.command}`);
  process.stdout.write(`${JSON.stringify(sanitizeResult(result), null, 2)}\n`);
}

export async function createRetirementPlan({ cloud, monitor, healthchecks, fleet, anchors, now }) {
  validateFleetSpec(fleet);
  validateAnchors(anchors, fleet.region);
  const [account, droplets, addresses, snapshot, deadMan] = await Promise.all([
    cloud.getAccount(), cloud.listAllDroplets(), cloud.listReservedIpv4s(), monitor.snapshot(), healthchecks.inspect()
  ]);
  assertSafeMonitorSnapshot(snapshot, now);
  assertDeadManReady(deadMan);
  const resources = exactFleetInventory(fleet, droplets);
  const reservedIpv4 = exactAnchorInventory(fleet, anchors, addresses, resources);
  const planId = randomUUID();
  const createdAt = now.toISOString();
  return {
    schemaVersion: 1,
    planId,
    event: fleet.event,
    createdAt,
    expiresAt: new Date(now.getTime() + PLAN_VALIDITY_MS).toISOString(),
    account: { uuidSha256: sha256(account.uuid), status: account.status, dropletLimit: account.dropletLimit },
    resources,
    reservedIpv4,
    baseline: {
      monitorGeneratedAt: snapshot.generatedAt,
      monitorSha256: sha256(snapshot),
      collector: snapshot.collector?.state,
      deadMan
    },
    confirmation: `RETIRE:${fleet.event}:${planId}`
  };
}

export async function executeRetirement({ cloud, monitor, healthchecks, notifier, fleet, anchors, plan, statePath, confirmation, now }) {
  let state = await readJsonOrNull(statePath);
  validateRetirementPlan(plan, fleet, now(), state !== null);
  if (confirmation !== plan.confirmation) throw new Error(`confirmation must be exactly ${plan.confirmation}`);
  if (state === null) {
    const [account, droplets, addresses, snapshot, deadMan] = await Promise.all([
      cloud.getAccount(), cloud.listAllDroplets(), cloud.listReservedIpv4s(), monitor.snapshot(), healthchecks.inspect()
    ]);
    if (sha256(account.uuid) !== plan.account.uuidSha256 || account.status !== "active") throw new Error("DigitalOcean account identity or status changed after planning");
    assertSafeMonitorSnapshot(snapshot, now());
    assertDeadManReady(deadMan);
    assertPlanInventory(plan, exactFleetInventory(fleet, droplets));
    assertPlanAnchors(plan, exactAnchorInventory(fleet, anchors, addresses, plan.resources));
    state = {
      schemaVersion: 1,
      planId: plan.planId,
      event: plan.event,
      phase: "retiring",
      startedAt: now().toISOString(),
      updatedAt: now().toISOString(),
      deadMan: { baseline: "running", active: deadMan.active.status },
      reservedIpv4: Object.fromEntries(plan.reservedIpv4.map((entry) => [entry.slot, { status: "assigned", updatedAt: null }])),
      resources: Object.fromEntries(plan.resources.map((entry) => [entry.name, { id: entry.id, status: "active", deletedAt: null }])),
      notifications: { started: null, completed: null },
      completedAt: null
    };
    await writeProtectedJson(statePath, state);
  } else {
    validateRetirementState(state, plan);
  }
  if (state.phase === "retired") return state;

  if (state.notifications.started === null) {
    await notifier.send({
      title: "ScoreCheck event servers are shutting down",
      message: "Planned event infrastructure teardown has started. Monitoring will return during the reconstruction test.",
      priority: 0,
      dedupeKey: `retirement-started:${plan.planId}`
    });
    state.notifications.started = now().toISOString();
    await saveState(statePath, state, now());
  }
  if (state.deadMan.baseline !== "paused") {
    await healthchecks.pauseBaseline();
    state.deadMan.baseline = "paused";
    await saveState(statePath, state, now());
  }

  for (const anchor of plan.reservedIpv4) {
    if (state.reservedIpv4[anchor.slot].status === "unassigned") continue;
    const current = await cloud.getReservedIpv4(anchor.ip);
    if (current.dropletId !== null && String(current.dropletId) !== String(anchor.dropletId)) throw new Error(`reserved IPv4 ${anchor.slot} moved to an unexpected Droplet`);
    if (current.dropletId !== null) await cloud.unassignReservedIpv4(anchor.ip);
    await cloud.waitReservedIpv4Unassigned(anchor.ip);
    state.reservedIpv4[anchor.slot] = { status: "unassigned", updatedAt: now().toISOString() };
    await saveState(statePath, state, now());
  }

  const deletionOrder = [...plan.resources].sort((left, right) => deletionRank(left.role) - deletionRank(right.role));
  for (const resource of deletionOrder) {
    const record = state.resources[resource.name];
    if (record.status === "deleted") continue;
    const current = await dropletOrNull(cloud, resource.id);
    if (current !== null) {
      assertResourceIdentity(resource, current);
      await cloud.deleteDroplet(resource.id);
      await cloud.waitDropletAbsent(resource.id);
    }
    record.status = "deleted";
    record.deletedAt = now().toISOString();
    await saveState(statePath, state, now());
  }

  const [remainingDroplets, remainingAddresses] = await Promise.all([cloud.listAllDroplets(), cloud.listReservedIpv4s()]);
  if (remainingDroplets.length !== 0) throw new Error(`DigitalOcean inventory did not return to zero; ${remainingDroplets.length} Droplet(s) remain`);
  assertRetainedAddresses(plan, remainingAddresses);
  if (state.notifications.completed === null) {
    await notifier.send({
      title: "ScoreCheck event servers are fully shut down",
      message: "All seven prior event servers were removed. The two stable stream addresses were retained and are ready for reconstruction.",
      priority: 0,
      dedupeKey: `retirement-completed:${plan.planId}`
    });
    state.notifications.completed = now().toISOString();
  }
  state.phase = "retired";
  state.completedAt = now().toISOString();
  await saveState(statePath, state, now());
  return state;
}

export function assertSafeMonitorSnapshot(snapshot, now = new Date()) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("monitor snapshot is unavailable");
  const generatedAt = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generatedAt) || now.getTime() - generatedAt > 15_000 || generatedAt > now.getTime() + 5_000) throw new Error("monitor snapshot is stale");
  if (snapshot.collector?.state !== "HEALTHY" || snapshot.collector?.agentsFresh !== snapshot.collector?.agentsExpected) throw new Error("monitor collector is not fully healthy");
  if (snapshot.event !== null) throw new Error("an event is active");
  if ((snapshot.faultGates?.length ?? 0) !== 0) throw new Error("a monitoring fault gate is active");
  if ((snapshot.incidents?.length ?? 0) !== 0) throw new Error("a monitoring incident is active");
  if (!Array.isArray(snapshot.courts) || snapshot.courts.length !== 8) throw new Error("monitor snapshot does not contain eight courts");
  for (const court of snapshot.courts) {
    if (!EXPECTED_COURTS.includes(court.courtNumber) || court.overallState !== "EXPECTED_OFF" || court.expectation?.coveragePhase !== "OFF") throw new Error(`Camera ${court.courtNumber ?? "unknown"} is not safely expected off`);
    if (court.media?.raw?.ready === true || court.media?.preview?.ready === true || court.media?.program?.ready === true) throw new Error(`Camera ${court.courtNumber} still has an active media path`);
  }
  for (const agent of snapshot.agents ?? []) {
    if (agent.role === "compositor" && agent.nativeServices?.egress?.activeWebRequests !== 0) throw new Error(`${agent.agentId} still has an active Egress request`);
  }
  return true;
}

export function validateFleetSpec(value) {
  if (!value || value.schemaVersion !== 1 || value.event !== "gate8-2026-07-13" || value.region !== "sfo2") throw new Error("legacy fleet specification identity is invalid");
  if (!Array.isArray(value.requiredTags) || value.requiredTags.length < 2) throw new Error("legacy fleet required tags are invalid");
  if (!Array.isArray(value.resources) || value.resources.length !== 7) throw new Error("legacy fleet must contain exactly seven resources");
  const names = new Set();
  const slots = new Set();
  for (const resource of value.resources) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(resource.name ?? "") || names.has(resource.name)) throw new Error("legacy fleet resource names are invalid or duplicated");
    names.add(resource.name);
    if (!new Set(["ingest", "commentary", "observability", "compositor"]).has(resource.role) || typeof resource.size !== "string") throw new Error(`legacy fleet resource ${resource.name} shape is invalid`);
    if (resource.reservedIpv4Slot !== null) {
      if (!new Set(["ingest", "commentary"]).has(resource.reservedIpv4Slot) || slots.has(resource.reservedIpv4Slot)) throw new Error("legacy fleet Reserved IPv4 slots are invalid or duplicated");
      slots.add(resource.reservedIpv4Slot);
    }
  }
  if (slots.size !== 2) throw new Error("legacy fleet must bind ingest and commentary Reserved IPv4 slots");
  return value;
}

function exactFleetInventory(fleet, droplets) {
  if (!Array.isArray(droplets) || droplets.length !== fleet.resources.length) throw new Error(`DigitalOcean inventory must contain exactly ${fleet.resources.length} legacy Droplets`);
  const resources = fleet.resources.map((expected) => {
    const matches = droplets.filter((entry) => entry.name === expected.name);
    if (matches.length !== 1) throw new Error(`legacy Droplet ${expected.name} was not returned exactly once`);
    const droplet = matches[0];
    if (droplet.status !== "active" || droplet.region !== fleet.region || droplet.size !== expected.size) throw new Error(`legacy Droplet ${expected.name} shape drifted`);
    for (const tag of fleet.requiredTags) if (!droplet.tags.includes(tag)) throw new Error(`legacy Droplet ${expected.name} is missing required tag ${tag}`);
    return { id: String(droplet.id), name: expected.name, role: expected.role, region: droplet.region, size: droplet.size, tags: [...droplet.tags].sort(), reservedIpv4Slot: expected.reservedIpv4Slot };
  });
  if (new Set(resources.map((entry) => entry.id)).size !== resources.length) throw new Error("legacy Droplet IDs are duplicated");
  return resources;
}

function exactAnchorInventory(fleet, anchors, addresses, resources) {
  return fleet.resources.filter((entry) => entry.reservedIpv4Slot !== null).map((expected) => {
    const ip = anchors.reservedIpv4?.[expected.reservedIpv4Slot];
    const address = addresses.find((entry) => entry.ip === ip);
    const resource = resources.find((entry) => entry.name === expected.name);
    if (!address || !resource || String(address.dropletId) !== String(resource.id) || address.locked) throw new Error(`retained ${expected.reservedIpv4Slot} IPv4 is not stably assigned to ${expected.name}`);
    return { slot: expected.reservedIpv4Slot, ip, dropletId: resource.id };
  }).sort((left, right) => left.slot.localeCompare(right.slot));
}

function validateAnchors(value, region) {
  if (!value || value.schemaVersion !== 2 || value.provider !== "digitalocean" || value.region !== region || value.retention !== "persistent" || value.status !== "ready") throw new Error("endpoint anchors are not ready persistent DigitalOcean anchors");
  if (!value.reservedIpv4?.ingest || !value.reservedIpv4?.commentary) throw new Error("endpoint anchors are missing ingest or commentary");
}

function validateRetirementPlan(plan, fleet, now, resuming = false) {
  validateFleetSpec(fleet);
  if (!plan || plan.schemaVersion !== 1 || plan.event !== fleet.event || typeof plan.planId !== "string") throw new Error("retirement plan identity is invalid");
  if (!resuming && Date.parse(plan.expiresAt) <= now.getTime()) throw new Error("retirement plan expired; create a fresh plan");
  if (!Array.isArray(plan.resources) || plan.resources.length !== 7 || !Array.isArray(plan.reservedIpv4) || plan.reservedIpv4.length !== 2) throw new Error("retirement plan inventory is invalid");
  if (plan.confirmation !== `RETIRE:${plan.event}:${plan.planId}`) throw new Error("retirement plan confirmation contract is invalid");
}

function validateRetirementState(state, plan) {
  if (!state || state.schemaVersion !== 1 || state.planId !== plan.planId || state.event !== plan.event || !new Set(["retiring", "retired"]).has(state.phase)) throw new Error("retirement state does not match the plan");
}

function assertDeadManReady(value) {
  if (value.baseline.status !== "up" || !new Set(["paused", "up"]).has(value.active.status)) throw new Error("Healthchecks dead-man state is not ready for planned maintenance");
}

function assertPlanInventory(plan, resources) {
  if (sha256(plan.resources) !== sha256(resources)) throw new Error("legacy fleet inventory changed after planning");
}

function assertPlanAnchors(plan, anchors) {
  if (sha256(plan.reservedIpv4) !== sha256(anchors)) throw new Error("retained endpoint attachments changed after planning");
}

function assertRetainedAddresses(plan, addresses) {
  for (const expected of plan.reservedIpv4) {
    const current = addresses.find((entry) => entry.ip === expected.ip);
    if (!current || current.dropletId !== null || current.locked) throw new Error(`retained ${expected.slot} IPv4 was lost or remained assigned`);
  }
}

function assertResourceIdentity(expected, current) {
  if (String(current.id) !== String(expected.id) || current.name !== expected.name || current.region !== expected.region || current.size !== expected.size) throw new Error(`Droplet ${expected.name} identity changed before deletion`);
  if (sha256([...current.tags].sort()) !== sha256(expected.tags)) throw new Error(`Droplet ${expected.name} tags changed before deletion`);
}

class MonitorClient {
  constructor({ url, token, fetchImpl = globalThis.fetch }) { this.url = url.replace(/\/$/, ""); this.token = token; this.fetchImpl = fetchImpl; }
  async snapshot() {
    const response = await this.fetchImpl(`${this.url}/v1/snapshot`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`monitor snapshot request failed with HTTP ${response.status}`);
    return response.json();
  }
}

class HealthchecksMaintenance {
  constructor({ apiKey, baselineCheckId, activeCheckId, fetchImpl = globalThis.fetch }) { this.apiKey = apiKey; this.baselineCheckId = baselineCheckId; this.activeCheckId = activeCheckId; this.fetchImpl = fetchImpl; }
  async inspect() { return { baseline: await this.#get(this.baselineCheckId), active: await this.#get(this.activeCheckId) }; }
  async pauseBaseline() {
    const response = await this.fetchImpl(`${HEALTHCHECKS_API}/checks/${encodeURIComponent(this.baselineCheckId)}/pause`, { method: "POST", headers: { "x-api-key": this.apiKey } });
    if (!response.ok) throw new Error(`Healthchecks baseline pause failed with HTTP ${response.status}`);
    const current = await this.#get(this.baselineCheckId);
    if (current.status !== "paused") throw new Error("Healthchecks baseline did not enter paused state");
    return current;
  }
  async #get(id) {
    const response = await this.fetchImpl(`${HEALTHCHECKS_API}/checks/${encodeURIComponent(id)}`, { headers: { "x-api-key": this.apiKey } });
    if (!response.ok) throw new Error(`Healthchecks check read failed with HTTP ${response.status}`);
    const value = await response.json();
    return { status: String(value.status ?? "unknown"), lastPing: value.last_ping ?? null };
  }
}

async function dropletOrNull(cloud, id) {
  try { return await cloud.getDroplet(id); }
  catch (error) { if (error?.status === 404) return null; throw error; }
}

async function saveState(path, state, now) { state.updatedAt = now.toISOString(); await writeAtomicProtected(path, state); }

async function readProtectedJson(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be mode 0600 or stricter`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJson(path, label) {
  const information = await stat(path);
  if (!information.isFile()) throw new Error(`${label} must be a file`);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`${label} must contain valid JSON`); }
}

async function readJsonOrNull(path) {
  try { return await readProtectedJson(path, "retirement state"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function writeProtectedJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

async function writeAtomicProtected(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["plan", "execute", "status"]).has(command)) throw new Error("first argument must be plan, execute, or status");
  const options = { command, fleetSpec: null, anchors: null, credentialsEnv: null, monitorEnv: null, monitorUrl: null, plan: null, state: null, confirm: null };
  const fields = new Map([["--fleet-spec", "fleetSpec"], ["--anchors", "anchors"], ["--credentials-env", "credentialsEnv"], ["--monitor-env", "monitorEnv"], ["--monitor-url", "monitorUrl"], ["--plan", "plan"], ["--state", "state"], ["--confirm", "confirm"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]; const key = fields.get(flag); const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is invalid or missing a value`);
    options[key] = value;
  }
  if (command === "status") { options.state = absolute(required(options.state, "--state"), "--state"); return options; }
  for (const key of ["fleetSpec", "anchors", "credentialsEnv", "monitorEnv", "plan", "state"]) options[key] = absolute(required(options[key], `--${key}`), `--${key}`);
  if (!/^https:\/\/[a-zA-Z0-9.-]+$/.test(options.monitorUrl ?? "")) throw new Error("--monitor-url must be an HTTPS origin");
  if (command === "execute" && !options.confirm) throw new Error("execute requires --confirm");
  return options;
}

function sanitizeResult(value) {
  return { ...value, account: value.account ? { ...value.account, uuidSha256: value.account.uuidSha256 } : undefined, reservedIpv4: Array.isArray(value.reservedIpv4) ? value.reservedIpv4.map(({ ip: _ip, ...entry }) => entry) : value.reservedIpv4 };
}

function deletionRank(role) { return ({ compositor: 1, ingest: 2, commentary: 3, observability: 4 })[role] ?? 9; }
function sha256(value) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function required(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); return value.trim(); }
function absolute(value, label) { if (!isAbsolute(value) || resolve(value) !== value || value.includes("..")) throw new Error(`${label} must be a normalized absolute path`); return value; }

function usage() {
  process.stdout.write("Usage:\n  node infra/event-stack/retire-legacy-fleet.mjs plan --fleet-spec FILE --anchors FILE --credentials-env FILE --monitor-env FILE --monitor-url HTTPS_ORIGIN --plan FILE --state FILE\n  node infra/event-stack/retire-legacy-fleet.mjs execute --fleet-spec FILE --anchors FILE --credentials-env FILE --monitor-env FILE --monitor-url HTTPS_ORIGIN --plan FILE --state FILE --confirm RETIRE:EVENT:PLAN_ID\n  node infra/event-stack/retire-legacy-fleet.mjs status --state FILE\n");
}
