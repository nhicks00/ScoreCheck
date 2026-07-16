import { spawn } from "node:child_process";
import { access, chmod, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const MARKER = /^scorecheck-rehearsal-[a-zA-Z0-9-]{8,80}-commentator-[1-8]$/;

export function buildCommentaryClientConfig({ court, generationId, material, rtcHost, evidenceDirectory, lkPath = "lk", ffmpegPath = "ffmpeg" }) {
  if (!COURTS.includes(court) || typeof generationId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(generationId)) throw new Error("commentary rehearsal identity is invalid");
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(rtcHost ?? "")) throw new Error("commentary rehearsal host is invalid");
  const marker = `scorecheck-rehearsal-${generationId}-commentator-${court}`;
  const room = `${material.commentary.roomPrefix}${court}`;
  const fixturePath = resolve(evidenceDirectory, "commentary-tone.ogg");
  const logPath = resolve(evidenceDirectory, `commentator-${court}.log`);
  return {
    court,
    marker,
    room,
    fixturePath,
    logPath,
    lkPath,
    ffmpegPath,
    environment: {
      LIVEKIT_URL: `wss://${rtcHost}`,
      LIVEKIT_API_KEY: material.commentary.apiKey,
      LIVEKIT_API_SECRET: material.commentary.apiSecret
    },
    redacted: { court, marker, room, rtcHost, fixturePath, logPath }
  };
}

export class CommentaryClientManager {
  constructor({ spawnImpl = spawn, runner = runCommand, killImpl = process.kill, sleep = delay } = {}) {
    this.spawnImpl = spawnImpl;
    this.runner = runner;
    this.killImpl = killImpl;
    this.sleep = sleep;
  }

  async preflight(config) {
    const [lk, ffmpeg] = await Promise.all([
      this.runner(config.lkPath, ["--version"]),
      this.runner(config.ffmpegPath, ["-hide_banner", "-encoders"])
    ]);
    if (!/lk version|version/i.test(`${lk.stdout} ${lk.stderr}`)) throw new Error("LiveKit CLI rehearsal preflight failed");
    if (!/(^|\s)libopus(\s|$)/m.test(`${ffmpeg.stdout}\n${ffmpeg.stderr}`)) throw new Error("commentary fixture requires the libopus encoder");
    return { healthy: true };
  }

  async ensureFixture(config) {
    if (await exists(config.fixturePath)) return config.fixturePath;
    await mkdir(dirname(config.fixturePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(config.fixturePath), 0o700);
    const result = await this.runner(config.ffmpegPath, [
      "-hide_banner", "-nostdin", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=523.25:sample_rate=48000",
      "-t", "7200", "-c:a", "libopus", "-b:a", "64k", "-ac", "1",
      config.fixturePath
    ]);
    if (result.code !== 0 || !(await exists(config.fixturePath))) throw new Error("commentary rehearsal audio fixture was not created");
    await chmod(config.fixturePath, 0o600);
    return config.fixturePath;
  }

  async inspect(marker) {
    validateMarker(marker);
    const result = await this.runner("ps", ["-axo", "pid=,command="]);
    const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(`--identity ${marker}`));
    if (matches.length > 1) throw new Error(`multiple commentary clients exist for ${marker}`);
    if (!matches.length) return null;
    const match = /^(\d+)\s+/.exec(matches[0]);
    if (!match) throw new Error("commentary rehearsal process inventory is invalid");
    return { pid: Number(match[1]), marker };
  }

  async ensure(config) {
    validateConfig(config);
    const existing = await this.inspect(config.marker);
    if (existing) return { ...existing, status: "running", adopted: true, ...config.redacted };
    await this.ensureFixture(config);
    const log = await open(config.logPath, "a", 0o600);
    let child;
    try {
      child = this.spawnImpl(config.lkPath, [
        "--yes", "room", "join",
        "--identity", config.marker,
        "--publish", config.fixturePath,
        config.room
      ], {
        detached: true,
        env: { ...process.env, ...config.environment },
        stdio: ["ignore", log.fd, log.fd]
      });
      if (!Number.isInteger(child.pid) || child.pid < 2) throw new Error("commentary rehearsal client did not return a process id");
      if (typeof child.unref !== "function") throw new Error("commentary rehearsal client cannot be detached from the operator");
      child.unref();
    } finally {
      await log.close();
    }
    await this.sleep(2_000);
    const observed = await this.inspect(config.marker);
    if (!observed || observed.pid !== child.pid) throw new Error(`commentary rehearsal client Camera ${config.court} did not remain connected`);
    return { ...observed, status: "running", adopted: false, startedAt: new Date().toISOString(), ...config.redacted };
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
    throw new Error(`commentary rehearsal client ${marker} did not stop`);
  }
}

function validateConfig(value) {
  if (!value || !COURTS.includes(value.court) || !MARKER.test(value.marker) || !value.room || !value.environment?.LIVEKIT_API_SECRET) throw new Error("commentary rehearsal configuration is invalid");
}

function validateMarker(value) {
  if (typeof value !== "string" || !MARKER.test(value)) throw new Error("commentary rehearsal marker is invalid");
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise({ code, stdout, stderr }) : reject(new Error(`${command} failed with exit ${code}`)));
  });
}

export { COURTS };
