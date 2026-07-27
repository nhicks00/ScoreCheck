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

describe("program camera audio ownership", () => {
  it("keeps the camera element muted so only ProgramAudioMixer reaches the captured output", () => {
    expect(programClient).toContain("video.muted = true");
    expect(programClient).toContain("video.volume = 0");
    expect(programClient).not.toContain("video.muted = false");
    expect(streamPlayer).toContain("const [muted, setMuted] = useState(true)");
    expect(streamPlayer).not.toContain('useState(mode !== "program")');
  });
});
