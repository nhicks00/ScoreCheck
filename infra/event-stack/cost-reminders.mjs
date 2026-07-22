#!/usr/bin/env node

import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateProfile } from "./eventctl.mjs";
import { DigitalOceanProvider, PushoverNotifier } from "./providers.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RESEND_AFTER_MS = 6 * 60 * 60 * 1_000;

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const profilePath = parseArgs(process.argv.slice(2));
  const profile = validateProfile(await readProtectedJson(profilePath, "event operator profile"));
  const [manifest, lifecycle, credentials, monitoring] = await Promise.all([
    readProtectedJson(profile.manifest, "event manifest", false),
    readProtectedJson(profile.state, "event lifecycle state"),
    loadProtectedEnv(profile.credentialsEnv),
    loadProtectedEnv(resolve(profile.secrets, "observability.env"))
  ]);
  const cloud = new DigitalOceanProvider({
    token: required(credentials, "DIGITALOCEAN_TOKEN"),
    sshKeys: [],
    cloudInitPaths: {}
  });
  const droplets = await cloud.listDropletsByEvent(manifest.event);
  const snapshot = await readMonitorSnapshot(monitoring).catch(() => null);
  const deliveryPath = `${profile.state}.cost-reminders.json`;
  const delivery = await readDeliveryState(deliveryPath, manifest.event);
  const notifier = new PushoverNotifier({
    appToken: required(monitoring, "PUSHOVER_APP_TOKEN"),
    userKey: required(monitoring, "PUSHOVER_USER_KEY")
  });
  const result = await runCostReminderCycle({ manifest, lifecycle, droplets, snapshot, delivery, notifier });
  await writeProtectedJson(deliveryPath, result.delivery);
  process.stdout.write(`${JSON.stringify({
    status: result.findings.length ? "ATTENTION" : "CLEAR",
    event: manifest.event,
    phase: lifecycle.phase,
    eventDroplets: droplets.length,
    activeEgresses: activeEgressCount(snapshot),
    findings: result.findings.map(({ key, message }) => ({ key, message })),
    notificationsSent: result.sent
  }, null, 2)}\n`);
}

export function evaluateCostReminders({ manifest, lifecycle, droplets, snapshot, now = new Date() }) {
  if (!manifest?.event || !lifecycle?.phase || !Array.isArray(droplets)) throw new Error("cost reminder input is invalid");
  const findings = [];
  const activeEgresses = activeEgressCount(snapshot);
  const closedAtMs = Date.parse(lifecycle.coverage?.closedAt ?? "");
  const createdAtMs = Date.parse(lifecycle.createdAt ?? "");
  const ageSinceCloseMs = Number.isFinite(closedAtMs) ? now.getTime() - closedAtMs : null;
  const ageSinceCreateMs = Number.isFinite(createdAtMs) ? now.getTime() - createdAtMs : null;
  const terminal = new Set(["destroyed", "aborted"]);

  if (lifecycle.phase === "closed" && activeEgresses > 0) {
    findings.push(finding("egress-after-close", 1,
      `${activeEgresses} stream output${activeEgresses === 1 ? " is" : "s are"} still running after coverage closed. Complete the broadcasts and stop the exact outputs.`));
  }
  if (lifecycle.phase === "closed" && droplets.length > 0 && ageSinceCloseMs !== null && ageSinceCloseMs >= 60 * 60 * 1_000) {
    findings.push(finding("compute-one-hour-after-close", 0,
      `${droplets.length} temporary event server${droplets.length === 1 ? " is" : "s are"} still billing more than one hour after coverage closed. Capture evidence, then run the confirmed teardown.`));
  }
  if (lifecycle.phase === "closed" && droplets.length > 0 && ageSinceCloseMs !== null && ageSinceCloseMs >= 12 * 60 * 60 * 1_000) {
    findings.push(finding("compute-next-morning", 1,
      `${droplets.length} temporary event servers are still billing at least twelve hours after coverage closed. Review and complete teardown now.`));
  }
  if (new Set(["planned", "provisioning", "ready"]).has(lifecycle.phase)
      && droplets.length > 0 && ageSinceCreateMs !== null && ageSinceCreateMs >= 24 * 60 * 60 * 1_000) {
    findings.push(finding("unused-compute-day", 0,
      `${droplets.length} temporary event servers have existed for at least one day without coverage starting. Confirm the event is still pending or abort the setup.`));
  }
  if (terminal.has(lifecycle.phase) && droplets.length > 0) {
    findings.push(finding("terminal-provider-nonzero", 1,
      `${droplets.length} temporary event servers still exist even though the lifecycle is ${lifecycle.phase}. Run the provider-zero audit before considering billing stopped.`));
  }
  return findings;
}

export async function runCostReminderCycle({ manifest, lifecycle, droplets, snapshot, delivery, notifier, now = new Date() }) {
  const findings = evaluateCostReminders({ manifest, lifecycle, droplets, snapshot, now });
  const currentKeys = new Set(findings.map((entry) => entry.key));
  const notifications = { ...(delivery?.notifications ?? {}) };
  for (const key of Object.keys(notifications)) if (!currentKeys.has(key)) delete notifications[key];
  let sent = 0;
  for (const entry of findings) {
    const lastSentAtMs = Date.parse(notifications[entry.key]?.sentAt ?? "");
    if (Number.isFinite(lastSentAtMs) && now.getTime() - lastSentAtMs < RESEND_AFTER_MS) continue;
    await notifier.send({ title: "ScoreCheck cost reminder", message: entry.message, priority: entry.priority });
    notifications[entry.key] = { sentAt: now.toISOString() };
    sent += 1;
  }
  return {
    findings,
    sent,
    delivery: { schemaVersion: 1, event: manifest.event, checkedAt: now.toISOString(), notifications }
  };
}

function finding(key, priority, message) {
  return { key, priority, message };
}

function activeEgressCount(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.agents)) return 0;
  return snapshot.agents.reduce((total, agent) => {
    const count = Number(agent?.nativeServices?.egress?.activeWebRequests ?? 0);
    return total + (Number.isInteger(count) && count > 0 ? count : 0);
  }, 0);
}

async function readMonitorSnapshot(environment) {
  const base = required(environment, "MONITOR_PUBLIC_URL").replace(/\/+$/u, "");
  const response = await fetch(`${base}/v1/snapshot`, {
    headers: { Authorization: `Bearer ${required(environment, "MONITOR_API_TOKEN")}` },
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`monitor snapshot failed with HTTP ${response.status}`);
  return response.json();
}

async function readDeliveryState(path, event) {
  try {
    const value = await readProtectedJson(path, "cost reminder delivery state");
    if (value?.schemaVersion !== 1 || value.event !== event || !value.notifications || typeof value.notifications !== "object") {
      throw new Error("cost reminder delivery state is invalid");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, event, checkedAt: null, notifications: {} };
    throw error;
  }
}

async function readProtectedJson(path, label, protectedFile = true) {
  const information = await stat(path);
  if (!information.isFile() || (protectedFile && (information.mode & 0o077) !== 0)) {
    throw new Error(`${label} must be a ${protectedFile ? "protected " : ""}regular file`);
  }
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeProtectedJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function required(environment, name) {
  const value = environment?.[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--profile" || !isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1]) {
    throw new Error("usage: cost-reminders.mjs --profile /absolute/path/to/event-operator-profile.json");
  }
  return argv[1];
}
