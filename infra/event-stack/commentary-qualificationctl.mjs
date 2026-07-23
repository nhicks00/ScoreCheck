#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createPendingCommentaryQualification, loadCommentaryQualification, validateCommentaryQualification } from "./commentary-qualification.mjs";
import { validateProfile } from "./eventctl.mjs";
import { loadVenueAdmission } from "./venue-admission.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const result = options.command === "init" ? await initialize(options) : await install(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function initialize({ event, cameras, output }) {
  const qualification = createPendingCommentaryQualification(event, cameras);
  await assertProtectedParent(output, "commentary qualification output");
  await writeNewProtected(output, qualification);
  return { status: "PENDING", event, cameras, output, sha256: sha256(await readFile(output)) };
}

export async function install({ profile: profilePath, candidate: candidatePath, receipt: receiptPath }, { now = () => new Date() } = {}) {
  await assertProtectedParent(receiptPath, "commentary qualification receipt");
  let existingReceipt = null;
  try { existingReceipt = await readProtectedJson(receiptPath, "commentary qualification receipt"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const profile = validateProfile(await readProtectedJson(profilePath, "event operator profile"));
  const manifest = await readProtectedJson(profile.manifest, "event manifest");
  const lifecycle = await readProtectedJson(profile.state, "event lifecycle state");
  if (manifest.kind !== "production" || manifest.event !== lifecycle.event || lifecycle.phase !== "ready") {
    throw new Error("commentary qualification can be installed only on its ready production event before coverage");
  }
  if (!/^[A-Za-z0-9-]{8,100}$/u.test(lifecycle.generationId ?? "")) throw new Error("event lifecycle generation is invalid");
  const venue = await loadVenueAdmission(profile.venueProfile, manifest.event);
  if (!venue.passed) throw new Error(`venue profile is not admitted: ${venue.problems.join("; ")}`);
  await assertAbsent(join(profile.evidence, "production-soak-state.json"), "production soak state already exists");

  const root = dirname(profilePath);
  if (profile.commentaryQualification !== join(root, "commentary-qualification.json")) throw new Error("commentary qualification is outside its event bundle");
  const marker = await readProtectedJson(join(root, "BUNDLE.json"), "event bundle marker");
  if (marker.schemaVersion !== 2 || marker.kind !== "production" || marker.event !== manifest.event || !/^[a-f0-9]{64}$/u.test(marker.initialCommentaryQualificationSha256 ?? "")) {
    throw new Error("event bundle marker does not support post-provision commentary qualification");
  }

  const candidate = await loadCommentaryQualification(candidatePath, manifest.event, venue.activeCameras);
  if (!candidate.passed || candidate.qualification.status !== "QUALIFIED" || candidate.qualification.installation !== undefined) {
    throw new Error(`candidate commentary qualification did not pass: ${candidate.problems.join("; ") || "candidate already contains installation evidence"}`);
  }
  const current = await loadCommentaryQualification(profile.commentaryQualification, manifest.event, venue.activeCameras);
  let installed;
  if (current.qualification.status === "PENDING") {
    if (existingReceipt !== null) throw new Error("commentary qualification receipt already exists before installation");
    if (current.sha256 !== marker.initialCommentaryQualificationSha256) throw new Error("pending commentary qualification differs from the immutable bundle marker");
    installed = validateCommentaryQualification({
      ...candidate.qualification,
      installation: {
        installedAt: now().toISOString(),
        lifecycleGenerationId: lifecycle.generationId,
        sourceSha256: candidate.sha256
      }
    }, manifest.event, venue.activeCameras);
    await writeProtectedAtomic(profile.commentaryQualification, installed);
  } else {
    installed = current.qualification;
    if (installed.installation?.lifecycleGenerationId !== lifecycle.generationId || installed.installation?.sourceSha256 !== candidate.sha256) {
      throw new Error("a different commentary qualification is already installed");
    }
  }

  const verified = await loadCommentaryQualification(profile.commentaryQualification, manifest.event, venue.activeCameras, {
    requireInstalled: true,
    lifecycleGenerationId: lifecycle.generationId
  });
  if (!verified.passed) throw new Error(`installed commentary qualification did not pass: ${verified.problems.join("; ")}`);
  const receipt = {
    schemaVersion: 1,
    status: "PASS",
    event: manifest.event,
    lifecycleGenerationId: lifecycle.generationId,
    installedAt: installed.installation.installedAt,
    initialSha256: marker.initialCommentaryQualificationSha256,
    sourceSha256: candidate.sha256,
    installedSha256: verified.sha256,
    qualification: profile.commentaryQualification
  };
  if (existingReceipt !== null) {
    if (stableJson(existingReceipt) !== stableJson(receipt)) throw new Error("commentary qualification receipt already records a different cutover");
    return { ...receipt, receipt: receiptPath, idempotent: true };
  }
  await writeNewProtected(receiptPath, receipt);
  return { ...receipt, receipt: receiptPath, idempotent: false };
}

function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["init", "install"]).has(command)) throw new Error("first argument must be init or install");
  const values = { command };
  const mapping = command === "init"
    ? new Map([["--event", "event"], ["--cameras", "cameras"], ["--output", "output"]])
    : new Map([["--profile", "profile"], ["--candidate", "candidate"], ["--receipt", "receipt"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    values[key] = value;
  }
  for (const key of mapping.values()) if (!values[key]) throw new Error(`${key} is required`);
  if (values.cameras) values.cameras = parseCameras(values.cameras);
  for (const key of ["output", "profile", "candidate", "receipt"]) if (values[key]) values[key] = absolute(values[key], `--${key}`);
  return values;
}

function parseCameras(value) {
  if (!/^([1-8])(,[1-8]){0,7}$/u.test(value)) throw new Error("--cameras must be an ordered comma-separated subset of 1-8");
  const cameras = value.split(",").map(Number);
  if (cameras.some((camera, index) => index > 0 && camera <= cameras[index - 1])) throw new Error("--cameras must be unique and ordered");
  return cameras;
}

function absolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..")) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

async function readProtectedJson(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function assertProtectedParent(path, label) {
  const information = await stat(dirname(path));
  if (!information.isDirectory() || (information.mode & 0o077) !== 0) throw new Error(`${label} parent must be mode 0700 or stricter`);
}

async function assertAbsent(path, message) {
  try { await stat(path); throw new Error(message); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function writeNewProtected(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

async function writeProtectedAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function usage() {
  process.stdout.write("Usage:\n  commentary-qualificationctl.mjs init --event EVENT --cameras 1,2 --output /PROTECTED/pending.json\n  commentary-qualificationctl.mjs install --profile /PROTECTED/event-profile.json --candidate /PROTECTED/physical-qualification.json --receipt /PROTECTED/evidence/commentary-install.json\n");
}
