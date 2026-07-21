import { spawn } from "node:child_process";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isRetryableDeploymentTransportError } from "./stack-deployer.mjs";

const OUTPUT_PROFILES = Object.freeze({
  "1080p30": Object.freeze({ width: 1920, height: 1080, framesPerSecond: 30, videoBitrateKbps: 10_000 }),
  "1080p60": Object.freeze({ width: 1920, height: 1080, framesPerSecond: 60, videoBitrateKbps: 12_000 })
});

export class ProductionSourceProbe {
  constructor({ sshKey, knownHosts, runner = runCommand, sleep = delay }) {
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.runner = runner;
    this.sleep = sleep;
  }

  async probe({ host, court }) {
    validateCourt(court);
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host ?? "")) throw new Error("ingest SSH host must be an IPv4 address");
    const command = [
      "docker exec mediamtx ffprobe",
      "-v error -rtsp_transport tcp -analyzeduration 5000000 -probesize 10000000",
      "-select_streams v:0",
      "-show_entries stream=codec_name,profile,width,height,avg_frame_rate,r_frame_rate,field_order,pix_fmt",
      `-of json rtsp://127.0.0.1:8554/court${court}_raw`
    ].join(" ");
    const args = [
      "-i", this.sshKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ];
    let result;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        result = await this.runner("ssh", args);
        break;
      } catch (error) {
        if (attempt === 3 || !isRetryableDeploymentTransportError(error)) throw error;
        await this.sleep(attempt * 2_000);
      }
    }
    return selectProductionOutputProfile(parseProbe(result?.stdout));
  }
}

export function selectProductionOutputProfile(value) {
  const streams = value?.streams;
  if (!Array.isArray(streams) || streams.length !== 1) throw new Error("camera source probe must contain exactly one video stream");
  const stream = streams[0];
  const codecName = String(stream.codec_name ?? "").toLowerCase();
  const codec = codecName === "h264" ? "H264" : new Set(["hevc", "h265"]).has(codecName) ? "H265" : null;
  if (!codec) throw new Error("camera source must use H.264 or H.265 video");
  if (stream.width !== 1920 || stream.height !== 1080) throw new Error(`camera source must be 1920x1080; observed ${stream.width ?? "unknown"}x${stream.height ?? "unknown"}`);
  if (!new Set([undefined, null, "unknown", "progressive"]).has(stream.field_order)) throw new Error("camera source must be progressive, not interlaced");
  const framesPerSecond = preferredFrameRate(stream);
  const profile = Math.abs(framesPerSecond - 30) <= 1 ? "1080p30" : Math.abs(framesPerSecond - 60) <= 1 ? "1080p60" : null;
  if (!profile) throw new Error(`camera source frame rate must be approximately 30 or 60 fps; observed ${framesPerSecond.toFixed(3)}`);
  return {
    profile,
    ...OUTPUT_PROFILES[profile],
    source: {
      codec,
      profile: typeof stream.profile === "string" ? stream.profile : null,
      pixelFormat: typeof stream.pix_fmt === "string" ? stream.pix_fmt : null,
      fieldOrder: typeof stream.field_order === "string" ? stream.field_order : null,
      measuredFramesPerSecond: framesPerSecond
    }
  };
}

export function parseFrameRate(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !value || /[^0-9./]/.test(value)) return null;
  const match = /^(\d+)(?:\/(\d+))?$/.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return null;
  return numerator / denominator;
}

function preferredFrameRate(stream) {
  const average = parseFrameRate(stream.avg_frame_rate);
  const nominal = parseFrameRate(stream.r_frame_rate);
  const value = average ?? nominal;
  if (value === null) throw new Error("camera source frame rate is unavailable");
  return value;
}

function parseProbe(raw) {
  let value;
  try { value = JSON.parse(String(raw ?? "")); }
  catch { throw new Error("camera source probe returned invalid JSON"); }
  return value;
}

function validateCourt(court) {
  if (!Number.isInteger(court) || court < 1 || court > 8) throw new Error("camera source court must be from 1 through 8");
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

async function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${basename(command)} failed with exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`));
    });
  });
}

export { OUTPUT_PROFILES };
