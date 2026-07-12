import { describe, expect, it } from "vitest";
import { deriveBitrate, parseMediaPath } from "./media.js";
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
      tracks: [{ codec: "H264" }, { codec: "MPEG4Audio" }]
    }, null, 1_000);
    expect(parsed?.path).toMatchObject({ name: "court3_raw", courtNumber: 3, branch: "raw", readerCount: 1, videoCodec: "H264", audioCodec: "MPEG4Audio" });
    expect(JSON.stringify(parsed?.path)).not.toContain("secret-connection-id");
    expect(parseMediaPath({ name: "arbitrary_private_path" }, null, 1_000)).toBeNull();
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
