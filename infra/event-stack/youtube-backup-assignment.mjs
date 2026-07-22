import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const STREAM_KEY = /^[A-Za-z0-9_-]{8,256}$/u;

export class YoutubeBackupAssignmentRuntime {
  constructor({ sshKey, knownHosts, runner = runCommand }) {
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.runner = runner;
  }

  async stage({ host, event, generation, court, stream }) {
    validateHost(host);
    const assignment = createYoutubeBackupAssignment({ event, generation, court, stream });
    const existing = await this.#remote(host, `cd /opt/compositor && if test -e ${assignment.remotePath}; then test "$(openssl dgst -sha256 -r ${assignment.remotePath} | awk '{print $1}')" = ${assignment.sha256}; else exit 3; fi`, { allowFailure: true });
    if (existing.code === 0) return publicAssignment(assignment);
    if (existing.code !== 3) throw new Error("existing YouTube backup assignment does not match this gate");
    const directory = await mkdtemp(join(tmpdir(), "scorecheck-youtube-backup-"));
    const localPath = join(directory, "assignment.env");
    const temporaryRemotePath = `${assignment.remotePath}.stage-${assignment.id}`;
    try {
      await writeFile(localPath, assignment.content, { mode: 0o600, flag: "wx" });
      await this.#remote(host, `cd /opt/compositor && mkdir -p requests && test ! -e ${assignment.remotePath} && rm -f ${temporaryRemotePath}`);
      await this.#copy(host, localPath, `/opt/compositor/${temporaryRemotePath}`);
      await this.#remote(host, `cd /opt/compositor && test "$(openssl dgst -sha256 -r ${temporaryRemotePath} | awk '{print $1}')" = ${assignment.sha256} && chmod 600 ${temporaryRemotePath} && mv ${temporaryRemotePath} ${assignment.remotePath}`);
      await this.verify({ host, assignment });
      return publicAssignment(assignment);
    } catch (error) {
      await this.#remote(host, `cd /opt/compositor && rm -f ${temporaryRemotePath}`, { allowFailure: true }).catch(() => {});
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async verify({ host, assignment: input }) {
    validateHost(host);
    const assignment = validatePublicAssignment(input);
    await this.#remote(host, `cd /opt/compositor && test -f ${assignment.remotePath} && test "$(openssl dgst -sha256 -r ${assignment.remotePath} | awk '{print $1}')" = ${assignment.sha256}`);
    return assignment;
  }

  async cleanup({ host, assignment: input }) {
    validateHost(host);
    const assignment = validatePublicAssignment(input);
    const result = await this.#remote(host, `cd /opt/compositor && if test -e ${assignment.remotePath}; then test "$(openssl dgst -sha256 -r ${assignment.remotePath} | awk '{print $1}')" = ${assignment.sha256} && rm ${assignment.remotePath}; fi`);
    return { ...assignment, removed: result.code === 0 };
  }

  async #remote(host, command, { allowFailure = false } = {}) {
    return this.runner("ssh", [
      "-i", this.sshKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ], { allowFailure });
  }

  async #copy(host, localPath, remotePath) {
    return this.runner("scp", [
      "-q",
      "-i", this.sshKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      localPath,
      `root@${host}:${remotePath}`
    ]);
  }
}

export function createYoutubeBackupAssignment({ event, generation, court, stream }) {
  validateIdentifier(event, "event");
  validateIdentifier(generation, "generation");
  validateCourt(court);
  if (!stream || stream.court !== court || !SAFE_ID.test(stream.id ?? "") || !STREAM_KEY.test(stream.streamName ?? "")) {
    throw new Error("YouTube backup stream identity is invalid");
  }
  const primary = validateRtmps(stream.rtmpsIngestionAddress, "primary RTMPS address");
  const backup = validateRtmps(stream.rtmpsBackupIngestionAddress, "backup RTMPS address");
  if (primary === backup) throw new Error("YouTube primary and backup RTMPS addresses must differ");
  const content = `YOUTUBE_BACKUP_RTMPS_BASE=${backup}\nCOURT_${court}_YOUTUBE_KEY=${stream.streamName}\n`;
  const sha256 = createHash("sha256").update(content).digest("hex");
  const id = createHash("sha256").update(`${event}:${generation}:${court}:${stream.id}:${sha256}`).digest("hex").slice(0, 20);
  return {
    schemaVersion: 1,
    event,
    generation,
    court,
    streamId: stream.id,
    id,
    sha256,
    remotePath: `requests/court-${court}.backup.env`,
    content
  };
}

function publicAssignment(value) {
  const { content: _content, ...result } = value;
  return result;
}

function validatePublicAssignment(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("YouTube backup assignment is invalid");
  validateIdentifier(value.event, "event");
  validateIdentifier(value.generation, "generation");
  validateCourt(value.court);
  validateIdentifier(value.streamId, "stream id");
  if (!/^[a-f0-9]{20}$/u.test(value.id ?? "") || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? "") || value.remotePath !== `requests/court-${value.court}.backup.env`) {
    throw new Error("YouTube backup assignment is invalid");
  }
  return value;
}

function validateRtmps(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`YouTube ${label} is invalid`); }
  if (parsed.protocol !== "rtmps:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`YouTube ${label} is invalid`);
  return parsed.toString().replace(/\/$/u, "");
}

function validateHost(value) {
  if (!IPV4.test(value ?? "")) throw new Error("YouTube backup compositor host must be an IPv4 address");
}

function validateCourt(value) {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error("YouTube backup court must be from 1 through 8");
}

function validateIdentifier(value, label) {
  if (!SAFE_ID.test(value ?? "")) throw new Error(`YouTube backup ${label} is invalid`);
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

async function runCommand(command, args, { allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolvePromise({ code, stdout, stderr });
      else reject(new Error(`${basename(command)} failed with exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`));
    });
  });
}
