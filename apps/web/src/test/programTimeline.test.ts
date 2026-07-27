import { describe, expect, it } from "vitest";
import {
  PROGRAM_HLS_TARGET_LATENCY_MS,
  programOverlayApplyAtMs,
  programTimelineDelayMs
} from "../lib/programTimeline";

describe("program timeline", () => {
  it("uses the conservative HLS target until measured playout delay is available", () => {
    expect(programTimelineDelayMs(3_500, null)).toBe(3_500 + PROGRAM_HLS_TARGET_LATENCY_MS);
    expect(programTimelineDelayMs(3_500, 14_250)).toBe(17_750);
  });

  it("applies a fresh score after the program delay and restores old state immediately", () => {
    const nowMs = Date.parse("2026-07-27T12:00:00.000Z");
    expect(programOverlayApplyAtMs("2026-07-27T11:59:59.000Z", 15_500, nowMs)).toBe(nowMs + 14_500);
    expect(programOverlayApplyAtMs("2026-07-27T11:00:00.000Z", 15_500, nowMs)).toBeLessThan(nowMs);
  });
});
