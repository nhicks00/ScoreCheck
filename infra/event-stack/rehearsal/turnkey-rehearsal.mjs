#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EVENTCTL = resolve(DIRECTORY, "../eventctl.mjs");
const REHEARSALCTL = resolve(DIRECTORY, "rehearsal-stack.mjs");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const [eventProfile, rehearsalProfile] = await Promise.all([readProtectedJson(options.eventProfile), readProtectedJson(options.rehearsalProfile)]);
  validateProfileBinding(eventProfile, rehearsalProfile);
  const manifest = await readProtectedJson(eventProfile.manifest);
  if (manifest.kind !== "rehearsal") throw new Error("turnkey rehearsal requires a rehearsal manifest");
  if (options.confirm !== `FULL-DRY-RUN:${manifest.event}`) throw new Error(`confirmation must be exactly FULL-DRY-RUN:${manifest.event}`);
  const initialPhases = await currentPhases(eventProfile.state, rehearsalProfile.rehearsalState);
  const report = { schemaVersion: 1, event: manifest.event, startedAt: new Date().toISOString(), endedAt: null, classification: "RUNNING", initialPhases, steps: [], recovery: [], error: null };
  try {
    for (const step of buildRunPlan({ event: manifest.event, eventProfile: options.eventProfile, rehearsalProfile: options.rehearsalProfile, ...initialPhases })) {
      await executeStep(step, report.steps);
    }
    report.classification = "PASS";
  } catch (error) {
    report.classification = "FAIL";
    report.error = safeError(error);
    try {
      const phases = await currentPhases(eventProfile.state, rehearsalProfile.rehearsalState);
      for (const step of buildRecoveryPlan({ ...phases, event: manifest.event, eventProfile: options.eventProfile, rehearsalProfile: options.rehearsalProfile })) {
        await executeStep(step, report.recovery);
      }
    } catch (recoveryError) {
      report.classification = "CLEANUP_BLOCKED";
      report.recoveryError = safeError(recoveryError);
    }
  } finally {
    report.endedAt = new Date().toISOString();
    await writeAtomicProtected(options.report, report);
  }
  process.stdout.write(`${JSON.stringify({ event: report.event, classification: report.classification, startedAt: report.startedAt, endedAt: report.endedAt, report: options.report }, null, 2)}\n`);
  if (report.classification !== "PASS") process.exitCode = 1;
}

export function buildRunPlan({ event, eventProfile, rehearsalProfile, lifecyclePhase = "planned", rehearsalPhase = null }) {
  if (["aborting", "aborted"].includes(lifecyclePhase)) throw new Error(`cannot resume a rehearsal whose lifecycle is ${lifecyclePhase}`);
  if (lifecyclePhase === "destroyed") throw new Error("rehearsal lifecycle is already destroyed; inspect its sealed report instead of creating a new PASS");

  const steps = [];
  if (lifecyclePhase === "destroying") return [eventStep("destroy", eventProfile, `DESTROY:${event}`)];

  if (lifecyclePhase === "planned") steps.push(eventStep("plan", eventProfile));
  if (rehearsalPhase === null) {
    steps.push(rehearsalStep("plan", rehearsalProfile));
    rehearsalPhase = "planned";
  }
  if (["planned", "preparing"].includes(rehearsalPhase)) {
    steps.push(rehearsalStep("prepare", rehearsalProfile, `PREPARE:${event}`));
    rehearsalPhase = "prepared";
  }
  if (["planned", "provisioning"].includes(lifecyclePhase)) {
    steps.push(eventStep("up", eventProfile));
    lifecyclePhase = "ready";
  }
  if (lifecyclePhase === "ready") {
    steps.push(eventStep("start", eventProfile, `START:${event}`));
    lifecyclePhase = "live";
  }
  if (["prepared", "starting"].includes(rehearsalPhase)) {
    steps.push(rehearsalStep("start", rehearsalProfile, `START-REHEARSAL:${event}`));
    rehearsalPhase = "running";
  }
  if (rehearsalPhase === "running") {
    steps.push(rehearsalStep("soak", rehearsalProfile));
    steps.push(rehearsalStep("stop", rehearsalProfile));
    rehearsalPhase = "stopped";
  } else if (rehearsalPhase === "stopping") {
    steps.push(rehearsalStep("stop", rehearsalProfile));
    rehearsalPhase = "stopped";
  }
  if (lifecyclePhase === "live" && rehearsalPhase === "stopped") {
    steps.push(eventStep("close", eventProfile, `CLOSE:${event}`));
    lifecyclePhase = "closed";
  }
  if (lifecyclePhase === "closed" && ["stopped", "cleaning"].includes(rehearsalPhase)) {
    steps.push(rehearsalStep("cleanup", rehearsalProfile, `CLEANUP:${event}`));
    rehearsalPhase = "cleaned";
  }
  if (lifecyclePhase === "closed" && rehearsalPhase === "cleaned") {
    steps.push(rehearsalStep("seal", rehearsalProfile));
    steps.push(eventStep("evidence", eventProfile));
    steps.push(eventStep("destroy", eventProfile, `DESTROY:${event}`));
    return steps;
  }
  throw new Error(`unsupported resumable rehearsal state lifecycle=${lifecyclePhase}, rehearsal=${rehearsalPhase}`);
}

export function buildRecoveryPlan({ event, eventProfile, rehearsalProfile, lifecyclePhase, rehearsalPhase }) {
  const steps = [];
  if (rehearsalPhase === null && ["planned", "provisioning", "ready"].includes(lifecyclePhase)) {
    steps.push(rehearsalStep("plan", rehearsalProfile));
    rehearsalPhase = "planned";
  }
  if (["starting", "running", "stopping"].includes(rehearsalPhase)) steps.push(rehearsalStep("stop", rehearsalProfile));
  if (lifecyclePhase === "live") {
    steps.push(eventStep("close", eventProfile, `CLOSE:${event}`));
    lifecyclePhase = "closed";
  }
  if (["planned", "preparing", "prepared", "starting", "running", "stopping", "stopped", "cleaning"].includes(rehearsalPhase)) steps.push(rehearsalStep("cleanup", rehearsalProfile, `CLEANUP:${event}`));
  if (rehearsalPhase !== null && rehearsalPhase !== "cleaned") rehearsalPhase = "cleaned";
  if (rehearsalPhase === "cleaned") steps.push(rehearsalStep("seal", rehearsalProfile));
  if (lifecyclePhase === "closed") {
    steps.push(eventStep("evidence", eventProfile));
    steps.push(eventStep("destroy", eventProfile, `DESTROY:${event}`));
  } else if (lifecyclePhase === "destroying") {
    steps.push(eventStep("destroy", eventProfile, `DESTROY:${event}`));
  } else if (["planned", "provisioning", "ready", "aborting"].includes(lifecyclePhase)) {
    steps.push(eventStep("abort", eventProfile, `ABORT:${event}`));
  }
  return steps;
}

function eventStep(command, profile, confirmation = null) { return commandStep("lifecycle", EVENTCTL, command, profile, confirmation); }
function rehearsalStep(command, profile, confirmation = null) { return commandStep("rehearsal", REHEARSALCTL, command, profile, confirmation); }
function commandStep(system, script, command, profile, confirmation) {
  return { system, command, executable: process.execPath, args: [script, command, "--profile", profile, ...(confirmation ? ["--confirm", confirmation] : [])] };
}

async function executeStep(step, log) {
  const entry = { system: step.system, command: step.command, startedAt: new Date().toISOString(), endedAt: null, status: "running" };
  log.push(entry);
  try {
    await run(step.executable, step.args);
    entry.status = "passed";
  } catch (error) {
    entry.status = "failed";
    entry.error = safeError(error);
    throw error;
  } finally { entry.endedAt = new Date().toISOString(); }
}

async function currentPhases(lifecyclePath, rehearsalPath) {
  return {
    lifecyclePhase: (await readJsonOrNull(lifecyclePath))?.phase ?? null,
    rehearsalPhase: (await readJsonOrNull(rehearsalPath))?.phase ?? null
  };
}

function validateProfileBinding(eventProfile, rehearsalProfile) {
  if (eventProfile.schemaVersion !== 3 || rehearsalProfile.schemaVersion !== 1) throw new Error("operator profile schemas are incompatible");
  if (eventProfile.manifest !== rehearsalProfile.manifest || eventProfile.state !== rehearsalProfile.lifecycleState || eventProfile.secrets !== rehearsalProfile.secrets || eventProfile.rehearsalEvidence !== rehearsalProfile.rehearsalEvidence) throw new Error("event and rehearsal profiles do not bind the same manifest, lifecycle state, secrets, and rehearsal evidence");
}

function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (command !== "full-dry-run") throw new Error("only full-dry-run is supported");
  const options = { eventProfile: null, rehearsalProfile: null, report: null, confirm: null };
  const map = new Map([["--event-profile", "eventProfile"], ["--rehearsal-profile", "rehearsalProfile"], ["--report", "report"], ["--confirm", "confirm"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    const key = map.get(flag);
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is invalid or missing a value`);
    options[key] = key === "confirm" ? value : normalizedAbsolute(value, flag);
  }
  for (const key of ["eventProfile", "rehearsalProfile", "report", "confirm"]) if (!options[key]) throw new Error(`${key} is required`);
  return options;
}

async function readProtectedJson(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`${path} must be a protected file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function writeAtomicProtected(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..")) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function safeError(error) { return { message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) }; }

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${args[1] ?? command} failed with exit ${code}`)));
  });
}

function usage() {
  process.stdout.write("Usage: node infra/event-stack/rehearsal/turnkey-rehearsal.mjs full-dry-run --event-profile FILE --rehearsal-profile FILE --report FILE --confirm FULL-DRY-RUN:EVENT\n");
}
