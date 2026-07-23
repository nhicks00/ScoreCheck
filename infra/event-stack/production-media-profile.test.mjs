import test from "node:test";
import assert from "node:assert/strict";

import { OUTPUT_PROFILES, parseFrameRate, ProductionSourceProbe, selectProductionOutputProfile, SOURCE_PATH_MODES } from "./production-media-profile.mjs";

test("admits browser-safe H.264 1080p30 and 1080p60 sources into exact YouTube profiles", () => {
  const value = probePayload({ frameRate: "30000/1001" });
  const browser = probePayload({ frameRate: "30000/1001", audioCodec: "opus" });
  assert.deepEqual(selectProductionOutputProfile(value, { browserProbe: browser }), {
    profile: "1080p30",
    ...OUTPUT_PROFILES["1080p30"],
    sourcePathMode: SOURCE_PATH_MODES.DIRECT_H264,
    source: {
      codec: "H264", profile: "Main", pixelFormat: "yuv420p", fieldOrder: "progressive",
      hasBFrames: 0,
      frameRateMode: "30000/1001", measuredFramesPerSecond: 30000 / 1001,
      audioCodec: "AAC", audioSampleRateHz: 48_000, audioChannelCount: 2,
      packetCount: value.packets.length, keyframeCount: 3, maximumKeyframeIntervalSeconds: 2
    },
    browserInput: {
      codec: "H264", profile: "Main", pixelFormat: "yuv420p", fieldOrder: "progressive", hasBFrames: 0,
      frameRateMode: "30000/1001", measuredFramesPerSecond: 30000 / 1001,
      audioCodec: "OPUS", audioSampleRateHz: 48_000, audioChannelCount: 2,
      packetCount: browser.packets.length, keyframeCount: 3, maximumKeyframeIntervalSeconds: 2
    }
  });
  assert.equal(selectProductionOutputProfile(
    probePayload({ frameRate: "60000/1001", framesPerSecond: 60 }),
    { browserProbe: probePayload({ frameRate: "60000/1001", framesPerSecond: 60, audioCodec: "opus" }) }
  ).profile, "1080p60");
});

test("fails closed on direct HEVC, B-frames, unsafe format, scan, cadence, GOP, and timestamps", () => {
  const browser = () => probePayload({ audioCodec: "opus" });
  assert.throws(() => selectProductionOutputProfile(probePayload({ codec: "hevc" }), { browserProbe: browser() }), /requires an assigned isolated normalizer/);
  assert.throws(() => selectProductionOutputProfile(probePayload({ hasBFrames: 2 }), { browserProbe: browser() }), /direct H\.264 camera source must have zero B-frames/);
  assert.throws(() => selectProductionOutputProfile(probePayload({ pixelFormat: "yuv420p10le" }), { browserProbe: browser() }), /camera source pixel format/);
  assert.throws(() => selectProductionOutputProfile(probePayload(), { browserProbe: probePayload({ hasBFrames: 2, audioCodec: "opus" }) }), /zero B-frames/);
  assert.throws(() => selectProductionOutputProfile(probePayload(), { browserProbe: probePayload({ pixelFormat: "yuv420p10le", audioCodec: "opus" }) }), /pixel format/);
  assert.throws(() => selectProductionOutputProfile(probePayload({ fieldOrder: "tt" }), { browserProbe: browser() }), /progressive/);
  assert.throws(() => selectProductionOutputProfile(probePayload({ frameRate: "25/1", framesPerSecond: 25 }), { browserProbe: browser() }), /29\.97, 30, 59\.94, or 60/);
  assert.throws(() => selectProductionOutputProfile(probePayload(), { browserProbe: probePayload({ keyframeIntervalSeconds: 3, audioCodec: "opus" }) }), /keyframe interval/);
  const backward = probePayload();
  backward.packets[20].dts_time = backward.packets[19].dts_time;
  assert.throws(() => selectProductionOutputProfile(backward, { browserProbe: browser() }), /DTS is not strictly monotonic/);
  const leadingJoinArtifact = probePayload();
  leadingJoinArtifact.packets.unshift({ duration_time: "0.033333", flags: "___" });
  assert.doesNotThrow(() => selectProductionOutputProfile(leadingJoinArtifact, { browserProbe: browser() }));
  const midstreamMissingTimestamp = probePayload();
  midstreamMissingTimestamp.packets[20] = { duration_time: "0.033333", flags: "___" };
  assert.throws(() => selectProductionOutputProfile(midstreamMissingTimestamp, { browserProbe: browser() }), /no finite PTS\/DTS/);
  assert.throws(() => selectProductionOutputProfile({ streams: [], packets: [] }, { browserProbe: browser() }), /exactly one/);
});

test("admits HEVC only when an isolated normalizer produces qualified H.264 and Opus", () => {
  const raw = probePayload({ codec: "hevc" });
  const browser = probePayload({ audioCodec: "opus" });
  const result = selectProductionOutputProfile(raw, {
    sourcePathMode: SOURCE_PATH_MODES.ISOLATED_HEVC_NORMALIZER,
    expectedFrameRateMode: "30/1",
    browserProbe: browser
  });
  assert.equal(result.source.codec, "H265");
  assert.equal(result.browserInput.codec, "H264");
  assert.equal(result.browserInput.audioCodec, "OPUS");
  assert.throws(() => selectProductionOutputProfile(raw, {
    sourcePathMode: SOURCE_PATH_MODES.ISOLATED_HEVC_NORMALIZER,
    browserProbe: probePayload({ codec: "hevc", audioCodec: "opus" })
  }), /browser input must be H\.264/);
});

test("parses bounded rational frame rates and rejects malformed or zero values", () => {
  assert.equal(parseFrameRate("30000/1001"), 30000 / 1001);
  assert.equal(parseFrameRate("60"), 60);
  for (const value of ["0/0", "30/0", "30fps", "-30/1", "", null]) assert.equal(parseFrameRate(value), null);
});

test("probes the local MediaMTX raw path over protected SSH and returns the admitted profile", async () => {
  const calls = [];
  const raw = probePayload({ frameRate: "60/1", framesPerSecond: 60 });
  const browser = probePayload({ frameRate: "60/1", framesPerSecond: 60, audioCodec: "opus" });
  const probe = new ProductionSourceProbe({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    runner: async (command, args) => {
      calls.push([command, args]);
      const payload = calls.length <= 2 ? raw : browser;
      return { stdout: JSON.stringify(calls.length % 2 === 1 ? { streams: payload.streams } : { packets: payload.packets }), stderr: "" };
    }
  });
  assert.equal((await probe.probe({ host: "198.51.100.10", court: 6, expectedFrameRateMode: "60/1" })).profile, "1080p60");
  assert.equal(calls.length, 4);
  assert.equal(calls[0][0], "ssh");
  assert.match(calls[0][1].at(-1), /court6_raw/);
  assert.match(calls[1][1].at(-1), /show_packets/);
  assert.match(calls[2][1].at(-1), /court6_preview/);
  assert.doesNotMatch(calls[0][1].join(" "), /stream key|password/i);
});

function probePayload({
  codec = "h264",
  audioCodec = "aac",
  frameRate = "30/1",
  framesPerSecond = 30,
  width = 1920,
  height = 1080,
  fieldOrder = "progressive",
  pixelFormat = "yuv420p",
  hasBFrames = 0,
  keyframeIntervalSeconds = 2
} = {}) {
  return {
    streams: [
      {
        index: 0, codec_type: "video", codec_name: codec, profile: "Main", width, height,
        avg_frame_rate: frameRate, r_frame_rate: frameRate, field_order: fieldOrder,
        pix_fmt: pixelFormat, has_b_frames: hasBFrames
      },
      { index: 1, codec_type: "audio", codec_name: audioCodec, profile: "LC", sample_rate: "48000", channels: 2 }
    ],
    packets: packetTrace({ framesPerSecond, keyframeIntervalSeconds })
  };
}

function packetTrace({ framesPerSecond, keyframeIntervalSeconds }) {
  const durationSeconds = 5;
  return Array.from({ length: framesPerSecond * durationSeconds }, (_, index) => {
    const timestamp = index / framesPerSecond;
    const key = index % Math.round(framesPerSecond * keyframeIntervalSeconds) === 0;
    return { pts_time: timestamp.toFixed(6), dts_time: timestamp.toFixed(6), duration_time: (1 / framesPerSecond).toFixed(6), flags: key ? "K__" : "___" };
  });
}
