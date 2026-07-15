import { spawn } from "node:child_process";
import { chmod, mkdir, open } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const MARKER = /^scorecheck-rehearsal-[a-zA-Z0-9-]{8,80}-camera-[1-8]$/;

export function publisherMarker(generationId, court) {
  if (typeof generationId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(generationId) || !COURTS.includes(court)) throw new Error("synthetic publisher identity is invalid");
  return `scorecheck-rehearsal-${generationId}-camera-${court}`;
}

export function publisherProtocol(court) {
  if (!COURTS.includes(court)) throw new Error("synthetic publisher court is invalid");
  return court <= 2 ? "RTMP" : "SRT";
}

export function buildSyntheticPublisherConfig({ court, generationId, host, user, password, evidenceDirectory, ffmpegPath = "ffmpeg" }) {
  if (!COURTS.includes(court)) throw new Error("synthetic publisher court is invalid");
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host ?? "")) throw new Error("synthetic publisher host is invalid");
  for (const [label, value] of [["user", user], ["password", password]]) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9._~+/=-]{12,200}$/.test(value)) throw new Error(`synthetic publisher ${label} is invalid`);
  }
  if (typeof ffmpegPath !== "string" || !ffmpegPath || /[\r\n\0]/.test(ffmpegPath)) throw new Error("synthetic publisher FFmpeg path is invalid");
  const marker = publisherMarker(generationId, court);
  const protocol = publisherProtocol(court);
  const directory = resolve(evidenceDirectory);
  const progressPath = resolve(directory, `camera-${court}.progress`);
  const logPath = resolve(directory, `camera-${court}.ffmpeg.log`);
  const outputUrl = protocol === "RTMP"
    ? `rtmp://${host}:1935/court${court}_raw?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(password)}`
    : `srt://${host}:8890?mode=caller&streamid=publish:court${court}_raw:${user}:${password}&pkt_size=1316&latency=2500000`;
  const hue = (court - 1) * 45;
  const tone = 330 + court * 55;
  const args = [
    "-hide_banner", "-nostdin", "-loglevel", "warning", "-stats_period", "1",
    "-re", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30,format=yuv420p,hue=h=${hue}`,
    "-re", "-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000`,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", `drawbox=x=30:y=30:w=580:h=100:color=black@0.75:t=fill,drawtext=text='CAMERA ${court} REHEARSAL':x=55:y=55:fontsize=42:fontcolor=white`,
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main",
    "-r", "30", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-b:v", "2500k", "-minrate", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
    "-x264-params", "nal-hrd=cbr:force-cfr=1",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-metadata", `comment=${marker}`,
    "-progress", progressPath
  ];
  if (protocol === "RTMP") args.push("-flvflags", "no_duration_filesize", "-f", "flv", outputUrl);
  else args.push("-muxdelay", "0", "-f", "mpegts", outputUrl);
  return {
    court,
    marker,
    protocol,
    ffmpegPath,
    args,
    progressPath,
    logPath,
    outputUrl,
    redacted: { court, marker, protocol, host, rawPath: `court${court}_raw`, progressPath, logPath }
  };
}

export class SyntheticPublisherManager {
  constructor({ spawnImpl = spawn, runner = runCommand, killImpl = process.kill, sleep = delay } = {}) {
    this.spawnImpl = spawnImpl;
    this.runner = runner;
    this.killImpl = killImpl;
    this.sleep = sleep;
  }

  async preflight(ffmpegPath) {
    const [protocols, encoders, filters] = await Promise.all([
      this.runner(ffmpegPath, ["-hide_banner", "-protocols"]),
      this.runner(ffmpegPath, ["-hide_banner", "-encoders"]),
      this.runner(ffmpegPath, ["-hide_banner", "-filters"])
    ]);
    const combined = `${protocols.stdout}\n${protocols.stderr}\n${encoders.stdout}\n${encoders.stderr}\n${filters.stdout}\n${filters.stderr}`;
    for (const required of ["rtmp", "srt", "libx264", "aac", "drawtext", "drawbox", "testsrc2", "sine"]) {
      if (!new RegExp(`(^|\\s)${required}(\\s|$)`, "m").test(combined)) throw new Error(`FFmpeg rehearsal preflight is missing ${required}`);
    }
    return { healthy: true };
  }

  async inspect(marker) {
    validateMarker(marker);
    const result = await this.runner("ps", ["-axo", "pid=,command="]);
    const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(`comment=${marker}`));
    if (matches.length > 1) throw new Error(`multiple synthetic publishers exist for ${marker}`);
    if (!matches.length) return null;
    const match = /^(\d+)\s+(.+)$/.exec(matches[0]);
    if (!match) throw new Error(`synthetic publisher process inventory is invalid for ${marker}`);
    return { pid: Number(match[1]), marker, commandSha256: await sha256Text(match[2]) };
  }

  async ensure(config) {
    validateConfig(config);
    const existing = await this.inspect(config.marker);
    if (existing) return { ...existing, adopted: true, startedAt: null, ...config.redacted };
    await mkdir(resolve(config.logPath, ".."), { recursive: true, mode: 0o700 });
    await chmod(resolve(config.logPath, ".."), 0o700);
    const log = await open(config.logPath, "a", 0o600);
    let child;
    try {
      child = this.spawnImpl(config.ffmpegPath, config.args, { detached: true, stdio: ["ignore", log.fd, log.fd] });
      if (!Number.isInteger(child.pid) || child.pid < 2) throw new Error("synthetic publisher did not return a process id");
    } finally {
      await log.close();
    }
    await this.sleep(2_000);
    const observed = await this.inspect(config.marker);
    if (!observed || observed.pid !== child.pid) throw new Error(`synthetic publisher Camera ${config.court} did not remain running`);
    return { ...observed, adopted: false, startedAt: new Date().toISOString(), ...config.redacted };
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
  if (!value || !COURTS.includes(value.court) || !MARKER.test(value.marker) || !Array.isArray(value.args) || !value.args.includes(`comment=${value.marker}`)) {
    throw new Error("synthetic publisher configuration is invalid");
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

async function sha256Text(value) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

export { COURTS };
