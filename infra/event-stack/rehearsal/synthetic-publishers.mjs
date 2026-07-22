import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const MARKER = /^scorecheck-rehearsal-[a-zA-Z0-9-]{8,80}-camera-[1-8]$/;
const FIXTURE_DURATION_SECONDS = 12;
// Keep the eight 1080p30 rehearsal sources at an aggregate 10 Mbps. Their
// fixtures are encoded before qualification and their stream-copy loops run on
// the manifest-owned warm spare, so operator workstation/Wi-Fi contention
// cannot masquerade as an ingest/compositor failure. Resolution and cadence
// still exercise the complete eight-court decode/Egress path.
const FIXTURE_VIDEO_BITRATE_KBPS = 1_250;
const SRT_INPUT_BANDWIDTH_BYTES_PER_SECOND = 200_000;
const PROGRESS_FRESHNESS_MS = 5_000;
const SUPERVISOR_FRESHNESS_MS = 5_000;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));

export function publisherMarker(generationId, court) {
  if (typeof generationId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(generationId) || !COURTS.includes(court)) throw new Error("synthetic publisher identity is invalid");
  return `scorecheck-rehearsal-${generationId}-camera-${court}`;
}

export function publisherProtocol(court) {
  if (!COURTS.includes(court)) throw new Error("synthetic publisher court is invalid");
  return court <= 2 ? "RTMP" : "SRT";
}

export function buildSyntheticPublisherConfig({ court, generationId, host, user, password, evidenceDirectory, runtimeDirectory, ffmpegPath = "ffmpeg", nodePath = process.execPath }) {
  if (!COURTS.includes(court)) throw new Error("synthetic publisher court is invalid");
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host ?? "")) throw new Error("synthetic publisher host is invalid");
  for (const [label, value] of [["user", user], ["password", password]]) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9._~+/=-]{12,200}$/.test(value)) throw new Error(`synthetic publisher ${label} is invalid`);
  }
  if (typeof ffmpegPath !== "string" || !ffmpegPath || /[\r\n\0]/.test(ffmpegPath)) throw new Error("synthetic publisher FFmpeg path is invalid");
  if (typeof nodePath !== "string" || !nodePath || /[\r\n\0]/.test(nodePath)) throw new Error("synthetic publisher Node.js path is invalid");
  if (![evidenceDirectory, runtimeDirectory].every((value) => typeof value === "string" && value.startsWith("/") && !value.includes("..") && resolve(value) === value)) {
    throw new Error("synthetic publisher runtime directories are invalid");
  }
  const marker = publisherMarker(generationId, court);
  const protocol = publisherProtocol(court);
  const directory = resolve(evidenceDirectory);
  const protectedRuntimeDirectory = resolve(runtimeDirectory);
  const progressPath = resolve(directory, `camera-${court}.progress`);
  const logPath = resolve(directory, `camera-${court}.ffmpeg.log`);
  const fixturePath = resolve(directory, `camera-${court}.fixture.mkv`);
  const fixtureTempPath = `${fixturePath}.partial`;
  const supervisorConfigPath = resolve(protectedRuntimeDirectory, `camera-${court}.supervisor.json`);
  const supervisorStatusPath = resolve(directory, `camera-${court}.supervisor-status.json`);
  const workerPath = resolve(SCRIPT_DIRECTORY, "synthetic-publisher-worker.cjs");
  const outputUrl = protocol === "RTMP"
    ? `rtmp://${host}:1935/court${court}_raw?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(password)}`
    : `srt://${host}:8890?mode=caller&transtype=live&tlpktdrop=1&streamid=publish:court${court}_raw:${user}:${password}&pkt_size=1316&latency=500000&maxbw=0&inputbw=${SRT_INPUT_BANDWIDTH_BYTES_PER_SECOND}&oheadbw=50&timeout=10000000&connect_timeout=5000&linger=0`;
  const hue = (court - 1) * 45;
  const tone = 330 + court * 55;
  const fixtureArgs = [
    "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30,format=yuv420p,hue=h=${hue}`,
    "-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000`,
    "-t", String(FIXTURE_DURATION_SECONDS),
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `drawbox=x=30:y=30:w=580:h=100:color=black@0.75:t=fill,drawtext=text='CAMERA ${court} REHEARSAL':x=55:y=55:fontsize=42:fontcolor=white`,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main",
    "-pix_fmt", "yuv420p",
    "-r", "30", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-b:v", `${FIXTURE_VIDEO_BITRATE_KBPS}k`, "-minrate", `${FIXTURE_VIDEO_BITRATE_KBPS}k`, "-maxrate", `${FIXTURE_VIDEO_BITRATE_KBPS}k`, "-bufsize", `${FIXTURE_VIDEO_BITRATE_KBPS * 2}k`,
    "-x264-params", "cabac=1:nal-hrd=cbr:force-cfr=1",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-metadata", `comment=${marker}`,
    "-f", "matroska", fixtureTempPath
  ];
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "warning", "-stats_period", "1",
    "-rw_timeout", "10000000",
    "-fflags", "+genpts", "-stream_loop", "-1", "-re", "-i", fixturePath,
    "-map", "0:v:0", "-map", "0:a:0",
    "-c", "copy", "-metadata", `comment=${marker}`,
    "-progress", progressPath
  ];
  if (protocol === "RTMP") args.push("-flvflags", "no_duration_filesize", "-f", "flv", outputUrl);
  else args.push("-muxdelay", "0", "-f", "mpegts", outputUrl);
  return {
    court,
    marker,
    protocol,
    ffmpegPath,
    nodePath,
    workerPath,
    fixtureArgs,
    fixturePath,
    fixtureTempPath,
    args,
    progressPath,
    logPath,
    supervisorConfigPath,
    supervisorStatusPath,
    outputUrl,
    protectedSupervisorConfiguration: {
      schemaVersion: 1,
      court,
      marker,
      ffmpegPath,
      ffmpegArgs: args,
      progressPath,
      logPath,
      statusPath: supervisorStatusPath
    },
    redacted: { court, marker, protocol, host, rawPath: `court${court}_raw`, fixturePath, progressPath, logPath, supervisorConfigPath, supervisorStatusPath }
  };
}

export class SyntheticPublisherManager {
  constructor({ spawnImpl = spawn, runner = runCommand, fixtureBuilder = prepareFixture, killImpl = process.kill, sleep = delay, now = () => Date.now() } = {}) {
    this.spawnImpl = spawnImpl;
    this.runner = runner;
    this.fixtureBuilder = fixtureBuilder;
    this.killImpl = killImpl;
    this.sleep = sleep;
    this.now = now;
  }

  async preflight(ffmpegPath) {
    const [protocols, encoders, filters, formats] = await Promise.all([
      this.runner(ffmpegPath, ["-hide_banner", "-protocols"]),
      this.runner(ffmpegPath, ["-hide_banner", "-encoders"]),
      this.runner(ffmpegPath, ["-hide_banner", "-filters"]),
      this.runner(ffmpegPath, ["-hide_banner", "-formats"])
    ]);
    const combined = `${protocols.stdout}\n${protocols.stderr}\n${encoders.stdout}\n${encoders.stderr}\n${filters.stdout}\n${filters.stderr}\n${formats.stdout}\n${formats.stderr}`;
    for (const required of ["rtmp", "srt", "libx264", "aac", "drawtext", "drawbox", "testsrc2", "sine", "matroska"]) {
      if (!new RegExp(`(^|\\s)${required}(\\s|$)`, "m").test(combined)) throw new Error(`FFmpeg rehearsal preflight is missing ${required}`);
    }
    return { healthy: true };
  }

  async inspect(marker) {
    validateMarker(marker);
    const result = await this.runner("ps", ["-axo", "pid=,command="]);
    const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(`synthetic-publisher-worker.cjs --marker ${marker} `));
    if (matches.length > 1) throw new Error(`multiple synthetic publishers exist for ${marker}`);
    if (!matches.length) return null;
    const match = /^(\d+)\s+(.+)$/.exec(matches[0]);
    if (!match) throw new Error(`synthetic publisher process inventory is invalid for ${marker}`);
    return { pid: Number(match[1]), marker, commandSha256: await sha256Text(match[2]) };
  }

  async prepare(config) {
    validateConfig(config);
    await mkdir(resolve(config.logPath, ".."), { recursive: true, mode: 0o700 });
    await chmod(resolve(config.logPath, ".."), 0o700);
    await mkdir(resolve(config.supervisorConfigPath, ".."), { recursive: true, mode: 0o700 });
    await chmod(resolve(config.supervisorConfigPath, ".."), 0o700);
    return this.fixtureBuilder(config, this.runner);
  }

  async ensure(config) {
    validateConfig(config);
    const existing = await this.inspect(config.marker);
    if (existing) return { ...existing, adopted: true, startedAt: null, ...config.redacted };
    await this.prepare(config);
    await unlink(config.progressPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await unlink(config.supervisorStatusPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await writeFile(config.supervisorConfigPath, `${JSON.stringify(config.protectedSupervisorConfiguration, null, 2)}\n`, { mode: 0o600 });
    await chmod(config.supervisorConfigPath, 0o600);
    const log = await open(config.logPath, "a", 0o600);
    let child;
    try {
      child = this.spawnImpl(config.nodePath, [
        config.workerPath,
        "--marker", config.marker,
        "--config", config.supervisorConfigPath
      ], { detached: true, stdio: ["ignore", log.fd, log.fd] });
      if (!Number.isInteger(child.pid) || child.pid < 2) throw new Error("synthetic publisher did not return a process id");
      if (typeof child.unref !== "function") throw new Error("synthetic publisher process cannot be detached from the operator");
      child.unref();
    } finally {
      await log.close();
    }
    await this.sleep(2_000);
    const observed = await this.inspect(config.marker);
    if (!observed || observed.pid !== child.pid) throw new Error(`synthetic publisher Camera ${config.court} did not remain running`);
    return { ...observed, adopted: false, startedAt: new Date().toISOString(), ...config.redacted };
  }

  async observeHealth(entries) {
    if (!Array.isArray(entries) || entries.length !== COURTS.length) throw new Error("synthetic publisher health inventory must contain eight cameras");
    const inventory = await this.runner("ps", ["-axo", "pid=,command="]);
    const lines = inventory.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const observedAtMs = this.now();
    const samples = [];
    const problems = [];
    for (const entry of [...entries].sort((left, right) => left.court - right.court)) {
      validatePublisherRecord(entry);
      const matches = lines.filter((line) => line.includes(`synthetic-publisher-worker.cjs --marker ${entry.marker} `));
      let processId = null;
      if (matches.length !== 1) {
        problems.push(`Camera ${entry.court} synthetic publisher process count is ${matches.length}, expected 1`);
      } else {
        const match = /^(\d+)\s+(.+)$/u.exec(matches[0]);
        if (!match) problems.push(`Camera ${entry.court} synthetic publisher process inventory is invalid`);
        else processId = Number(match[1]);
      }
      let progress = null;
      let supervisor = null;
      try {
        progress = await latestProgress(entry.progressPath, observedAtMs);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!progress) {
        problems.push(`Camera ${entry.court} synthetic publisher progress is missing`);
      } else {
        if (progress.ageMs < -1_000 || progress.ageMs > PROGRESS_FRESHNESS_MS) problems.push(`Camera ${entry.court} synthetic publisher progress is stale`);
        if (progress.status !== "continue" || progress.framesPerSecond < 29 || progress.framesPerSecond > 31 || progress.droppedFrames !== 0 || progress.duplicatedFrames !== 0 || progress.speedRatio < 0.95 || progress.speedRatio > 1.05) {
          problems.push(`Camera ${entry.court} synthetic publisher is outside 30fps/zero-drop/realtime bounds (${progressSummary(progress)})`);
        }
      }
      try {
        supervisor = await latestSupervisor(entry.supervisorStatusPath, observedAtMs, entry);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!supervisor) problems.push(`Camera ${entry.court} synthetic publisher supervisor status is missing`);
      else {
        if (supervisor.ageMs < -1_000 || supervisor.ageMs > SUPERVISOR_FRESHNESS_MS) problems.push(`Camera ${entry.court} synthetic publisher supervisor status is stale`);
        if (supervisor.state !== "running" || !Number.isInteger(supervisor.ffmpegPid) || supervisor.ffmpegPid < 2) problems.push(`Camera ${entry.court} synthetic publisher supervisor is not running one FFmpeg child`);
        if (supervisor.restartCount !== 0) problems.push(`Camera ${entry.court} synthetic publisher restarted ${supervisor.restartCount} time(s)`);
      }
      samples.push({ court: entry.court, marker: entry.marker, processId, progress, supervisor });
    }
    return {
      passed: problems.length === 0,
      observedAt: new Date(observedAtMs).toISOString(),
      samples,
      problems: [...new Set(problems)]
    };
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

  async stop({ marker }) {
    validateMarker(marker);
    let current = await this.inspect(marker);
    if (!current) return { absent: true };
    this.killImpl(-current.pid, "SIGTERM");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await this.sleep(100);
      current = await this.inspect(marker);
      if (!current) return { absent: true };
    }
    this.killImpl(-current.pid, "SIGKILL");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.sleep(100);
      if (!(await this.inspect(marker))) return { absent: true };
    }
    throw new Error(`synthetic publisher ${marker} did not stop`);
  }
}

function validateConfig(value) {
  if (!value || !COURTS.includes(value.court) || !MARKER.test(value.marker)
    || !Array.isArray(value.args) || !value.args.includes(`comment=${value.marker}`)
    || !Array.isArray(value.fixtureArgs) || !value.fixtureArgs.includes(`comment=${value.marker}`)
    || typeof value.fixturePath !== "string" || typeof value.fixtureTempPath !== "string"
    || typeof value.supervisorConfigPath !== "string" || typeof value.supervisorStatusPath !== "string"
    || typeof value.workerPath !== "string" || typeof value.nodePath !== "string"
    || value.protectedSupervisorConfiguration?.marker !== value.marker) {
    throw new Error("synthetic publisher configuration is invalid");
  }
}

function validatePublisherRecord(value) {
  if (!value || !COURTS.includes(value.court) || !MARKER.test(value.marker) || typeof value.progressPath !== "string" || !value.progressPath
    || typeof value.supervisorStatusPath !== "string" || !value.supervisorStatusPath) {
    throw new Error("synthetic publisher health record is invalid");
  }
}

function validateMarker(value) {
  if (typeof value !== "string" || !MARKER.test(value)) throw new Error("synthetic publisher marker is invalid");
}

async function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${basename(command)} failed with exit ${code}`)));
  });
}

async function prepareFixture(config, runner) {
  try {
    const existing = await stat(config.fixturePath);
    if (!existing.isFile() || existing.size < 100_000) throw new Error(`synthetic publisher Camera ${config.court} fixture is incomplete`);
    await chmod(config.fixturePath, 0o600);
    return { path: config.fixturePath, size: existing.size, adopted: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await unlink(config.fixtureTempPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  try {
    await runner(config.ffmpegPath, config.fixtureArgs);
    const information = await stat(config.fixtureTempPath);
    if (!information.isFile() || information.size < 100_000) throw new Error(`synthetic publisher Camera ${config.court} fixture is incomplete`);
    await chmod(config.fixtureTempPath, 0o600);
    await rename(config.fixtureTempPath, config.fixturePath);
    await chmod(config.fixturePath, 0o600);
    return { path: config.fixturePath, size: information.size, adopted: false };
  } catch (error) {
    await unlink(config.fixtureTempPath).catch(() => {});
    throw error;
  }
}

async function latestProgress(path, nowMs) {
  const [raw, information] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  let fields = {};
  let latest = null;
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    fields[key] = value;
    if (key === "progress") {
      latest = fields;
      fields = {};
    }
  }
  if (!latest) return null;
  return {
    status: latest.progress ?? null,
    frame: finiteNumber(latest.frame),
    framesPerSecond: finiteNumber(latest.fps),
    droppedFrames: finiteNumber(latest.drop_frames),
    duplicatedFrames: finiteNumber(latest.dup_frames),
    speedRatio: finiteNumber(String(latest.speed ?? "").replace(/x$/u, "")),
    ageMs: nowMs - information.mtimeMs
  };
}

async function latestSupervisor(path, nowMs, expected) {
  const information = await stat(path);
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value?.schemaVersion !== 1 || typeof value.marker !== "string" || !MARKER.test(value.marker)
    || value.marker !== expected.marker || value.court !== expected.court
    || !Number.isInteger(value.restartCount) || value.restartCount < 0) return null;
  return {
    state: value.state ?? null,
    ffmpegPid: Number.isInteger(value.ffmpegPid) ? value.ffmpegPid : null,
    restartCount: value.restartCount,
    lastRestartAt: value.lastRestartAt ?? null,
    lastFailure: value.lastFailure ?? null,
    ageMs: nowMs - information.mtimeMs
  };
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function progressSummary(value) {
  if (!value) return "missing";
  return `status=${value.status ?? "null"},fps=${value.framesPerSecond ?? "null"},drop=${value.droppedFrames ?? "null"},dup=${value.duplicatedFrames ?? "null"},speed=${value.speedRatio ?? "null"}`;
}

export class SyntheticPublisherHealthError extends Error {
  constructor(evidence) {
    super(`synthetic publishers did not stabilize: ${evidence.problems.slice(0, 8).join("; ")}`);
    this.name = "SyntheticPublisherHealthError";
    this.evidenceKind = "publisher";
    this.evidence = evidence;
  }
}

async function sha256Text(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

export { COURTS };
