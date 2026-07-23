import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isRetryableDeploymentTransportError } from "./stack-deployer.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const EGRESS_ID = /^EG_[A-Za-z0-9]+$/;
const EVIDENCE_ID = /^[A-Za-z0-9-]{8,80}$/;
const PROFILES = Object.freeze({
  "1080p30": Object.freeze({ framesPerSecond: 30, videoBitrateBps: 10_000_000 }),
  "1080p60": Object.freeze({ framesPerSecond: 60, videoBitrateBps: 12_000_000 })
});

export class OutputConformanceRuntime {
  constructor({ sshKey, knownHosts, ffprobePath, runner = runCommand, sleep = delay, now = () => new Date() }) {
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.ffprobePath = requiredPath(ffprobePath, "FFprobe");
    this.runner = runner;
    this.sleep = sleep;
    this.now = now;
  }

  async qualify({ host, court, profile, evidenceId, outputDirectory, renderer }) {
    validateHost(host);
    validateCourt(court);
    profileContract(profile);
    if (typeof evidenceId !== "string" || !EVIDENCE_ID.test(evidenceId)) throw new Error("output conformance evidence id is invalid");
    validateRenderer(renderer);
    const directory = requiredPath(outputDirectory, "output conformance directory");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const receiptResult = await this.#remote(host, `cd /opt/compositor && ./qualify-output.sh ${court} ${profile} ${evidenceId}`);
    const receipt = parseCaptureReceipt(receiptResult.stdout, { evidenceId, court, profile, renderer });
    const expectedRemotePath = `/opt/compositor/evidence/${evidenceId}/court-${court}-${profile}.mp4`;
    if (receipt.remotePath !== expectedRemotePath) throw new Error("output conformance sample path is not bound to this run");

    const samplePath = join(directory, `court-${court}-${profile}.mp4`);
    await this.#copy(host, receipt.remotePath, samplePath);
    await chmod(samplePath, 0o600);
    const information = await stat(samplePath);
    if (!information.isFile() || information.size !== receipt.sizeBytes) throw new Error("copied output conformance sample size differs from the compositor receipt");
    const localSha256 = sha256(await readFile(samplePath));
    if (localSha256 !== receipt.sha256) throw new Error("copied output conformance sample digest differs from the compositor receipt");

    const [version, metadata, packets, audioPackets] = await Promise.all([
      this.runner(this.ffprobePath, ["-version"]),
      this.runner(this.ffprobePath, [
        "-v", "error",
        "-show_entries", "stream=index,codec_type,codec_name,profile,width,height,avg_frame_rate,r_frame_rate,field_order,pix_fmt,has_b_frames,sample_aspect_ratio,color_space,color_transfer,color_primaries,sample_rate,channels,channel_layout,bit_rate:format=duration,size,bit_rate,format_name",
        "-of", "json",
        samplePath
      ]),
      this.runner(this.ffprobePath, [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_packets",
        "-show_entries", "packet=pts_time,dts_time,duration_time,size,flags",
        "-of", "json",
        samplePath
      ]),
      this.runner(this.ffprobePath, [
        "-v", "error",
        "-select_streams", "a:0",
        "-show_packets",
        "-show_entries", "packet=pts_time,dts_time,duration_time,size",
        "-of", "json",
        samplePath
      ])
    ]);
    const evidence = evaluateOutputConformance({
      receipt,
      metadata: parseJson(metadata.stdout, "output metadata"),
      packets: parseJson(packets.stdout, "output packet trace"),
      audioPackets: parseJson(audioPackets.stdout, "output audio packet trace"),
      ffprobeVersion: firstLine(version.stdout),
      localSha256,
      observedAt: this.now().toISOString()
    });
    const evidencePath = join(directory, `court-${court}-${profile}.json`);
    await writeProtectedAtomic(evidencePath, evidence);
    return { ...evidence, evidencePath, samplePath };
  }

  async #remote(host, command) {
    const args = sshArgs(this.sshKey, this.knownHosts, host, command);
    return this.#retry("ssh", args);
  }

  async #copy(host, remotePath, localPath) {
    const args = [
      "-i", this.sshKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}:${remotePath}`,
      localPath
    ];
    await this.#retry("scp", args);
  }

  async #retry(command, args) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.runner(command, args);
      } catch (error) {
        if (attempt === 3 || !isRetryableDeploymentTransportError(error)) throw error;
        await this.sleep(attempt * 2_000);
      }
    }
    throw new Error("output conformance transport retry loop exited unexpectedly");
  }
}

export function evaluateOutputConformance({ receipt, metadata, packets, audioPackets, ffprobeVersion, localSha256, observedAt }) {
  const profile = profileContract(receipt?.profile);
  parseCaptureReceipt(JSON.stringify(receipt), receipt);
  if (!SHA256.test(localSha256 ?? "") || localSha256 !== receipt.sha256) throw new Error("output conformance sample digest is invalid");
  if (typeof ffprobeVersion !== "string" || !/^ffprobe version /u.test(ffprobeVersion)) throw new Error("output conformance ffprobe version is invalid");
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("output conformance observation time is invalid");

  const streams = Array.isArray(metadata?.streams) ? metadata.streams : [];
  const videos = streams.filter((stream) => stream?.codec_type === "video");
  const audios = streams.filter((stream) => stream?.codec_type === "audio");
  if (streams.length !== 2 || videos.length !== 1 || audios.length !== 1) throw new Error("output sample must contain exactly one video and one audio stream");
  const video = videos[0];
  const audio = audios[0];
  if (String(video.codec_name).toLowerCase() !== "h264" || String(video.profile).toLowerCase() !== "high") throw new Error("output video must be H.264 High profile");
  if (video.width !== 1920 || video.height !== 1080) throw new Error("output video must be 1920x1080");
  if (video.field_order !== "progressive" || video.pix_fmt !== "yuv420p") throw new Error("output video must be progressive yuv420p");
  if (video.sample_aspect_ratio !== "1:1") throw new Error("output video must use square pixels");
  for (const field of ["color_space", "color_transfer", "color_primaries"]) {
    if (video[field] !== "bt709") throw new Error(`output video ${field} must be bt709`);
  }
  const frameRate = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate);
  if (frameRate === null || Math.abs(frameRate - profile.framesPerSecond) > 0.01) throw new Error("output frame rate does not match the selected profile");

  if (String(audio.codec_name).toLowerCase() !== "aac" || audio.profile !== "LC") throw new Error("output audio must be AAC-LC");
  if (Number(audio.sample_rate) !== 48_000 || audio.channels !== 2 || audio.channel_layout !== "stereo") throw new Error("output audio must be 48 kHz stereo");
  const streamReportedBitrateBps = finiteNumber(audio.bit_rate, "output audio bitrate");
  if (streamReportedBitrateBps <= 0) throw new Error("output audio bitrate must be positive");

  const format = metadata?.format;
  const durationSeconds = finiteNumber(format?.duration, "output duration");
  if (durationSeconds < 15 || durationSeconds > 60) throw new Error("output conformance sample duration must be from 15 through 60 seconds");
  if (!String(format?.format_name ?? "").split(",").some((value) => value === "mp4")) throw new Error("output conformance sample must use an MP4 container");

  const packetEvidence = evaluateVideoPackets(packets?.packets, profile, durationSeconds);
  const audioPacketEvidence = evaluateAudioPackets(audioPackets?.packets, durationSeconds);
  return {
    schemaVersion: 1,
    status: "QUALIFIED",
    evidenceId: receipt.evidenceId,
    capturedAt: receipt.capturedAt,
    observedAt,
    court: receipt.court,
    profile: receipt.profile,
    egressId: receipt.egressId,
    renderer: { ...receipt.renderer },
    sample: {
      sha256: receipt.sha256,
      sizeBytes: receipt.sizeBytes,
      durationSeconds,
      ffprobeVersion
    },
    startup: structuredClone(receipt.startup),
    video: {
      codec: "H264",
      profile: video.profile,
      width: video.width,
      height: video.height,
      framesPerSecond: frameRate,
      pixelFormat: video.pix_fmt,
      fieldOrder: video.field_order,
      sampleAspectRatio: video.sample_aspect_ratio,
      colorSpace: video.color_space,
      colorTransfer: video.color_transfer,
      colorPrimaries: video.color_primaries,
      hasBFrames: video.has_b_frames,
      targetBitrateBps: profile.videoBitrateBps,
      ...packetEvidence
    },
    audio: {
      codec: "AAC",
      sampleRateHz: Number(audio.sample_rate),
      channels: audio.channels,
      channelLayout: audio.channel_layout,
      targetBitrateBps: receipt.encoding.audioTargetBitrateKbps * 1_000,
      streamReportedBitrateBps,
      ...audioPacketEvidence
    }
  };
}

function evaluateAudioPackets(value, durationSeconds) {
  if (!Array.isArray(value) || value.length < durationSeconds * 40) throw new Error("output audio packet trace is too short");
  const packets = value.map((packet, index) => {
    const pts = finiteNumber(packet?.pts_time, `output audio packet ${index + 1} PTS`);
    const dts = finiteNumber(packet?.dts_time, `output audio packet ${index + 1} DTS`);
    const duration = finiteNumber(packet?.duration_time, `output audio packet ${index + 1} duration`);
    const size = finiteNumber(packet?.size, `output audio packet ${index + 1} size`);
    if (duration <= 0 || size <= 0) throw new Error("output audio packet duration and size must be positive");
    return { pts, dts, duration, size };
  });
  let maximumPacketGapSeconds = 0;
  for (let index = 1; index < packets.length; index += 1) {
    const gap = packets[index].dts - packets[index - 1].dts;
    if (gap <= 0) throw new Error("output audio DTS is not strictly monotonic");
    maximumPacketGapSeconds = Math.max(maximumPacketGapSeconds, gap);
  }
  if (maximumPacketGapSeconds > 0.1) throw new Error("output audio packet gap exceeds 100 ms");
  const packetDurationSeconds = packets.at(-1).dts + packets.at(-1).duration - packets[0].dts;
  if (packetDurationSeconds < 14 || Math.abs(packetDurationSeconds - durationSeconds) > 1) throw new Error("output audio packet timeline does not match the sample duration");
  const measuredBitrateBps = packets.reduce((total, packet) => total + packet.size * 8, 0) / packetDurationSeconds;
  return { packetCount: packets.length, packetDurationSeconds, maximumPacketGapSeconds, measuredBitrateBps };
}

function evaluateVideoPackets(value, profile, durationSeconds) {
  if (!Array.isArray(value) || value.length < profile.framesPerSecond * 15) throw new Error("output packet trace is too short");
  const packets = value.map((packet, index) => {
    const pts = finiteNumber(packet?.pts_time, `output packet ${index + 1} PTS`);
    const dts = finiteNumber(packet?.dts_time, `output packet ${index + 1} DTS`);
    const duration = finiteNumber(packet?.duration_time, `output packet ${index + 1} duration`);
    const size = finiteNumber(packet?.size, `output packet ${index + 1} size`);
    if (duration <= 0 || size <= 0) throw new Error("output packet duration and size must be positive");
    return { pts, dts, duration, size, key: String(packet?.flags ?? "").includes("K") };
  });
  for (let index = 1; index < packets.length; index += 1) {
    if (packets[index].dts <= packets[index - 1].dts) throw new Error("output DTS is not strictly monotonic");
    if (packets[index].dts - packets[index - 1].dts > 0.25) throw new Error("output video packet gap exceeds 250 ms");
  }
  const keyframes = packets.filter((packet) => packet.key).map((packet) => packet.pts).sort((left, right) => left - right);
  if (keyframes.length < 7) throw new Error("output packet trace has too few keyframes");
  const keyframeIntervals = keyframes.slice(1).map((value, index) => value - keyframes[index]);
  const minimumKeyframeIntervalSeconds = Math.min(...keyframeIntervals);
  const maximumKeyframeIntervalSeconds = Math.max(...keyframeIntervals);
  if (minimumKeyframeIntervalSeconds < 1.7 || maximumKeyframeIntervalSeconds > 2.2) throw new Error("output keyframe interval is not approximately two seconds");

  const packetStart = packets[0].dts;
  const packetEnd = packets.at(-1).dts + packets.at(-1).duration;
  const packetDurationSeconds = packetEnd - packetStart;
  if (packetDurationSeconds < 14 || Math.abs(packetDurationSeconds - durationSeconds) > 3) throw new Error("output packet timeline does not match the sample duration");
  const measuredBitrateBps = packets.reduce((total, packet) => total + packet.size * 8, 0) / packetDurationSeconds;
  if (measuredBitrateBps < profile.videoBitrateBps * 0.85 || measuredBitrateBps > profile.videoBitrateBps * 1.15) {
    throw new Error("output video bitrate is outside the selected profile window");
  }
  const buckets = new Map();
  for (const packet of packets) {
    const second = Math.floor(packet.dts - packetStart);
    buckets.set(second, (buckets.get(second) ?? 0) + packet.size * 8);
  }
  const completeSecondBuckets = [...buckets.entries()]
    .filter(([second]) => second >= 1 && second < Math.floor(packetDurationSeconds) - 1);
  if (completeSecondBuckets.length < 10) throw new Error("output sample has too few complete bitrate buckets");
  const completeSecondBitrates = completeSecondBuckets.map(([, bits]) => bits);
  const minimumSecondBitrateBps = Math.min(...completeSecondBitrates);
  const maximumSecondBitrateBps = Math.max(...completeSecondBitrates);
  if (minimumSecondBitrateBps < profile.videoBitrateBps * 0.5 || maximumSecondBitrateBps > profile.videoBitrateBps * 1.5) {
    throw new Error("output video bitrate has an excessive one-second burst");
  }
  const rollingTwoSecondBitrates = completeSecondBuckets.slice(1).map(([second, bits], index) => {
    const [previousSecond, previousBits] = completeSecondBuckets[index];
    if (second !== previousSecond + 1) throw new Error("output sample has a missing bitrate bucket");
    return (previousBits + bits) / 2;
  });
  const minimumTwoSecondBitrateBps = Math.min(...rollingTwoSecondBitrates);
  const maximumTwoSecondBitrateBps = Math.max(...rollingTwoSecondBitrates);
  if (minimumTwoSecondBitrateBps < profile.videoBitrateBps * 0.7 || maximumTwoSecondBitrateBps > profile.videoBitrateBps * 1.3) {
    throw new Error("output video bitrate is not bounded near CBR");
  }
  return {
    packetCount: packets.length,
    keyframeCount: keyframes.length,
    minimumKeyframeIntervalSeconds,
    maximumKeyframeIntervalSeconds,
    measuredBitrateBps,
    minimumSecondBitrateBps,
    maximumSecondBitrateBps,
    minimumTwoSecondBitrateBps,
    maximumTwoSecondBitrateBps
  };
}

function parseCaptureReceipt(raw, expected = {}) {
  const value = typeof raw === "string" ? parseJson(raw, "output conformance capture receipt") : raw;
  if (!value || value.schemaVersion !== 1 || !EVIDENCE_ID.test(value.evidenceId ?? "") || !Number.isFinite(Date.parse(value.capturedAt))) throw new Error("output conformance capture receipt is invalid");
  validateCourt(value.court);
  const profile = profileContract(value.profile);
  if (!EGRESS_ID.test(value.egressId ?? "") || !requiredPath(value.remotePath, "output conformance remote path") || !SHA256.test(value.sha256 ?? "") || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 1) throw new Error("output conformance capture receipt is incomplete");
  validateRenderer(value.renderer);
  validateCaptureEncoding(value.encoding, profile);
  validateCaptureStartup(value.startup);
  for (const key of ["evidenceId", "court", "profile"]) {
    if (expected[key] !== undefined && value[key] !== expected[key]) throw new Error(`output conformance capture receipt ${key} changed`);
  }
  if (expected.renderer && (value.renderer.gitSha !== expected.renderer.gitSha || value.renderer.deploymentId !== expected.renderer.deploymentId)) throw new Error("output conformance capture receipt renderer changed");
  return value;
}

function validateCaptureStartup(value) {
  if (!value || !Number.isInteger(value.startAttempts) || value.startAttempts < 1 || value.startAttempts > 2 || typeof value.recoveredStartingStall !== "boolean" || !Array.isArray(value.attempts) || value.attempts.length !== value.startAttempts) {
    throw new Error("output conformance capture startup evidence is invalid");
  }
  for (const [index, attempt] of value.attempts.entries()) {
    if (attempt?.number !== index + 1 || !EGRESS_ID.test(attempt.egressId ?? "") || !Number.isFinite(Date.parse(attempt.observedAt ?? "")) || !new Set(["ACTIVE", "STARTING_TIMEOUT"]).has(attempt.outcome)) {
      throw new Error("output conformance capture startup attempt is invalid");
    }
  }
  if (value.attempts.at(-1).outcome !== "ACTIVE") throw new Error("output conformance capture did not end active");
  const expectedRecovery = value.startAttempts === 2 && value.attempts[0].outcome === "STARTING_TIMEOUT";
  if (value.recoveredStartingStall !== expectedRecovery || (value.startAttempts === 1 && value.attempts[0].outcome !== "ACTIVE")) {
    throw new Error("output conformance capture startup recovery evidence is inconsistent");
  }
}

function validateCaptureEncoding(value, profile) {
  const expected = {
    width: 1920,
    height: 1080,
    framesPerSecond: profile.framesPerSecond,
    audioCodec: "AAC",
    audioTargetBitrateKbps: 128,
    audioSampleRateHz: 48_000,
    videoCodec: "H264_HIGH",
    videoTargetBitrateKbps: profile.videoBitrateBps / 1_000,
    keyFrameIntervalSeconds: 2
  };
  if (!value || typeof value !== "object") throw new Error("output conformance capture encoding is missing");
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) throw new Error(`output conformance capture encoding ${key} is invalid`);
  }
}

function validateRenderer(value) {
  if (!value || typeof value !== "object" || !/^[a-f0-9]{40}$/u.test(value.gitSha ?? "") || !/^dpl_[A-Za-z0-9]+$/u.test(value.deploymentId ?? "")) throw new Error("output conformance renderer identity is invalid");
}

function profileContract(value) {
  const profile = PROFILES[value];
  if (!profile) throw new Error("output conformance profile is invalid");
  return profile;
}

function parseFrameRate(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\/(\d+)$/u.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} is unavailable`);
  return number;
}

function parseJson(raw, label) {
  try { return JSON.parse(String(raw ?? "")); }
  catch { throw new Error(`${label} is invalid JSON`); }
}

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/u)[0];
}

function validateHost(value) {
  if (typeof value !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) throw new Error("output conformance SSH host must be an IPv4 address");
}

function validateCourt(value) {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error("output conformance court must be from 1 through 8");
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return resolve(value);
}

function sshArgs(sshKey, knownHosts, host, command) {
  return [
    "-i", sshKey,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "ConnectTimeout=10",
    `root@${host}`,
    command
  ];
}

async function writeProtectedAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
      if (code === 0) resolvePromise({ code, stdout, stderr });
      else reject(new Error(`${basename(command)} failed with exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`));
    });
  });
}
