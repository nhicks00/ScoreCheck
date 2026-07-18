import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { COURTS, SyntheticPublisherHealthError, SyntheticPublisherManager, buildSyntheticPublisherConfig } from "./synthetic-publishers.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_SCRIPT = resolve(SCRIPT_DIRECTORY, "spare-host-publisher-snapshot.py");
const SOURCE_IMAGE = "bluenviron/mediamtx:1.19.2-ffmpeg@sha256:08c837deb7bac85d509e2a4c2737308e5a34f8f084a46a0d8793cdb0579a6e5d";
const MARKER = /^scorecheck-rehearsal-([a-zA-Z0-9-]{8,80})-camera-([1-8])$/u;
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const FRESHNESS_MS = 5_000;

export function sparePublisherHost(manifest, lifecycleState) {
  const spare = manifest?.droplets?.filter((entry) => entry.role === "compositor-spare") ?? [];
  if (spare.length !== 1) throw new Error("synthetic source requires exactly one compositor spare");
  const host = lifecycleState?.droplets?.[spare[0].name]?.publicIpv4;
  if (!IPV4.test(host ?? "")) throw new Error("synthetic source spare has no valid public IPv4");
  return { host, providerName: spare[0].providerName, role: "compositor-spare" };
}

export function buildSpareHostSyntheticPublisherConfig(options) {
  const base = buildSyntheticPublisherConfig(options);
  const sourceHost = options.sourceHost;
  const sourceProviderName = options.sourceProviderName;
  if (!IPV4.test(sourceHost ?? "")) throw new Error("synthetic publisher source host is invalid");
  if (typeof sourceProviderName !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(sourceProviderName)) throw new Error("synthetic publisher source provider name is invalid");
  const identity = markerIdentity(base.marker);
  const remoteRoot = `/opt/scorecheck-rehearsal/${identity.generationId}`;
  const remoteFixturePath = `${remoteRoot}/camera-${base.court}.fixture.mkv`;
  const remoteProgressPath = `${remoteRoot}/camera-${base.court}.progress`;
  const remoteRunnerPath = `${remoteRoot}/camera-${base.court}.run.sh`;
  const remoteEnvironmentPath = `${remoteRoot}/camera-${base.court}.env`;
  const remoteMetadataPath = `${remoteRoot}/camera-${base.court}.metadata.json`;
  const remoteSnapshotPath = `${remoteRoot}/publisher-snapshot.py`;
  const sourceUnit = `${base.marker}.service`;
  const sourceContainer = base.marker;
  const remoteArgs = base.args.map((value) => value === base.fixturePath
    ? remoteFixturePath
    : value === base.progressPath ? remoteProgressPath : value);
  if (remoteArgs.at(-1) !== base.outputUrl) throw new Error("synthetic publisher output argument is not terminal");
  const runnerContent = [
    "#!/bin/sh",
    "set -eu",
    `exec ffmpeg ${remoteArgs.slice(0, -1).map(shellQuote).join(" ")} \"$OUTPUT_URL\"`,
    ""
  ].join("\n");
  const metadata = {
    schemaVersion: 1,
    court: base.court,
    marker: base.marker,
    unit: sourceUnit,
    container: sourceContainer,
    progressPath: remoteProgressPath
  };
  const localRunnerPath = resolve(dirname(base.supervisorConfigPath), `camera-${base.court}.remote-runner.sh`);
  const localEnvironmentPath = resolve(dirname(base.supervisorConfigPath), `camera-${base.court}.remote.env`);
  const localMetadataPath = resolve(dirname(base.supervisorConfigPath), `camera-${base.court}.remote-metadata.json`);
  return {
    ...base,
    executionMode: "compositor-spare",
    sourceHost,
    sourceProviderName,
    sourceImage: SOURCE_IMAGE,
    sourceUnit,
    sourceContainer,
    remoteRoot,
    remoteFixturePath,
    remoteProgressPath,
    remoteRunnerPath,
    remoteEnvironmentPath,
    remoteMetadataPath,
    remoteSnapshotPath,
    localRunnerPath,
    localEnvironmentPath,
    localMetadataPath,
    runnerContent,
    environmentContent: `OUTPUT_URL=${base.outputUrl}\n`,
    metadata,
    redacted: {
      ...base.redacted,
      executionMode: "compositor-spare",
      sourceHost,
      sourceProviderName,
      sourceImage: SOURCE_IMAGE,
      sourceUnit,
      sourceContainer,
      remoteRoot,
      remoteProgressPath
    }
  };
}

export class SpareHostSyntheticPublisherManager {
  constructor({ sourceHost, sshKey, knownHosts, runner = runCommand, localManager = null, sleep = delay, now = () => Date.now() }) {
    this.sourceHost = requiredIpv4(sourceHost);
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.runner = runner;
    this.localManager = localManager ?? new SyntheticPublisherManager();
    this.sleep = sleep;
    this.now = now;
  }

  async preflight(ffmpegPath) {
    await this.localManager.preflight(ffmpegPath);
    await this.#remote("command -v docker >/dev/null && command -v systemd-run >/dev/null && command -v python3 >/dev/null");
    await this.#remote(`/usr/bin/docker pull ${shellQuote(SOURCE_IMAGE)} >/dev/null && /usr/bin/docker image inspect ${shellQuote(SOURCE_IMAGE)} >/dev/null`);
    return { healthy: true, executionMode: "compositor-spare", sourceHost: this.sourceHost, sourceImage: SOURCE_IMAGE };
  }

  async prepare(config) {
    validateRemoteConfig(config, this.sourceHost);
    const fixture = await this.localManager.prepare(config);
    await mkdir(dirname(config.localRunnerPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(config.localRunnerPath), 0o700);
    await writeFile(config.localRunnerPath, config.runnerContent, { mode: 0o700 });
    await writeFile(config.localEnvironmentPath, config.environmentContent, { mode: 0o600 });
    await writeFile(config.localMetadataPath, `${JSON.stringify(config.metadata, null, 2)}\n`, { mode: 0o600 });
    await Promise.all([
      chmod(config.localRunnerPath, 0o700),
      chmod(config.localEnvironmentPath, 0o600),
      chmod(config.localMetadataPath, 0o600)
    ]);
    const incoming = `${config.remoteRoot}/.incoming-camera-${config.court}`;
    await this.#remote(`install -d -m 0700 ${shellQuote(config.remoteRoot)} ${shellQuote(incoming)}`);
    await this.#copyToRemote([
      config.fixturePath,
      config.localRunnerPath,
      config.localEnvironmentPath,
      config.localMetadataPath,
      SNAPSHOT_SCRIPT
    ], incoming);
    const fixtureName = basename(config.fixturePath);
    await this.#remote([
      `install -m 0600 ${shellQuote(`${incoming}/${fixtureName}`)} ${shellQuote(config.remoteFixturePath)}`,
      `install -m 0700 ${shellQuote(`${incoming}/${basename(config.localRunnerPath)}`)} ${shellQuote(config.remoteRunnerPath)}`,
      `install -m 0600 ${shellQuote(`${incoming}/${basename(config.localEnvironmentPath)}`)} ${shellQuote(config.remoteEnvironmentPath)}`,
      `install -m 0600 ${shellQuote(`${incoming}/${basename(config.localMetadataPath)}`)} ${shellQuote(config.remoteMetadataPath)}`,
      `install -m 0700 ${shellQuote(`${incoming}/${basename(SNAPSHOT_SCRIPT)}`)} ${shellQuote(config.remoteSnapshotPath)}`,
      `rm -rf ${shellQuote(incoming)}`
    ].join(" && "));
    return { ...fixture, staged: true, sourceHost: this.sourceHost, remotePath: config.remoteFixturePath };
  }

  async inspect(marker) {
    const identity = markerIdentity(marker);
    const unit = `${marker}.service`;
    const container = marker;
    const command = [
      `active=$(/usr/bin/systemctl show ${shellQuote(unit)} --property=ActiveState --value 2>/dev/null || true)`,
      `mainpid=$(/usr/bin/systemctl show ${shellQuote(unit)} --property=MainPID --value 2>/dev/null || true)`,
      `restarts=$(/usr/bin/systemctl show ${shellQuote(unit)} --property=NRestarts --value 2>/dev/null || true)`,
      `running=$(/usr/bin/docker inspect ${shellQuote(container)} --format '{{.State.Running}}' 2>/dev/null || true)`,
      `label=$(/usr/bin/docker inspect ${shellQuote(container)} --format '{{index .Config.Labels \"scorecheck.rehearsal.marker\"}}' 2>/dev/null || true)`,
      `hostpid=$(/usr/bin/docker inspect ${shellQuote(container)} --format '{{.State.Pid}}' 2>/dev/null || true)`,
      `printf '%s|%s|%s|%s|%s|%s\\n' \"$active\" \"$mainpid\" \"$restarts\" \"$running\" \"$label\" \"$hostpid\"`
    ].join("; ");
    const result = await this.#remote(command);
    const [active, mainPidRaw, restartsRaw, running, label, hostPidRaw] = result.stdout.trim().split("|");
    const absent = active !== "active" && running !== "true" && !label;
    if (absent) return null;
    if (active !== "active" || running !== "true" || label !== marker) throw new Error(`synthetic publisher ${marker} has inconsistent spare-host ownership`);
    const pid = Number(mainPidRaw);
    const ffmpegPid = Number(hostPidRaw);
    const restartCount = Number(restartsRaw || 0);
    if (![pid, ffmpegPid].every((value) => Number.isInteger(value) && value >= 2) || !Number.isInteger(restartCount) || restartCount < 0) {
      throw new Error(`synthetic publisher ${marker} has invalid spare-host process state`);
    }
    return {
      pid,
      ffmpegPid,
      restartCount,
      marker,
      court: identity.court,
      sourceHost: this.sourceHost,
      sourceUnit: unit,
      sourceContainer: container,
      commandSha256: sha256(`${unit}:${container}:${SOURCE_IMAGE}`)
    };
  }

  async ensure(config) {
    validateRemoteConfig(config, this.sourceHost);
    const existing = await this.inspect(config.marker);
    if (existing) return { ...existing, adopted: true, startedAt: null, ...config.redacted };
    await this.prepare(config);
    const cleanup = [
      `if /usr/bin/docker inspect ${shellQuote(config.sourceContainer)} >/dev/null 2>&1; then`,
      `  label=$(/usr/bin/docker inspect ${shellQuote(config.sourceContainer)} --format '{{index .Config.Labels \"scorecheck.rehearsal.marker\"}}');`,
      `  test \"$label\" = ${shellQuote(config.marker)} || exit 42;`,
      `  /usr/bin/docker rm -f ${shellQuote(config.sourceContainer)} >/dev/null;`,
      "fi;",
      `/usr/bin/systemctl reset-failed ${shellQuote(config.sourceUnit)} >/dev/null 2>&1 || true`
    ].join(" ");
    await this.#remote(cleanup);
    const run = [
      "/usr/bin/systemd-run",
      `--unit=${config.sourceUnit}`,
      "--collect",
      "--property=Restart=on-failure",
      "--property=RestartSec=1s",
      "--property=TimeoutStopSec=15s",
      "--property=KillMode=control-group",
      "/usr/bin/docker", "run", "--rm",
      "--name", config.sourceContainer,
      "--label", `scorecheck.rehearsal.marker=${config.marker}`,
      "--label", `scorecheck.rehearsal.generation=${markerIdentity(config.marker).generationId}`,
      "--network", "host",
      "--env-file", config.remoteEnvironmentPath,
      "--volume", `${config.remoteRoot}:${config.remoteRoot}:rw`,
      "--entrypoint", "/bin/sh",
      SOURCE_IMAGE,
      config.remoteRunnerPath
    ].map(shellQuote).join(" ");
    await this.#remote(run);
    await this.sleep(2_000);
    const observed = await this.inspect(config.marker);
    if (!observed) throw new Error(`synthetic publisher Camera ${config.court} did not remain running on the spare host`);
    return { ...observed, adopted: false, startedAt: new Date().toISOString(), ...config.redacted };
  }

  async observeHealth(entries) {
    validateEntries(entries, this.sourceHost);
    const generationIds = new Set(entries.map((entry) => markerIdentity(entry.marker).generationId));
    if (generationIds.size !== 1) throw new Error("synthetic publisher health entries span multiple generations");
    const generationId = [...generationIds][0];
    const remoteRoot = `/opt/scorecheck-rehearsal/${generationId}`;
    const snapshotPath = `${remoteRoot}/publisher-snapshot.py`;
    const result = await this.#remote(`/usr/bin/python3 ${shellQuote(snapshotPath)} ${shellQuote(remoteRoot)}`);
    const snapshot = parseSnapshot(result.stdout, entries);
    const problems = [];
    const samples = [];
    for (const entry of [...entries].sort((left, right) => left.court - right.court)) {
      const sample = snapshot.samples.find((candidate) => candidate.court === entry.court);
      if (!sample) {
        problems.push(`Camera ${entry.court} synthetic publisher snapshot is missing`);
        continue;
      }
      const progress = sample.progress;
      const supervisor = sample.supervisor;
      if (!progress) problems.push(`Camera ${entry.court} synthetic publisher progress is missing`);
      else {
        if (progress.ageMs < -1_000 || progress.ageMs > FRESHNESS_MS) problems.push(`Camera ${entry.court} synthetic publisher progress is stale`);
        if (progress.status !== "continue" || progress.framesPerSecond < 29 || progress.framesPerSecond > 31 || progress.droppedFrames !== 0 || progress.duplicatedFrames !== 0 || progress.speedRatio < 0.95 || progress.speedRatio > 1.05) {
          problems.push(`Camera ${entry.court} synthetic publisher is outside 30fps/zero-drop/realtime bounds (${progressSummary(progress)})`);
        }
      }
      if (!supervisor || supervisor.state !== "running" || !Number.isInteger(supervisor.ffmpegPid) || supervisor.ffmpegPid < 2) {
        problems.push(`Camera ${entry.court} synthetic publisher supervisor is not running one FFmpeg container`);
      } else if (supervisor.restartCount !== 0) {
        problems.push(`Camera ${entry.court} synthetic publisher restarted ${supervisor.restartCount} time(s)`);
      }
      await writeLocalSupervisorEvidence(entry, supervisor, snapshot.observedAt);
      samples.push({ court: entry.court, marker: entry.marker, processId: supervisor?.supervisorPid ?? null, progress, supervisor });
    }
    return { passed: problems.length === 0, observedAt: snapshot.observedAt, samples, problems: [...new Set(problems)] };
  }

  async waitForHealthy(entries, { stableSamples = 3, timeoutMs = 60_000, intervalMs = 2_000 } = {}) {
    const startedAt = this.now();
    let stable = 0;
    let latest = null;
    while (this.now() - startedAt <= timeoutMs) {
      latest = await this.observeHealth(entries);
      if (latest.passed) {
        stable += 1;
        if (stable >= stableSamples) return { ...latest, stableSamples };
      } else stable = 0;
      await this.sleep(intervalMs);
    }
    const evidence = latest ?? { passed: false, observedAt: new Date(this.now()).toISOString(), samples: [], problems: ["synthetic publisher health was not observed"] };
    throw new SyntheticPublisherHealthError(evidence);
  }

  async stop(record) {
    const identity = markerIdentity(record?.marker);
    const unit = `${record.marker}.service`;
    const container = record.marker;
    const before = await this.inspect(record.marker).catch(() => null);
    await this.#remote(`/usr/bin/systemctl stop ${shellQuote(unit)} >/dev/null 2>&1 || true`);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await this.inspect(record.marker).catch(() => null);
      if (!current) break;
      await this.sleep(100);
      if (attempt === 49) throw new Error(`synthetic publisher ${record.marker} did not stop`);
    }
    const ownership = await this.#remote(`/usr/bin/docker inspect ${shellQuote(container)} --format '{{index .Config.Labels \"scorecheck.rehearsal.marker\"}}' 2>/dev/null || true`);
    if (ownership.stdout.trim()) {
      if (ownership.stdout.trim() !== record.marker) throw new Error(`synthetic publisher ${record.marker} container ownership changed during stop`);
      await this.#remote(`/usr/bin/docker rm -f ${shellQuote(container)} >/dev/null`);
    }
    if (record.progressPath && record.remoteProgressPath) {
      await this.#copyFromRemote(record.remoteProgressPath, record.progressPath, { allowFailure: true });
    }
    if (record.logPath) {
      const journal = await this.#remote(`/usr/bin/journalctl -u ${shellQuote(unit)} --no-pager -o short-iso`, { allowFailure: true });
      await writeFile(record.logPath, journal.stdout || journal.stderr || "", { mode: 0o600 });
      await chmod(record.logPath, 0o600);
    }
    if (record.supervisorStatusPath) {
      await writeLocalSupervisorEvidence(record, {
        state: "stopped",
        supervisorPid: before?.pid ?? null,
        ffmpegPid: before?.ffmpegPid ?? null,
        restartCount: before?.restartCount ?? 0,
        ageMs: 0
      }, new Date().toISOString());
    }
    await this.#remote(`/usr/bin/systemctl reset-failed ${shellQuote(unit)} >/dev/null 2>&1 || true`);
    const remoteRoot = `/opt/scorecheck-rehearsal/${identity.generationId}`;
    const prefix = `scorecheck-rehearsal-${identity.generationId}-camera-`;
    await this.#remote(`if ! /usr/bin/systemctl list-units --all --plain --no-legend ${shellQuote(`${prefix}*.service`)} 2>/dev/null | grep -q .; then rm -rf ${shellQuote(remoteRoot)}; fi`);
    return { absent: true };
  }

  async #remote(command, { allowFailure = false } = {}) {
    return this.runner("ssh", sshArguments(this.sshKey, this.knownHosts, this.sourceHost, command), { allowFailure });
  }

  async #copyToRemote(paths, remoteDirectory) {
    return this.runner("scp", ["-q", ...transportArguments(this.sshKey, this.knownHosts), ...paths, `root@${this.sourceHost}:${remoteDirectory}/`]);
  }

  async #copyFromRemote(remotePath, localPath, { allowFailure = false } = {}) {
    return this.runner("scp", ["-q", ...transportArguments(this.sshKey, this.knownHosts), `root@${this.sourceHost}:${remotePath}`, localPath], { allowFailure });
  }
}

function validateRemoteConfig(config, sourceHost) {
  const identity = markerIdentity(config?.marker);
  if (config?.executionMode !== "compositor-spare" || config.sourceHost !== sourceHost || config.sourceImage !== SOURCE_IMAGE
    || config.court !== identity.court || config.sourceUnit !== `${config.marker}.service` || config.sourceContainer !== config.marker
    || !requiredRemoteRoot(config.remoteRoot, identity.generationId)
    || ![config.remoteFixturePath, config.remoteProgressPath, config.remoteRunnerPath, config.remoteEnvironmentPath, config.remoteMetadataPath, config.remoteSnapshotPath].every((path) => typeof path === "string" && path.startsWith(`${config.remoteRoot}/`))
    || typeof config.runnerContent !== "string" || !config.runnerContent.includes("$OUTPUT_URL")
    || typeof config.environmentContent !== "string" || !config.environmentContent.startsWith("OUTPUT_URL=")) {
    throw new Error("spare-host synthetic publisher configuration is invalid");
  }
}

function validateEntries(entries, sourceHost) {
  if (!Array.isArray(entries) || entries.length !== COURTS.length) throw new Error("synthetic publisher health inventory must contain eight cameras");
  const courts = new Set();
  for (const entry of entries) {
    const identity = markerIdentity(entry?.marker);
    if (identity.court !== entry.court || entry.sourceHost !== sourceHost || entry.executionMode !== "compositor-spare" || courts.has(entry.court)) {
      throw new Error("spare-host synthetic publisher health record is invalid");
    }
    courts.add(entry.court);
  }
}

function parseSnapshot(raw, entries) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("spare-host synthetic publisher snapshot is invalid JSON"); }
  if (value?.schemaVersion !== 1 || typeof value.observedAt !== "string" || !Array.isArray(value.samples) || value.samples.length !== 8) {
    throw new Error("spare-host synthetic publisher snapshot contract is invalid");
  }
  const expected = new Map(entries.map((entry) => [entry.court, entry.marker]));
  for (const sample of value.samples) {
    if (expected.get(sample?.court) !== sample?.marker) throw new Error("spare-host synthetic publisher snapshot identity is invalid");
  }
  return value;
}

async function writeLocalSupervisorEvidence(entry, supervisor, observedAt) {
  if (!entry?.supervisorStatusPath || !supervisor) return;
  await writeFile(entry.supervisorStatusPath, `${JSON.stringify({
    schemaVersion: 1,
    court: entry.court,
    marker: entry.marker,
    state: supervisor.state,
    supervisorPid: supervisor.supervisorPid ?? null,
    ffmpegPid: supervisor.ffmpegPid ?? null,
    restartCount: supervisor.restartCount ?? 0,
    lastRestartAt: supervisor.lastRestartAt ?? null,
    lastFailure: supervisor.lastFailure ?? null,
    updatedAt: observedAt
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(entry.supervisorStatusPath, 0o600);
}

function markerIdentity(marker) {
  const match = MARKER.exec(marker ?? "");
  if (!match) throw new Error("synthetic publisher marker is invalid");
  return { generationId: match[1], court: Number(match[2]) };
}

function requiredRemoteRoot(value, generationId) {
  return value === `/opt/scorecheck-rehearsal/${generationId}`;
}

function requiredIpv4(value) {
  if (!IPV4.test(value ?? "") || value.split(".").some((octet) => Number(octet) > 255)) throw new Error("synthetic source host must be an IPv4 address");
  return value;
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return resolve(value);
}

function transportArguments(sshKey, knownHosts) {
  return [
    "-i", sshKey,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "ConnectTimeout=10"
  ];
}

function sshArguments(sshKey, knownHosts, host, command) {
  return [...transportArguments(sshKey, knownHosts), `root@${host}`, command];
}

function shellQuote(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_./:@=+,-]+$/u.test(text)) return text;
  return `'${text.replaceAll("'", `'\"'\"'`)}'`;
}

function progressSummary(value) {
  if (!value) return "missing";
  return `status=${value.status ?? "null"},fps=${value.framesPerSecond ?? "null"},drop=${value.droppedFrames ?? "null"},dup=${value.duplicatedFrames ?? "null"},speed=${value.speedRatio ?? "null"}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
      else reject(new Error(`${basename(command)} failed with exit ${code}`));
    });
  });
}

export { SOURCE_IMAGE };
