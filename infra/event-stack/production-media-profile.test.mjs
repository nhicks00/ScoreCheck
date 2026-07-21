import test from "node:test";
import assert from "node:assert/strict";

import { OUTPUT_PROFILES, parseFrameRate, ProductionSourceProbe, selectProductionOutputProfile } from "./production-media-profile.mjs";

test("admits native H.264 or H.265 1080p30 and 1080p60 sources into exact YouTube profiles", () => {
  const base = { codec_name: "h264", profile: "Main", width: 1920, height: 1080, field_order: "progressive", pix_fmt: "yuv420p" };
  assert.deepEqual(selectProductionOutputProfile({ streams: [{ ...base, avg_frame_rate: "30000/1001", r_frame_rate: "30/1" }] }), {
    profile: "1080p30",
    ...OUTPUT_PROFILES["1080p30"],
    source: { codec: "H264", profile: "Main", pixelFormat: "yuv420p", fieldOrder: "progressive", measuredFramesPerSecond: 30000 / 1001 }
  });
  assert.equal(selectProductionOutputProfile({ streams: [{ ...base, avg_frame_rate: "60000/1001", r_frame_rate: "60/1" }] }).profile, "1080p60");
  assert.equal(selectProductionOutputProfile({ streams: [{ ...base, codec_name: "hevc", avg_frame_rate: "30/1" }] }).source.codec, "H265");
});

test("fails closed on unknown codec, non-1080, interlaced, and unsupported cadence sources", () => {
  const base = { codec_name: "h264", width: 1920, height: 1080, field_order: "progressive", avg_frame_rate: "30/1" };
  assert.throws(() => selectProductionOutputProfile({ streams: [{ ...base, codec_name: "vp9" }] }), /H\.264 or H\.265/);
  assert.throws(() => selectProductionOutputProfile({ streams: [{ ...base, width: 1280, height: 720 }] }), /1920x1080/);
  assert.throws(() => selectProductionOutputProfile({ streams: [{ ...base, field_order: "tt" }] }), /progressive/);
  assert.throws(() => selectProductionOutputProfile({ streams: [{ ...base, avg_frame_rate: "25/1" }] }), /30 or 60/);
  assert.throws(() => selectProductionOutputProfile({ streams: [] }), /exactly one/);
});

test("parses bounded rational frame rates and rejects malformed or zero values", () => {
  assert.equal(parseFrameRate("30000/1001"), 30000 / 1001);
  assert.equal(parseFrameRate("60"), 60);
  for (const value of ["0/0", "30/0", "30fps", "-30/1", "", null]) assert.equal(parseFrameRate(value), null);
});

test("probes the local MediaMTX raw path over protected SSH and returns the admitted profile", async () => {
  const calls = [];
  const probe = new ProductionSourceProbe({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    runner: async (command, args) => {
      calls.push([command, args]);
      return { stdout: JSON.stringify({ streams: [{ codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "60/1", field_order: "progressive" }] }), stderr: "" };
    }
  });
  assert.equal((await probe.probe({ host: "198.51.100.10", court: 6 })).profile, "1080p60");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "ssh");
  assert.match(calls[0][1].at(-1), /court6_raw/);
  assert.doesNotMatch(calls[0][1].join(" "), /stream key|password/i);
});
