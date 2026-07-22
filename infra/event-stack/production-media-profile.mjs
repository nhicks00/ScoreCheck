import { spawn } from "node:child_process";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isRetryableDeploymentTransportError } from "./stack-deployer.mjs";

const OUTPUT_PROFILES = Object.freeze({
  "1080p30": Object.freeze({ width: 1920, height: 1080, framesPerSecond: 30, videoBitrateKbps: 10_000 }),
  "1080p60": Object.freeze({ width: 1920, height: 1080, framesPerSecond: 60, videoBitrateKbps: 12_000 })
});
const SOURCE_PATH_MODES = Object.freeze({
  DIRECT_H264: "direct-h264",
  ISOLATED_HEVC_NORMALIZER: "isolated-hevc-normalizer"
});
const FRAME_RATE_MODES = Object.freeze([
  Object.freeze({ id: "30000/1001", value: 30_000 / 1_001, outputProfile: "1080p30" }),
  Object.freeze({ id: "30/1", value: 30, outputProfile: "1080p30" }),
  Object.freeze({ id: "60000/1001", value: 60_000 / 1_001, outputProfile: "1080p60" }),
  Object.freeze({ id: "60/1", value: 60, outputProfile: "1080p60" })
]);

export class ProductionSourceProbe {
  constructor({ sshKey, knownHosts, runner = runCommand, sleep = delay }) {
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.runner = runner;
    this.sleep = sleep;
  }

  async probe({ host, court, sourcePathMode = SOURCE_PATH_MODES.DIRECT_H264, expectedFrameRateMode = null }) {
    validateCourt(court);
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host ?? "")) throw new Error("ingest SSH host must be an IPv4 address");
    validateSourcePathMode(sourcePathMode);
    validateExpectedFrameRateMode(expectedFrameRateMode);
    const raw = await this.#probePath({ host, path: `court${court}_raw` });
    const browser = await this.#probePath({ host, path: `court${court}_preview` });
    return selectProductionOutputProfile(raw, {
      sourcePathMode,
      expectedFrameRateMode,
      browserProbe: browser
    });
  }

  async #probePath({ host, path }) {
    const base = [
      "docker exec mediamtx ffprobe",
      "-v error -rtsp_transport tcp -analyzeduration 5000000 -probesize 10000000"
    ];
    const commands = [
      [
        ...base,
        "-show_entries stream=index,codec_type,codec_name,profile,width,height,avg_frame_rate,r_frame_rate,field_order,pix_fmt,has_b_frames,sample_rate,channels",
        `-of json rtsp://127.0.0.1:8554/${path}`
      ].join(" "),
      [
        ...base,
        "-select_streams v:0 -read_intervals %+6 -show_packets",
        "-show_entries packet=pts_time,dts_time,duration_time,flags",
        `-of json rtsp://127.0.0.1:8554/${path}`
      ].join(" ")
    ];
    const outputs = [];
    for (const command of commands) outputs.push(await this.#runSsh(host, command));
    return { ...parseProbe(outputs[0]?.stdout), packets: parseProbe(outputs[1]?.stdout).packets };
  }

  async #runSsh(host, command) {
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
    return result;
  }
}

export function selectProductionOutputProfile(value, options = {}) {
  const sourcePathMode = options.sourcePathMode ?? SOURCE_PATH_MODES.DIRECT_H264;
  validateSourcePathMode(sourcePathMode);
  validateExpectedFrameRateMode(options.expectedFrameRateMode ?? null);
  const rawVideo = onlyVideoStream(value, "camera source");
  const rawAudio = onlyAudioStream(value, "camera source");
  const codec = videoCodec(value);
  const expectedRawCodec = sourcePathMode === SOURCE_PATH_MODES.DIRECT_H264 ? "H264" : "H265";
  if (codec !== expectedRawCodec) {
    throw new Error(sourcePathMode === SOURCE_PATH_MODES.DIRECT_H264
      ? "camera source must use H.264 for direct WHEP; HEVC requires an assigned isolated normalizer"
      : "isolated HEVC normalization requires an H.265 camera source");
  }
  validateRawAudio(rawAudio);
  const sourceRate = classifyFrameRate(rawVideo, options.expectedFrameRateMode ?? null, "camera source");
  validateVideoGeometry(rawVideo, "camera source");
  validateRawVideo(rawVideo, codec);
  const sourcePacketEvidence = validatePacketTrace(value?.packets, { label: "camera source", requireMonotonicPts: codec === "H264" });

  const browserProbe = options.browserProbe;
  if (!browserProbe) throw new Error("browser input probe is required");
  const browserVideo = onlyVideoStream(browserProbe, "browser input");
  const browserAudio = onlyAudioStream(browserProbe, "browser input");
  if (videoCodec(browserProbe) !== "H264") throw new Error("browser input must be H.264; HEVC cannot enter Linux Chromium WHEP");
  validateVideoGeometry(browserVideo, "browser input");
  const browserRate = classifyFrameRate(browserVideo, sourceRate.id, "browser input");
  validateBrowserVideo(browserVideo);
  validateBrowserAudio(browserAudio);
  const packetEvidence = validatePacketTrace(browserProbe?.packets, { label: "browser input" });
  const profile = sourceRate.outputProfile;
  return {
    profile,
    ...OUTPUT_PROFILES[profile],
    sourcePathMode,
    source: {
      codec,
      profile: textOrNull(rawVideo.profile),
      pixelFormat: textOrNull(rawVideo.pix_fmt),
      fieldOrder: textOrNull(rawVideo.field_order),
      hasBFrames: rawVideo.has_b_frames,
      frameRateMode: sourceRate.id,
      measuredFramesPerSecond: sourceRate.measured,
      audioCodec: String(rawAudio.codec_name).toUpperCase(),
      audioSampleRateHz: Number(rawAudio.sample_rate),
      audioChannelCount: rawAudio.channels,
      ...sourcePacketEvidence
    },
    browserInput: {
      codec: "H264",
      profile: textOrNull(browserVideo.profile),
      pixelFormat: browserVideo.pix_fmt,
      fieldOrder: browserVideo.field_order,
      hasBFrames: browserVideo.has_b_frames,
      frameRateMode: browserRate.id,
      measuredFramesPerSecond: browserRate.measured,
      audioCodec: String(browserAudio.codec_name).toUpperCase(),
      audioSampleRateHz: Number(browserAudio.sample_rate),
      audioChannelCount: browserAudio.channels,
      ...packetEvidence
    }
  };
}

function onlyVideoStream(value, label) {
  const streams = value?.streams;
  const video = Array.isArray(streams) ? streams.filter((stream) => stream?.codec_type === "video") : [];
  if (video.length !== 1) throw new Error(`${label} probe must contain exactly one video stream`);
  return video[0];
}

function onlyAudioStream(value, label) {
  const streams = value?.streams;
  const audio = Array.isArray(streams) ? streams.filter((stream) => stream?.codec_type === "audio") : [];
  if (audio.length !== 1) throw new Error(`${label} probe must contain exactly one audio stream`);
  return audio[0];
}

function videoCodec(value) {
  const codecName = String(onlyVideoStream(value, "video").codec_name ?? "").toLowerCase();
  if (codecName === "h264") return "H264";
  if (new Set(["hevc", "h265"]).has(codecName)) return "H265";
  throw new Error("camera source must use H.264 or H.265 video");
}

function validateVideoGeometry(stream, label) {
  if (stream.width !== 1920 || stream.height !== 1080) {
    throw new Error(`${label} must be 1920x1080; observed ${stream.width ?? "unknown"}x${stream.height ?? "unknown"}`);
  }
  if (stream.field_order !== "progressive") throw new Error(`${label} must explicitly report progressive scan`);
}

function validateBrowserVideo(stream) {
  if (stream.pix_fmt !== "yuv420p") throw new Error(`browser input pixel format must be yuv420p; observed ${stream.pix_fmt ?? "unknown"}`);
  if (stream.has_b_frames !== 0) throw new Error(`browser input must have zero B-frames; observed ${stream.has_b_frames ?? "unknown"}`);
}

function validateRawVideo(stream, codec) {
  if (stream.pix_fmt !== "yuv420p") throw new Error(`camera source pixel format must be yuv420p; observed ${stream.pix_fmt ?? "unknown"}`);
  if (!Number.isInteger(stream.has_b_frames) || stream.has_b_frames < 0) throw new Error("camera source B-frame metadata is unavailable");
  if (codec === "H264" && stream.has_b_frames !== 0) throw new Error(`direct H.264 camera source must have zero B-frames; observed ${stream.has_b_frames}`);
}

function validateRawAudio(stream) {
  if (String(stream.codec_name ?? "").toLowerCase() !== "aac") throw new Error("camera source audio must be AAC");
  if (Number(stream.sample_rate) !== 48_000 || stream.channels !== 2) throw new Error("camera source audio must be 48 kHz stereo");
}

function validateBrowserAudio(stream) {
  if (String(stream.codec_name ?? "").toLowerCase() !== "opus") throw new Error("browser input audio must be OPUS");
  if (Number(stream.sample_rate) !== 48_000 || stream.channels !== 2) throw new Error("browser input audio must be 48 kHz stereo");
}

function classifyFrameRate(stream, expectedMode, label) {
  const measured = preferredFrameRate(stream);
  const match = FRAME_RATE_MODES.find((mode) => Math.abs(measured - mode.value) <= 0.001);
  if (!match) throw new Error(`${label} frame rate must be exactly 29.97, 30, 59.94, or 60 fps; observed ${measured.toFixed(3)}`);
  if (expectedMode && match.id !== expectedMode) throw new Error(`${label} frame rate ${match.id} does not match expected ${expectedMode}`);
  return { ...match, measured };
}

function validatePacketTrace(value, { label = "browser input", requireMonotonicPts = true } = {}) {
  if (!Array.isArray(value) || value.length < 30) throw new Error(`${label} packet trace is too short`);
  const packets = value.map((packet, index) => {
    const pts = Number(packet?.pts_time);
    const dts = Number(packet?.dts_time);
    if (!Number.isFinite(pts) || !Number.isFinite(dts)) throw new Error(`${label} packet ${index + 1} has no finite PTS/DTS`);
    return { pts, dts, key: String(packet?.flags ?? "").includes("K") };
  });
  for (let index = 1; index < packets.length; index += 1) {
    if (packets[index].dts <= packets[index - 1].dts) throw new Error(`${label} DTS is not strictly monotonic`);
    if (requireMonotonicPts && packets[index].pts < packets[index - 1].pts) throw new Error(`${label} PTS moved backward`);
    if (packets[index].dts - packets[index - 1].dts > 1) throw new Error(`${label} timestamp gap exceeds one second`);
  }
  const keyframes = packets.filter((packet) => packet.key).map((packet) => packet.pts);
  if (keyframes.length < 2) throw new Error(`${label} packet trace does not contain two keyframes`);
  const keyframeGaps = keyframes.slice(1).map((value, index) => value - keyframes[index]);
  const maximumKeyframeIntervalSeconds = Math.max(...keyframeGaps);
  if (maximumKeyframeIntervalSeconds > 2.1) throw new Error(`${label} keyframe interval exceeds two seconds (${maximumKeyframeIntervalSeconds.toFixed(3)}s)`);
  return {
    packetCount: packets.length,
    keyframeCount: keyframes.length,
    maximumKeyframeIntervalSeconds
  };
}

function validateSourcePathMode(value) {
  if (!Object.values(SOURCE_PATH_MODES).includes(value)) throw new Error("sourcePathMode is invalid");
}

function validateExpectedFrameRateMode(value) {
  if (value !== null && !FRAME_RATE_MODES.some((mode) => mode.id === value)) throw new Error("expectedFrameRateMode is invalid");
}

function textOrNull(value) {
  return typeof value === "string" && value ? value : null;
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

export { FRAME_RATE_MODES, OUTPUT_PROFILES, SOURCE_PATH_MODES };
