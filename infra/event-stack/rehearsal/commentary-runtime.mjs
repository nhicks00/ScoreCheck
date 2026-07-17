import { spawn } from "node:child_process";
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const MARKER = /^scorecheck-rehearsal-[a-zA-Z0-9-]{8,80}-commentator-[1-8]$/;
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const EVENT_STACK_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const COMMENTARY_READY_POLL_ATTEMPTS = 900;
const COMMENTARY_SPEECH = "ScoreCheck commentary rehearsal. Camera one is live. The serve is in, the rally continues, and the score is twelve to ten. Testing clear remote commentary audio synchronization.";
const DEFAULT_SAY_PATH = "/usr/bin/say";

export function buildCommentaryClientConfig({ court, generationId, material, programOrigin, evidenceDirectory, runtimeDirectory, nodePath = process.execPath, ffmpegPath = "ffmpeg", sayPath = DEFAULT_SAY_PATH }) {
  if (!COURTS.includes(court) || typeof generationId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(generationId)) throw new Error("commentary rehearsal identity is invalid");
  const parsed = new URL(programOrigin);
  if (parsed.protocol !== "https:" || parsed.origin !== programOrigin) throw new Error("commentary rehearsal program origin is invalid");
  const marker = `scorecheck-rehearsal-${generationId}-commentator-${court}`;
  const root = resolve(runtimeDirectory);
  const configPath = resolve(root, `commentator-${court}.json`);
  const fixturePath = resolve(root, "commentary-microphone.wav");
  const speechSeedPath = resolve(root, "commentary-microphone-seed.aiff");
  const normalizedSeedPath = resolve(root, "commentary-microphone-seed.wav");
  const logPath = resolve(evidenceDirectory, `commentator-${court}.log`);
  const readyPath = resolve(evidenceDirectory, `commentator-${court}.ready.json`);
  const workerPath = resolve(SCRIPT_DIRECTORY, "commentary-browser-worker.cjs");
  const playwrightPath = resolve(EVENT_STACK_DIRECTORY, "node_modules", "playwright");
  return {
    court,
    marker,
    configPath,
    fixturePath,
    speechSeedPath,
    normalizedSeedPath,
    logPath,
    readyPath,
    workerPath,
    playwrightPath,
    nodePath,
    ffmpegPath,
    sayPath,
    protectedConfiguration: {
      schemaVersion: 1,
      court,
      marker,
      origin: programOrigin,
      pageUrl: `${programOrigin}/rehearsal/commentary/court/${court}?token=${encodeURIComponent(material.programPageToken)}`,
      commentatorPasscode: material.commentatorPasscode,
      audioFixturePath: fixturePath,
      readyPath
    },
    redacted: { court, marker, origin: programOrigin, configPath, fixturePath, logPath, readyPath }
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
    const [node, ffmpeg, filters, speech, playwright] = await Promise.all([
      this.runner(config.nodePath, ["--version"]),
      this.runner(config.ffmpegPath, ["-hide_banner", "-encoders"]),
      this.runner(config.ffmpegPath, ["-hide_banner", "-filters"]),
      this.runner(config.sayPath, ["-v", "?"]),
      this.runner(config.nodePath, [config.workerPath, "--preflight", "--playwright", config.playwrightPath])
    ]);
    if ([node, ffmpeg, filters, speech, playwright].some((result) => result.code !== 0)) throw new Error("commentary browser dependency preflight failed");
    if (!/^v\d+/m.test(node.stdout)) throw new Error("commentary browser Node.js preflight failed");
    if (!/(^|\s)pcm_s16le(\s|$)/m.test(`${ffmpeg.stdout}\n${ffmpeg.stderr}`)) throw new Error("commentary browser fixture requires the pcm_s16le encoder");
    for (const required of ["highpass", "lowpass", "loudnorm"]) {
      if (!new RegExp(`(^|\\s)${required}(\\s|$)`, "m").test(`${filters.stdout}\n${filters.stderr}`)) {
        throw new Error(`commentary browser fixture requires the ${required} filter`);
      }
    }
    if (!/\ben_[A-Z]{2}\b/m.test(speech.stdout)) throw new Error("commentary browser fixture requires an installed English macOS speech voice");
    if (!/playwright chromium ready/i.test(playwright.stdout)) throw new Error("commentary browser Playwright preflight failed");
    return { healthy: true };
  }

  async ensureFixture(config) {
    if (await exists(config.fixturePath)) return config.fixturePath;
    await mkdir(dirname(config.fixturePath), { recursive: true, mode: 0o700 });
    await chmod(dirname(config.fixturePath), 0o700);
    await rm(config.fixturePath, { force: true });
    await rm(config.speechSeedPath, { force: true });
    await rm(config.normalizedSeedPath, { force: true });
    let result;
    try {
      const speech = await this.runner(config.sayPath, ["-r", "210", "-o", config.speechSeedPath, COMMENTARY_SPEECH]);
      if (speech.code !== 0 || !(await exists(config.speechSeedPath))) throw new Error("commentary rehearsal speech seed was not created");
      const normalized = await this.runner(config.ffmpegPath, [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-i", config.speechSeedPath,
        "-af", "highpass=f=100,lowpass=f=8000,loudnorm=I=-20:LRA=7:TP=-3",
        "-ar", "48000", "-c:a", "pcm_s16le", "-ac", "1",
        config.normalizedSeedPath
      ]);
      if (normalized.code !== 0 || !(await exists(config.normalizedSeedPath))) throw new Error("commentary rehearsal normalized speech seed was not created");
      result = await this.runner(config.ffmpegPath, [
        "-hide_banner", "-nostdin", "-loglevel", "error",
        "-stream_loop", "-1", "-i", config.normalizedSeedPath,
        "-t", "2700", "-c:a", "copy", config.fixturePath
      ]);
    } finally {
      await rm(config.speechSeedPath, { force: true });
      await rm(config.normalizedSeedPath, { force: true });
    }
    if (result.code !== 0 || !(await exists(config.fixturePath))) throw new Error("commentary rehearsal speech fixture was not created");
    await chmod(config.fixturePath, 0o600);
    return config.fixturePath;
  }

  async inspect(marker) {
    validateMarker(marker);
    const result = await this.runner("ps", ["-axo", "pid=,command="]);
    const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(`commentary-browser-worker.cjs --marker ${marker} `));
    if (matches.length > 1) throw new Error(`multiple commentary browsers exist for ${marker}`);
    if (!matches.length) return null;
    const match = /^(\d+)\s+/.exec(matches[0]);
    if (!match) throw new Error("commentary rehearsal process inventory is invalid");
    return { pid: Number(match[1]), marker };
  }

  async ensure(config) {
    validateConfig(config);
    const existing = await this.inspect(config.marker);
    if (existing) {
      await this.#waitReady(config, existing.pid);
      return { ...existing, status: "running", adopted: true, ...config.redacted };
    }
    await this.ensureFixture(config);
    await mkdir(dirname(config.configPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(config.configPath), 0o700);
    await rm(config.readyPath, { force: true });
    await writeFile(config.configPath, `${JSON.stringify(config.protectedConfiguration, null, 2)}\n`, { mode: 0o600 });
    await chmod(config.configPath, 0o600);
    const log = await open(config.logPath, "a", 0o600);
    let child;
    try {
      child = this.spawnImpl(config.nodePath, [
        config.workerPath,
        "--marker", config.marker,
        "--config", config.configPath,
        "--playwright", config.playwrightPath
      ], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd]
      });
      if (!Number.isInteger(child.pid) || child.pid < 2) throw new Error("commentary rehearsal browser did not return a process id");
      if (typeof child.unref !== "function") throw new Error("commentary rehearsal browser cannot be detached from the operator");
      child.unref();
    } finally {
      await log.close();
    }
    await this.#waitReady(config, child.pid);
    const observed = await this.inspect(config.marker);
    if (!observed || observed.pid !== child.pid) throw new Error(`commentary rehearsal browser Camera ${config.court} did not remain connected`);
    return { ...observed, status: "running", adopted: false, startedAt: new Date().toISOString(), ...config.redacted };
  }

  async #waitReady(config, pid) {
    for (let attempt = 0; attempt < COMMENTARY_READY_POLL_ATTEMPTS; attempt += 1) {
      if (await exists(config.readyPath)) {
        const ready = JSON.parse(await readFile(config.readyPath, "utf8"));
        if (ready.schemaVersion === 1 && ready.court === config.court && ready.marker === config.marker) return;
        throw new Error(`commentary rehearsal browser Camera ${config.court} wrote an invalid readiness marker`);
      }
      if (!(await this.inspect(config.marker)) && attempt > 1) throw new Error(`commentary rehearsal browser Camera ${config.court} exited before readiness; inspect ${config.logPath}`);
      await this.sleep(200);
    }
    this.killImpl(-pid, "SIGTERM");
    throw new Error(`commentary rehearsal browser Camera ${config.court} did not become ready; inspect ${config.logPath}`);
  }

  async stop({ marker }) {
    validateMarker(marker);
    let current = await this.inspect(marker);
    if (!current) return { absent: true };
    this.killImpl(-current.pid, "SIGTERM");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await this.sleep(100);
      current = await this.inspect(marker);
      if (!current) return { absent: true };
    }
    this.killImpl(-current.pid, "SIGKILL");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.sleep(100);
      if (!(await this.inspect(marker))) return { absent: true };
    }
    throw new Error(`commentary rehearsal browser ${marker} did not stop`);
  }
}

function validateConfig(value) {
  if (!value || !COURTS.includes(value.court) || !MARKER.test(value.marker) || !value.protectedConfiguration?.commentatorPasscode || !value.protectedConfiguration?.pageUrl) throw new Error("commentary rehearsal configuration is invalid");
}

function validateMarker(value) {
  if (typeof value !== "string" || !MARKER.test(value)) throw new Error("commentary rehearsal marker is invalid");
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise({ code, stdout, stderr }) : reject(new Error(`${command} failed with exit ${code}: ${stderr.slice(0, 300)}`)));
  });
}

export { COURTS };
