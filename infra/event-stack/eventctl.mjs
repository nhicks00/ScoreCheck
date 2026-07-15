#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DIRECTORY = dirname(fileURLToPath(import.meta.url));
const LIFECYCLE = resolve(DIRECTORY, "event-stack.mjs");
const COMMANDS = new Set(["plan", "up", "status", "start", "close", "evidence", "destroy"]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = await readProfile(options.profile);
  const args = buildEventctlInvocation(options.command, profile, options.confirm);
  const code = await run(process.execPath, [LIFECYCLE, ...args]);
  if (code !== 0) process.exitCode = code;
}

export function buildEventctlInvocation(command, profile, confirmation = null) {
  validateProfile(profile);
  if (!COMMANDS.has(command)) throw new Error(`unsupported event operator command ${command}`);
  const args = [command, "--manifest", profile.manifest, "--state", profile.state];
  if (command === "up") args.push(
    "--anchors", profile.anchors,
    "--secrets", profile.secrets,
    "--ssh-key", profile.sshKey,
    "--known-hosts", profile.knownHosts,
    "--credentials-env", profile.credentialsEnv
  );
  if (command === "status") args.push("--credentials-env", profile.credentialsEnv);
  if (command === "start") args.push(
    "--secrets", profile.secrets,
    "--ssh-key", profile.sshKey,
    "--known-hosts", profile.knownHosts
  );
  if (command === "evidence") args.push(
    "--secrets", profile.secrets,
    "--ssh-key", profile.sshKey,
    "--known-hosts", profile.knownHosts,
    "--credentials-env", profile.credentialsEnv,
    "--evidence", profile.evidence
  );
  if (command === "destroy") args.push(
    "--credentials-env", profile.credentialsEnv,
    "--evidence", profile.evidence
  );
  if (["start", "close", "destroy"].includes(command)) {
    if (!confirmation) throw new Error(`${command} requires an explicit --confirm value`);
    args.push("--confirm", confirmation);
  } else if (confirmation) {
    throw new Error(`${command} does not accept --confirm`);
  }
  return args;
}

export function validateProfile(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("event operator profile schemaVersion must be 1");
  const expected = ["manifest", "state", "anchors", "secrets", "sshKey", "knownHosts", "credentialsEnv", "evidence"];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["schemaVersion", ...expected].sort())) {
    throw new Error("event operator profile must contain exactly the supported fields");
  }
  for (const key of expected) {
    if (typeof value[key] !== "string" || !isAbsolute(value[key]) || resolve(value[key]) !== value[key]) {
      throw new Error(`event operator profile ${key} must be a normalized absolute path`);
    }
  }
  return value;
}

async function readProfile(path) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("event operator profile must be mode 0600 or stricter");
  return validateProfile(JSON.parse(await readFile(path, "utf8")));
}

function parseArgs(argv) {
  const command = argv[0];
  if (!COMMANDS.has(command)) throw new Error("first argument must be plan, up, status, start, close, evidence, or destroy");
  const options = { command, profile: null, confirm: null };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--profile") options.profile = absolute(value, flag);
    else if (flag === "--confirm") options.confirm = value;
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
