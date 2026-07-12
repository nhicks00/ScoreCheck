#!/usr/bin/env node

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const configPath = process.env.MONITOR_CONFIG_FILE?.trim()
  || path.join(os.homedir(), ".config", "scorecheck", "monitoring.env");
const action = process.env.MONITOR_TARGET_ACTION?.trim() || "upsert";
const id = boundedId(required("MONITOR_TARGET_ID"));
if (!new Set(["upsert", "remove", "assign-courts"]).has(action)) throw new Error("MONITOR_TARGET_ACTION must be upsert, remove, or assign-courts.");

const original = await readFile(configPath, "utf8");
const current = parseTargets(readEnvValue(original, "MONITOR_AGENT_TARGETS"));
let next = current;
if (action === "upsert") {
  const role = roleValue(required("MONITOR_TARGET_ROLE"));
  const url = privateHttpUrl(required("MONITOR_TARGET_URL"));
  const token = required("MONITOR_TARGET_TOKEN");
  const assignedCourts = courtList(process.env.MONITOR_TARGET_COURTS?.trim() || "");
  if (token.length < 24) throw new Error("MONITOR_TARGET_TOKEN must contain at least 24 characters.");
  validateCourtOwnership(role, assignedCourts);
  next = [...current.filter((target) => target.id !== id), { id, role, url, token, assignedCourts }];
} else if (action === "remove") {
  next = current.filter((target) => target.id !== id);
} else {
  const existing = current.find((target) => target.id === id);
  if (!existing) throw new Error(`Monitoring target ${id} does not exist.`);
  const assignedCourts = courtList(required("MONITOR_TARGET_COURTS"));
  validateCourtOwnership(existing.role, assignedCourts);
  next = current.map((target) => target.id === id ? { ...target, assignedCourts } : target);
}
validateUniqueOwnership(next);
next.sort((left, right) => left.id.localeCompare(right.id));
const serialized = next.map((target) => `${target.id}|${target.role}|${target.url}|${target.token}|${target.assignedCourts.join("+")}`).join(",");
const updated = replaceEnvValue(original, "MONITOR_AGENT_TARGETS", JSON.stringify(serialized));
const temporary = `${configPath}.tmp-${process.pid}`;
await writeFile(temporary, updated, { encoding: "utf8", mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, configPath);
await chmod(configPath, 0o600);
console.log(`${action === "remove" ? "Removed" : action === "assign-courts" ? "Assigned courts for" : "Registered"} monitoring target ${id}; ${next.length} target(s) configured.`);

function parseTargets(raw) {
  if (!raw.trim()) return [];
  return raw.split(",").map((entry) => {
    const [targetId, role, url, token, courts = "", ...extra] = entry.split("|");
    if (extra.length || !targetId || !role || !url || !token) throw new Error("Existing MONITOR_AGENT_TARGETS is invalid.");
    const validatedRole = roleValue(role);
    const assignedCourts = courtList(courts);
    if (validatedRole !== "compositor" && assignedCourts.length > 0) throw new Error("Only compositor targets may own courts.");
    return { id: boundedId(targetId), role: validatedRole, url: privateHttpUrl(url), token, assignedCourts };
  });
}

function courtList(raw) {
  if (!raw) return [];
  const courts = raw.split("+").map((value) => Number(value));
  if (courts.some((court) => !Number.isInteger(court) || court < 1 || court > 8)) throw new Error("Court assignments must contain court numbers 1-8 joined with '+'.");
  return [...new Set(courts)].sort((left, right) => left - right);
}

function validateCourtOwnership(role, assignedCourts) {
  if (role === "compositor" && assignedCourts.length === 0) throw new Error("Compositor targets must own at least one court.");
  if (role !== "compositor" && assignedCourts.length > 0) throw new Error("Only compositor targets may own courts.");
}

function validateUniqueOwnership(targets) {
  const ids = targets.map((target) => target.id);
  if (new Set(ids).size !== ids.length) throw new Error("Monitoring target identifiers must be unique.");
  const courts = targets.flatMap((target) => target.assignedCourts);
  if (new Set(courts).size !== courts.length) throw new Error("A court may be assigned to only one compositor target.");
}

function readEnvValue(source, key) {
  const line = source.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  if (!line) throw new Error(`${key} is missing from ${configPath}.`);
  const raw = line.slice(key.length + 1).trim();
  if (!raw) return "";
  if (raw.startsWith('"')) return JSON.parse(raw);
  return raw.replace(/\\([\\|, ])/g, "$1");
}

function replaceEnvValue(source, key, value) {
  const expression = new RegExp(`^${key}=.*$`, "m");
  if (!expression.test(source)) throw new Error(`${key} is missing from ${configPath}.`);
  return source.replace(expression, `${key}=${value}`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedId(value) {
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(value)) throw new Error(`Invalid bounded identifier: ${value}`);
  return value;
}

function roleValue(value) {
  if (!["mediamtx", "commentary", "compositor", "worker", "venue", "observability"].includes(value)) throw new Error("Invalid monitoring target role.");
  return value;
}

function privateHttpUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Monitoring target must use HTTP(S).");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Monitoring target URL must not contain credentials, query, or fragment.");
  return parsed.toString().replace(/\/$/, "");
}
