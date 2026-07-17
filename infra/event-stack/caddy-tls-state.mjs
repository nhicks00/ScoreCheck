import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const MARKER = "TLS_STATE_COMPLETE.json";
const MINIMUM_REMAINING_VALIDITY_MS = 24 * 60 * 60 * 1_000;

export class CaddyTlsStateStore {
  constructor({ directory, sshPrivateKey, knownHostsPath, runner, now = () => new Date(), remoteDirectory = "/opt/livekit" }) {
    this.directory = protectedAbsolute(directory, "Caddy TLS state directory");
    this.sshPrivateKey = protectedAbsolute(sshPrivateKey, "SSH private key");
    this.knownHostsPath = protectedAbsolute(knownHostsPath, "known_hosts path");
    if (typeof runner !== "function") throw new Error("Caddy TLS state runner is required");
    if (!/^\/[A-Za-z0-9._/-]+$/u.test(remoteDirectory) || remoteDirectory.includes("..")) throw new Error("Caddy remote directory is invalid");
    this.runner = runner;
    this.now = now;
    this.remoteDirectory = remoteDirectory;
  }

  async inspect(hosts, { allowMissing = false } = {}) {
    return inspectCaddyTlsState({ directory: this.directory, hosts, now: this.now(), allowMissing });
  }

  async restore({ publicIpv4, hosts }) {
    const state = await this.inspect(hosts, { allowMissing: true });
    if (state.status === "missing") return state;
    const stage = `${this.remoteDirectory}/.caddy-data-restore`;
    await this.#ssh(publicIpv4, `install -d -m 0750 '${this.remoteDirectory}' && rm -rf '${stage}' && install -d -m 0700 '${stage}'`);
    try {
      await this.#rsync(`${join(this.directory, "data")}/`, `root@${publicIpv4}:${stage}/`);
      await this.#ssh(publicIpv4, `rm -rf '${this.remoteDirectory}/caddy_data' && mv '${stage}' '${this.remoteDirectory}/caddy_data' && chmod 0700 '${this.remoteDirectory}/caddy_data'`);
    } catch (error) {
      await this.#ssh(publicIpv4, `rm -rf '${stage}'`, { allowFailure: true });
      throw error;
    }
    return { ...state, status: "restored" };
  }

  async capture({ publicIpv4, hosts }) {
    const parent = dirname(this.directory);
    await ensureProtectedDirectory(parent);
    const temporary = `${this.directory}.capture-${process.pid}-${randomUUID()}`;
    const data = join(temporary, "data");
    await mkdir(data, { recursive: true, mode: 0o700 });
    try {
      await this.#rsync(`root@${publicIpv4}:${this.remoteDirectory}/caddy_data/`, `${data}/`);
      await hardenTree(data);
      const observed = await inspectData({ data, hosts, now: this.now() });
      const marker = {
        schemaVersion: 1,
        hosts: normalizedHosts(hosts),
        capturedAt: this.now().toISOString(),
        files: observed.files,
        certificates: observed.certificates
      };
      await writeFile(join(temporary, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await chmod(join(temporary, MARKER), 0o600);
      await replaceDirectory(this.directory, temporary);
      return await this.inspect(hosts);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async #ssh(ip, command, options = {}) {
    assertIpv4(ip);
    return this.runner("ssh", [
      "-i", this.sshPrivateKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
      "-o", "ConnectTimeout=10",
      `root@${ip}`,
      command
    ], { capture: true, ...options });
  }

  async #rsync(source, destination) {
    const shell = [
      "ssh",
      "-i", shellQuote(this.sshPrivateKey),
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", shellQuote(`UserKnownHostsFile=${this.knownHostsPath}`),
      "-o", "ConnectTimeout=10"
    ].join(" ");
    return this.runner("rsync", ["-a", "--delete", "-e", shell, source, destination], { capture: true });
  }
}

export async function inspectCaddyTlsState({ directory, hosts, now = new Date(), allowMissing = false }) {
  const root = protectedAbsolute(directory, "Caddy TLS state directory");
  let information;
  try { information = await stat(root); }
  catch (error) {
    if (allowMissing && error?.code === "ENOENT") return { status: "missing", hosts: normalizedHosts(hosts) };
    throw error;
  }
  if (!information.isDirectory() || (information.mode & 0o077) !== 0) throw new Error("Caddy TLS state directory must be mode 0700 or stricter");
  const markerPath = join(root, MARKER);
  const markerInfo = await stat(markerPath);
  if (!markerInfo.isFile() || (markerInfo.mode & 0o077) !== 0) throw new Error("Caddy TLS state marker must be mode 0600 or stricter");
  let marker;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); }
  catch { throw new Error("Caddy TLS state marker is invalid JSON"); }
  if (marker.schemaVersion !== 1 || JSON.stringify(marker.hosts) !== JSON.stringify(normalizedHosts(hosts))) {
    throw new Error("Caddy TLS state endpoint binding is invalid");
  }
  const observed = await inspectData({ data: join(root, "data"), hosts, now });
  if (stableJson(marker.files) !== stableJson(observed.files)) throw new Error("Caddy TLS state file integrity verification failed");
  if (stableJson(marker.certificates) !== stableJson(observed.certificates)) throw new Error("Caddy TLS state certificate evidence changed");
  return {
    status: "ready",
    hosts: marker.hosts,
    capturedAt: marker.capturedAt,
    fileCount: Object.keys(marker.files).length,
    stateSha256: sha256(stableJson({ hosts: marker.hosts, files: marker.files, certificates: marker.certificates })),
    certificates: marker.certificates
  };
}

async function inspectData({ data, hosts, now }) {
  const values = normalizedHosts(hosts);
  const files = await collectFiles(data);
  if (files.length === 0) throw new Error("Caddy TLS state contains no files");
  const digests = {};
  const certificates = [];
  for (const path of files) {
    const name = relative(data, path).replaceAll("\\", "/");
    const body = await readFile(path);
    digests[name] = sha256(body);
    if (!/\.(?:crt|pem)$/iu.test(name)) continue;
    try {
      const certificate = new X509Certificate(body);
      certificates.push(certificate);
    } catch {}
  }
  const minimum = now.getTime() + MINIMUM_REMAINING_VALIDITY_MS;
  const binding = {};
  for (const host of values) {
    const matches = certificates
      .filter((certificate) => certificate.checkHost(host) === host && Date.parse(certificate.validFrom) <= now.getTime() + 300_000 && Date.parse(certificate.validTo) >= minimum)
      .sort((left, right) => Date.parse(right.validTo) - Date.parse(left.validTo));
    if (matches.length === 0) throw new Error(`Caddy TLS state has no certificate with at least 24 hours remaining for ${host}`);
    binding[host] = { validTo: new Date(matches[0].validTo).toISOString(), fingerprint256: matches[0].fingerprint256 };
  }
  return { files: Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right))), certificates: binding };
}

async function collectFiles(root) {
  const information = await lstat(root);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error("Caddy TLS data root is invalid");
  const output = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const child = await lstat(path);
    if (child.isSymbolicLink()) throw new Error("Caddy TLS state cannot contain symbolic links");
    if (child.isDirectory()) output.push(...await collectFiles(path));
    else if (child.isFile()) output.push(path);
    else throw new Error("Caddy TLS state contains an unsupported filesystem entry");
  }
  return output;
}

async function hardenTree(root) {
  const information = await lstat(root);
  if (information.isSymbolicLink()) throw new Error("Caddy TLS state cannot contain symbolic links");
  if (information.isDirectory()) {
    await chmod(root, 0o700);
    for (const name of await readdir(root)) await hardenTree(join(root, name));
  } else if (information.isFile()) await chmod(root, 0o600);
  else throw new Error("Caddy TLS state contains an unsupported filesystem entry");
}

async function replaceDirectory(target, temporary) {
  const backup = `${target}.previous-${process.pid}-${randomUUID()}`;
  let hadPrevious = false;
  try {
    await rename(target, backup);
    hadPrevious = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(temporary, target);
    await chmod(target, 0o700);
    if (hadPrevious) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadPrevious) await rename(backup, target).catch(() => {});
    throw error;
  }
}

async function ensureProtectedDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const information = await stat(path);
  if (!information.isDirectory() || (information.mode & 0o077) !== 0) throw new Error("Caddy TLS state parent must be protected");
}

function normalizedHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 4 || new Set(hosts).size !== hosts.length || hosts.some((host) => typeof host !== "string" || !/^[a-z0-9.-]+$/u.test(host))) {
    throw new Error("Caddy TLS state requires one to four unique DNS hosts");
  }
  return [...hosts].sort();
}

function protectedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..")) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function assertIpv4(value) {
  if (typeof value !== "string" || value.split(".").length !== 4 || value.split(".").some((part) => !/^\d{1,3}$/u.test(part) || Number(part) > 255)) throw new Error("Caddy TLS state target must be an IPv4 address");
}

function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
