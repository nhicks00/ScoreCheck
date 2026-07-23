#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const LIFECYCLE = resolve(DIRECTORY, "event-stack.mjs");
const COMMANDS = new Set(["plan", "up", "status", "start", "close", "evidence", "destroy", "abort"]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = await readProfile(options.profile);
  const args = buildEventctlInvocation(options.command, profile, options.confirm, options.sameDayConfirm);
  const code = await run(process.execPath, [LIFECYCLE, ...args]);
  if (code !== 0) process.exitCode = code;
}

export function buildEventctlInvocation(command, profile, confirmation = null, sameDayConfirm = null) {
  validateProfile(profile);
  if (!COMMANDS.has(command)) throw new Error(`unsupported event operator command ${command}`);
  const args = [command, "--manifest", profile.manifest, "--state", profile.state];
  if (command === "up") args.push(
    "--anchors", profile.anchors,
    "--secrets", profile.secrets,
    "--ssh-key", profile.sshKey,
    "--known-hosts", profile.knownHosts,
    "--commentary-tls-state", profile.commentaryTlsState,
    "--ingest-tls-state", profile.ingestTlsState,
    "--observability-tls-state", profile.observabilityTlsState,
    "--credentials-env", profile.credentialsEnv,
    "--attestation", profile.lifecycleAttestation
  );
  if (command === "status") args.push("--credentials-env", profile.credentialsEnv);
  if (command === "start") args.push(
    "--secrets", profile.secrets,
    "--ssh-key", profile.sshKey,
    "--known-hosts", profile.knownHosts,
    "--commentary-tls-state", profile.commentaryTlsState,
    "--ingest-tls-state", profile.ingestTlsState,
    "--observability-tls-state", profile.observabilityTlsState,
    "--credentials-env", profile.credentialsEnv
  );
  if (command === "evidence") args.push(
    "--secrets", profile.secrets,
    "--ssh-key", profile.sshKey,
    "--known-hosts", profile.knownHosts,
    "--commentary-tls-state", profile.commentaryTlsState,
    "--ingest-tls-state", profile.ingestTlsState,
    "--observability-tls-state", profile.observabilityTlsState,
    "--credentials-env", profile.credentialsEnv,
    "--evidence", profile.evidence
  );
  if (command === "evidence" && profile.rehearsalEvidence !== null) args.push("--rehearsal-evidence", profile.rehearsalEvidence);
  if (["destroy", "abort"].includes(command)) args.push(
    "--secrets", profile.secrets,
    "--ssh-key", profile.sshKey,
    "--known-hosts", profile.knownHosts,
    "--commentary-tls-state", profile.commentaryTlsState,
    "--ingest-tls-state", profile.ingestTlsState,
    "--observability-tls-state", profile.observabilityTlsState,
    "--credentials-env", profile.credentialsEnv,
    "--evidence", profile.evidence
  );
  if (command === "abort" && profile.rehearsalEvidence !== null) args.push("--rehearsal-evidence", profile.rehearsalEvidence);
  if (["start", "close", "destroy", "abort"].includes(command)) {
    if (!confirmation) throw new Error(`${command} requires an explicit --confirm value`);
    args.push("--confirm", confirmation);
  } else if (confirmation) {
    throw new Error(`${command} does not accept --confirm`);
  }
  if (sameDayConfirm !== null) {
    if (command !== "destroy") throw new Error(`${command} does not accept --same-day-confirm`);
    args.push("--same-day-confirm", sameDayConfirm);
  }
  return args;
}

export function validateProfile(value) {
  if (!value || value.schemaVersion !== 9) throw new Error("event operator profile schemaVersion must be 9");
  const expected = ["manifest", "state", "anchors", "secrets", "sshKey", "knownHosts", "commentaryTlsState", "ingestTlsState", "observabilityTlsState", "credentialsEnv", "lifecycleAttestation", "rendererBinding", "venueProfile", "commentaryQualification", "evidence", "rehearsalEvidence"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["schemaVersion", ...expected].sort())) {
    throw new Error("event operator profile must contain exactly the supported fields");
  }
  for (const key of expected.filter((key) => !["rendererBinding", "rehearsalEvidence"].includes(key))) {
    if (typeof value[key] !== "string" || !isAbsolute(value[key]) || resolve(value[key]) !== value[key]) {
      throw new Error(`event operator profile ${key} must be a normalized absolute path`);
    }
  }
  if (value.rendererBinding !== null && (typeof value.rendererBinding !== "string" || !isAbsolute(value.rendererBinding) || resolve(value.rendererBinding) !== value.rendererBinding)) throw new Error("event operator profile rendererBinding must be null or a normalized absolute path");
  if (value.rehearsalEvidence !== null && (typeof value.rehearsalEvidence !== "string" || !isAbsolute(value.rehearsalEvidence) || resolve(value.rehearsalEvidence) !== value.rehearsalEvidence)) throw new Error("event operator profile rehearsalEvidence must be null or a normalized absolute path");
  return value;
}

async function readProfile(path) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("event operator profile must be mode 0600 or stricter");
  return validateProfile(JSON.parse(await readFile(path, "utf8")));
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) throw new Error("first argument must be plan, up, status, start, close, evidence, destroy, or abort");
  const options = { command, profile: null, confirm: null, sameDayConfirm: null };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--profile") options.profile = absolute(value, flag);
    else if (flag === "--confirm") options.confirm = value;
    else if (flag === "--same-day-confirm") options.sameDayConfirm = value;
    else throw new Error(`unknown event operator option ${flag}`);
  }
  if (!options.profile) throw new Error("--profile is required");
  return options;
}

function absolute(value, flag) {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return resolve(value);
}

async function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("close", resolvePromise);
  });
}
