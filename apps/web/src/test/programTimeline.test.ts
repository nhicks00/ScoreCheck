import { describe, expect, it } from "vitest";
import {
  PROGRAM_HLS_BACK_BUFFER_SECONDS,
  PROGRAM_HLS_BUFFER_LENGTH_SECONDS,
  PROGRAM_HLS_INITIAL_SEGMENT_COUNT,
  PROGRAM_HLS_MAX_BUFFER_BYTES,
  PROGRAM_HLS_STARTUP_BUFFER_SECONDS,
  PROGRAM_HLS_TARGET_LATENCY_MS,
  programOverlayApplyAtMs,
  programTimelineDelayMs
} from "../lib/programTimeline";

describe("program timeline", () => {
  it("uses the conservative HLS target until measured playout delay is available", () => {
    expect(PROGRAM_HLS_INITIAL_SEGMENT_COUNT).toBe(6);
    expect(PROGRAM_HLS_STARTUP_BUFFER_SECONDS).toBe(10);
    expect(PROGRAM_HLS_BUFFER_LENGTH_SECONDS).toBe(18);
    expect(PROGRAM_HLS_BACK_BUFFER_SECONDS).toBe(4);
    expect(PROGRAM_HLS_MAX_BUFFER_BYTES).toBe(32_000_000);
    expect(programTimelineDelayMs(0, null)).toBe(PROGRAM_HLS_TARGET_LATENCY_MS);
    expect(programTimelineDelayMs(0, 14_250)).toBe(14_250);
    expect(programTimelineDelayMs(500, 14_250)).toBe(14_750);
  });

  it("applies a fresh score after the program delay and restores old state immediately", () => {
    const nowMs = Date.parse("2026-07-27T12:00:00.000Z");
    expect(programOverlayApplyAtMs("2026-07-27T11:59:59.000Z", 15_500, nowMs)).toBe(nowMs + 14_500);
    expect(programOverlayApplyAtMs("2026-07-27T11:00:00.000Z", 15_500, nowMs)).toBeLessThan(nowMs);
  });
});
