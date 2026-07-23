import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateOutputConformance, OutputConformanceRuntime } from "./output-conformance.mjs";

const RECEIPT = Object.freeze({
  schemaVersion: 1,
  evidenceId: "00000000-0000-4000-8000-000000000001",
  capturedAt: "2026-07-21T12:00:00.000Z",
  court: 1,
  profile: "1080p30",
  egressId: "EG_sample",
  renderer: { gitSha: "b".repeat(40), deploymentId: "dpl_renderer123" },
  encoding: {
    width: 1920,
    height: 1080,
    framesPerSecond: 30,
    audioCodec: "AAC",
    audioTargetBitrateKbps: 128,
    audioSampleRateHz: 48_000,
    videoCodec: "H264_HIGH",
    videoTargetBitrateKbps: 10_000,
    keyFrameIntervalSeconds: 2
  },
  startup: {
    startAttempts: 1,
    recoveredStartingStall: false,
    attempts: [{ number: 1, egressId: "EG_sample", outcome: "ACTIVE", observedAt: "2026-07-21T12:00:20.000Z" }]
  },
  remotePath: "/opt/compositor/evidence/00000000-0000-4000-8000-000000000001/court-1-1080p30.mp4",
  sha256: "a".repeat(64),
  sizeBytes: 100
});

function fixture({ profile = "1080p30", bitrateScale = 1, keyframeSeconds = 2, audioBitrateBps = 95_243, secondBitrateScales = {} } = {}) {
  const fps = profile === "1080p60" ? 60 : 30;
  const target = profile === "1080p60" ? 12_000_000 : 10_000_000;
  const duration = 20;
  const packets = Array.from({ length: duration * fps }, (_, index) => ({
    pts_time: String(index / fps),
    dts_time: String(index / fps),
    duration_time: String(1 / fps),
    size: String(Math.round((target * bitrateScale * (secondBitrateScales[Math.floor(index / fps)] ?? 1)) / 8 / fps)),
    flags: index % Math.round(keyframeSeconds * fps) === 0 ? "K__" : "___"
  }));
  const audioPacketDuration = 1_024 / 48_000;
  const audioPacketSize = Math.round(audioBitrateBps * audioPacketDuration / 8);
  const audioPackets = Array.from({ length: Math.ceil(duration / audioPacketDuration) }, (_, index) => ({
    pts_time: String(index * audioPacketDuration),
    dts_time: String(index * audioPacketDuration),
    duration_time: String(audioPacketDuration),
    size: String(audioPacketSize)
  }));
  return {
    receipt: {
      ...RECEIPT,
      profile,
      encoding: {
        ...RECEIPT.encoding,
        framesPerSecond: fps,
        videoTargetBitrateKbps: target / 1_000
      }
    },
    metadata: {
      streams: [
        {
          index: 0, codec_type: "video", codec_name: "h264", profile: "High", width: 1920, height: 1080,
          avg_frame_rate: `${fps}/1`, r_frame_rate: `${fps}/1`, field_order: "progressive", pix_fmt: "yuv420p",
          has_b_frames: 2, sample_aspect_ratio: "1:1", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709"
        },
        { index: 1, codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2, channel_layout: "stereo", bit_rate: String(audioBitrateBps) }
      ],
      format: { duration: String(duration), size: "100", bit_rate: String(target + audioBitrateBps), format_name: "mov,mp4,m4a,3gp,3g2,mj2" }
    },
    packets: { packets },
    audioPackets: { packets: audioPackets },
    ffprobeVersion: "ffprobe version 7.1",
    localSha256: "a".repeat(64),
    observedAt: "2026-07-21T12:01:00.000Z"
  };
}

test("qualifies actual 1080p30 and 1080p60 H.264 High/AAC output", () => {
  for (const profile of ["1080p30", "1080p60"]) {
    const evidence = evaluateOutputConformance(fixture({ profile }));
    assert.equal(evidence.status, "QUALIFIED");
    assert.equal(evidence.profile, profile);
    assert.equal(evidence.video.maximumKeyframeIntervalSeconds, 2);
    assert.ok(evidence.video.measuredBitrateBps > evidence.video.targetBitrateBps * 0.99);
    assert.equal(evidence.audio.targetBitrateBps, 128_000);
    assert.ok(evidence.audio.measuredBitrateBps > 90_000);
    assert.equal(evidence.startup.startAttempts, 1);
  }

  const boundedVbvBurst = evaluateOutputConformance(fixture({ secondBitrateScales: { 4: 1.345, 5: 0.95 } }));
  assert.ok(boundedVbvBurst.video.maximumSecondBitrateBps > boundedVbvBurst.video.targetBitrateBps * 1.3);
  assert.ok(boundedVbvBurst.video.maximumTwoSecondBitrateBps < boundedVbvBurst.video.targetBitrateBps * 1.3);
});

test("rejects profile, color, GOP, bitrate, and audio drift", () => {
  const wrongProfile = fixture();
  wrongProfile.metadata.streams[0].profile = "Main";
  assert.throws(() => evaluateOutputConformance(wrongProfile), /H\.264 High/u);

  const wrongColor = fixture();
  wrongColor.metadata.streams[0].color_space = "unknown";
  assert.throws(() => evaluateOutputConformance(wrongColor), /color_space/u);

  assert.throws(() => evaluateOutputConformance(fixture({ keyframeSeconds: 4 })), /keyframes|keyframe interval/u);
  assert.throws(() => evaluateOutputConformance(fixture({ bitrateScale: 0.5 })), /bitrate/u);

  const wrongAudio = fixture();
  wrongAudio.metadata.streams[1].sample_rate = "44100";
  assert.throws(() => evaluateOutputConformance(wrongAudio), /48 kHz stereo/u);

  const wrongAudioProfile = fixture();
  wrongAudioProfile.metadata.streams[1].profile = "HE-AAC";
  assert.throws(() => evaluateOutputConformance(wrongAudioProfile), /AAC-LC/u);

  const wrongTarget = fixture();
  wrongTarget.receipt.encoding.audioTargetBitrateKbps = 96;
  assert.throws(() => evaluateOutputConformance(wrongTarget), /audioTargetBitrateKbps/u);

  const inconsistentStartup = fixture();
  inconsistentStartup.receipt.startup = { ...inconsistentStartup.receipt.startup, recoveredStartingStall: true };
  assert.throws(() => evaluateOutputConformance(inconsistentStartup), /startup recovery evidence/u);

  const missingAudio = fixture();
  missingAudio.audioPackets.packets = missingAudio.audioPackets.packets.slice(0, 20);
  assert.throws(() => evaluateOutputConformance(missingAudio), /audio packet trace is too short/u);

  const audioGap = fixture();
  audioGap.audioPackets.packets[200].dts_time = String(Number(audioGap.audioPackets.packets[199].dts_time) + 0.2);
  assert.throws(() => evaluateOutputConformance(audioGap), /audio packet gap|audio DTS/u);

  assert.throws(
    () => evaluateOutputConformance(fixture({ secondBitrateScales: { 4: 1.35, 5: 1.35 } })),
    /not bounded near CBR/u
  );
  assert.throws(
    () => evaluateOutputConformance(fixture({ secondBitrateScales: { 4: 1.55, 5: 0.45 } })),
    /excessive one-second burst/u
  );
});

test("captures, copies, probes, hashes, and writes protected event evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-output-conformance-"));
  const outputDirectory = join(root, "evidence");
  const sshKey = join(root, "id");
  const knownHosts = join(root, "known_hosts");
  await writeFile(sshKey, "key", { mode: 0o600 });
  await writeFile(knownHosts, "host", { mode: 0o600 });
  await chmod(root, 0o700);
  const sample = Buffer.from("sample-bytes");
  const sha = createHash("sha256").update(sample).digest("hex");
  const media = fixture();
  const receipt = { ...RECEIPT, sha256: sha, sizeBytes: sample.length };
  const calls = [];
  const runtime = new OutputConformanceRuntime({
    sshKey,
    knownHosts,
    ffprobePath: "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
    now: () => new Date("2026-07-21T12:01:00.000Z"),
    runner: async (command, args) => {
      calls.push([command, args]);
      if (command === "ssh") return { code: 0, stdout: JSON.stringify(receipt), stderr: "" };
      if (command === "scp") {
        await writeFile(args.at(-1), sample);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "-version") return { code: 0, stdout: "ffprobe version 7.1\n", stderr: "" };
      if (args.includes("-show_packets") && args.includes("a:0")) return { code: 0, stdout: JSON.stringify(media.audioPackets), stderr: "" };
      if (args.includes("-show_packets")) return { code: 0, stdout: JSON.stringify(media.packets), stderr: "" };
      return { code: 0, stdout: JSON.stringify(media.metadata), stderr: "" };
    }
  });
  const result = await runtime.qualify({ host: "203.0.113.1", court: 1, profile: "1080p30", evidenceId: receipt.evidenceId, outputDirectory, renderer: receipt.renderer });
  assert.equal(result.status, "QUALIFIED");
  assert.equal((await statMode(result.evidencePath)) & 0o077, 0);
  assert.equal(JSON.parse(await readFile(result.evidencePath, "utf8")).sample.sha256, sha);
  assert.deepEqual(calls.map(([command]) => command), [
    "ssh",
    "scp",
    "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
    "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
    "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
    "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe"
  ]);
});

async function statMode(path) {
  const { stat } = await import("node:fs/promises");
  return (await stat(path)).mode;
}
