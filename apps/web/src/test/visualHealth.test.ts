import { describe, expect, it } from "vitest";
import { analyzeVisualFrame, initialVisualAnalysisState } from "../lib/visualHealth";

function solid(width: number, height: number, value: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return rgba;
}

describe("program visual health", () => {
  it("detects a repeated full-bitrate frame without confusing the first sample", () => {
    const first = analyzeVisualFrame(initialVisualAnalysisState(), solid(4, 4, 120), 4, 4, 1_000);
    expect(first.health.frameDifference).toBeNull();
    expect(first.health.frozenDurationMs).toBe(0);
    const repeated = analyzeVisualFrame(first.state, solid(4, 4, 120), 4, 4, 7_000);
    expect(repeated.health.frameDifference).toBe(0);
    expect(repeated.health.frozenDurationMs).toBe(0);
    const stillRepeated = analyzeVisualFrame(repeated.state, solid(4, 4, 120), 4, 4, 13_000);
    expect(stillRepeated.health.frozenDurationMs).toBe(6_000);
  });

  it("resets freeze duration when visible content changes", () => {
    const first = analyzeVisualFrame(initialVisualAnalysisState(), solid(4, 4, 100), 4, 4, 1_000);
    const repeated = analyzeVisualFrame(first.state, solid(4, 4, 100), 4, 4, 2_000);
    const changed = analyzeVisualFrame(repeated.state, solid(4, 4, 180), 4, 4, 3_000);
    expect(changed.health.frameDifference).toBeGreaterThan(50);
    expect(changed.health.frozenDurationMs).toBe(0);
  });

  it("requires persistent uniformly dark frames for black duration", () => {
    const first = analyzeVisualFrame(initialVisualAnalysisState(), solid(4, 4, 0), 4, 4, 1_000);
    const second = analyzeVisualFrame(first.state, solid(4, 4, 0), 4, 4, 22_000);
    expect(first.health.darkPixelRatio).toBe(1);
    expect(first.health.blackDurationMs).toBe(0);
    expect(second.health.blackDurationMs).toBe(21_000);
  });
});
