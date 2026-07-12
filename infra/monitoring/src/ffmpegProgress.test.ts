import { describe, expect, it } from "vitest";
import { parseKeyValues } from "./ffmpegProgress.js";

describe("FFmpeg progress parser", () => {
  it("accepts only bounded numeric progress fields", () => {
    const values = parseKeyValues([
      "frame=1800",
      "fps=29.97",
      "bitrate_kbps=2510.4",
      "stream_url=rtmps://secret.example/key",
      "bad-key=1",
      "speed=1.00"
    ].join("\n"));
    expect(Object.fromEntries(values)).toEqual({
      frame: "1800",
      fps: "29.97",
      bitrate_kbps: "2510.4",
      speed: "1.00"
    });
  });
});
