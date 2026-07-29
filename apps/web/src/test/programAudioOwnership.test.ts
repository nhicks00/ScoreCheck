import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const programClient = readFileSync(
  join(process.cwd(), "src/app/program/court/[courtNumber]/ProgramClient.tsx"),
  "utf8"
);
const streamPlayer = readFileSync(
  join(process.cwd(), "src/components/StreamPlayer.tsx"),
  "utf8"
);
const programAudioMixer = readFileSync(
  join(process.cwd(), "src/app/program/court/[courtNumber]/ProgramAudioMixer.tsx"),
  "utf8"
);

describe("program camera audio ownership", () => {
  it("routes HLS camera audio through ProgramAudioMixer without a direct duplicate", () => {
    expect(programClient).toContain('video.muted = transport !== "hls"');
    expect(programClient).toContain('video.volume = transport === "hls" ? 1 : 0');
    expect(programClient).toContain("Boolean(sources.hlsUrl)");
    expect(programClient).toContain('stream?.transport === "hls"');
    expect(streamPlayer).toContain("const [muted, setMuted] = useState(true)");
    expect(streamPlayer).toContain("if (playbackModeAllowsHls(mode))");
    expect(streamPlayer).toContain('video.crossOrigin = "anonymous"');
    expect(streamPlayer).toContain("xhr.withCredentials = true");
    expect(streamPlayer.indexOf("if (Hls.isSupported())")).toBeLessThan(
      streamPlayer.indexOf('if (video.canPlayType("application/vnd.apple.mpegurl"))')
    );
    expect(programAudioMixer).toContain("context.createMediaElementSource(cameraElement)");
    expect(programAudioMixer).toContain("CaptureStreamVideoElement");
    expect(programAudioMixer).toContain(".captureStream?.()");
  });
});
