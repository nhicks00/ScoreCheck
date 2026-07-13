import { describe, expect, it, vi } from "vitest";
import { deriveBitrate, MediaPathDetailCache, parseMediaPath, parseSrtTransports } from "./media.js";
import { metricValuesByPath } from "./collectors.js";

describe("media monitoring", () => {
  it("derives bitrate from consecutive byte samples", () => {
    expect(deriveBitrate({ bytes: 1_000, sampledAtMs: 1_000 }, { bytes: 2_000, sampledAtMs: 2_000 })).toBe(8_000);
    expect(deriveBitrate(null, { bytes: 2_000, sampledAtMs: 2_000 })).toBeNull();
    expect(deriveBitrate({ bytes: 2_000, sampledAtMs: 1_000 }, { bytes: 1_000, sampledAtMs: 2_000 })).toBeNull();
  });

  it("accepts only court media paths and omits reader identities", () => {
    const parsed = parseMediaPath({
      name: "court3_raw",
      ready: true,
      readyTime: "2026-07-12T12:00:00Z",
      bytesReceived: 5_000,
      bytesSent: 2_000,
      readers: [{ id: "secret-connection-id", remoteAddr: "private" }],
      source: { type: "rtmpConn", id: "secret-source-id" },
      tracks: [{ codec: "H264" }, { codec: "MPEG4Audio" }]
    }, null, 1_000);
    expect(parsed?.path).toMatchObject({ name: "court3_raw", courtNumber: 3, branch: "raw", readerCount: 1, sourceProtocol: "RTMP", sourceMode: "PUSH", videoCodec: "H264", audioCodec: "AAC" });
    expect(JSON.stringify(parsed?.path)).not.toContain("secret-connection-id");
    expect(JSON.stringify(parsed?.path)).not.toContain("secret-source-id");
    expect(parseMediaPath({ name: "arbitrary_private_path" }, null, 1_000)).toBeNull();
  });

  it("parses MediaMTX tracks2 properties and string-track fallback", () => {
    const detailed = parseMediaPath({
      name: "court5_raw",
      ready: true,
      source: { type: "srtConn" },
      tracks2: [
        { codec: "H265", codecProps: { width: 1920, height: 1080, profile: "Main" } },
        { codec: "MPEG-4 Audio", codecProps: { sampleRate: 48_000, channelCount: 2 } }
      ]
    }, null, 1_000);
    expect(detailed?.path).toMatchObject({
      sourceProtocol: "SRT",
      sourceMode: "PUSH",
      videoCodec: "H265",
      videoWidth: 1920,
      videoHeight: 1080,
      videoProfile: "Main",
      audioCodec: "AAC",
      audioSampleRateHz: 48_000,
      audioChannelCount: 2
    });

    const fallback = parseMediaPath({
      name: "court6_raw",
      ready: true,
      source: { type: "srtSource" },
      tracks: ["H264", "MPEG-4 Audio"]
    }, null, 1_000);
    expect(fallback?.path).toMatchObject({ sourceProtocol: "SRT", sourceMode: "PULL", videoCodec: "H264", audioCodec: "AAC" });
  });

  it("caches sanitized path details for one ready epoch", async () => {
    const cache = new MediaPathDetailCache();
    const fetchDetail = vi.fn(async () => ({
      source: { type: "srtConn", id: "secret-source-id" },
      tracks: ["H265", "MPEG-4 Audio"],
      query: "must-not-be-retained"
    }));
    const row = { name: "court3_raw", ready: true, readyTime: "2026-07-12T12:00:00Z", bytesReceived: 100 };
    const first = await cache.enrich([row], fetchDetail);
    const second = await cache.enrich([{ ...row, bytesReceived: 200 }], fetchDetail);
    const third = await cache.enrich([{ ...row, readyTime: "2026-07-12T12:01:00Z", bytesReceived: 10 }], fetchDetail);

    expect(fetchDetail).toHaveBeenCalledTimes(2);
    expect(first.failedPaths).toBe(0);
    expect(second.failedPaths).toBe(0);
    expect(JSON.stringify(second.rows)).not.toContain("secret-source-id");
    expect(JSON.stringify(second.rows)).not.toContain("must-not-be-retained");
    expect(third.failedPaths).toBe(0);
  });

  it("backs off failed detail requests without hiding the collection gap", async () => {
    const cache = new MediaPathDetailCache();
    const fetchDetail = vi.fn(async () => { throw new Error("unavailable"); });
    const row = { name: "court2_raw", ready: true, readyTime: "2026-07-12T12:00:00Z", bytesReceived: 100 };

    expect((await cache.enrich([row], fetchDetail, 1_000)).failedPaths).toBe(1);
    expect((await cache.enrich([{ ...row, bytesReceived: 200 }], fetchDetail, 6_000)).failedPaths).toBe(1);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    expect((await cache.enrich([{ ...row, bytesReceived: 300 }], fetchDetail, 31_001)).failedPaths).toBe(1);
    expect(fetchDetail).toHaveBeenCalledTimes(2);
  });

  it("normalizes bounded SRT connection quality without retaining identities", () => {
    const transports = parseSrtTransports({ items: [{
      id: "secret-id",
      remoteAddr: "private-address",
      query: "pass=secret",
      path: "court4_raw",
      state: "publish",
      msRTT: 137.5,
      packetsReceived: 20_000,
      packetsReceivedLoss: 40,
      packetsReceivedRetrans: 120,
      packetsReceivedDrop: 3,
      mbpsReceiveRate: 3.25,
      msReceiveBuf: 2_610,
      msReceiveTsbPdDelay: 2_500
    }] });
    expect(transports.get("court4_raw")).toEqual({
      rttMs: 137.5,
      packetsReceived: 20_000,
      packetsLost: 40,
      packetsRetransmitted: 120,
      packetsDropped: 3,
      receiveRateBps: 3_250_000,
      receiveBufferMs: 2_610,
      configuredLatencyMs: 2_500
    });
    expect(JSON.stringify([...transports])).not.toContain("secret");
    expect(parseSrtTransports({ items: [{ path: "private", state: "publish", msRTT: 1 }] }).size).toBe(0);
  });

  it("extracts only allowlisted path frame errors", () => {
    const values = metricValuesByPath([
      'paths_inbound_frames_in_error{name="court1_raw",state="ready"} 2',
      'paths_inbound_frames_in_error{name="secret-path",state="ready"} 99'
    ].join("\n"), "paths_inbound_frames_in_error");
    expect(values.get("court1_raw")).toBe(2);
    expect(values.has("secret-path")).toBe(false);
  });
});
