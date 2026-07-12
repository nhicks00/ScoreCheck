import { describe, expect, it } from "vitest";
import {
  commentarySyncStep,
  decodeCommentarySyncMessage,
  encodeCommentarySyncMessage,
  estimateClockOffset,
  initialCommentarySyncController,
  observationOffsetMs,
  previewSampleAgeOnProgramClock,
  syncObservation,
  type PreviewTimingMessage
} from "../lib/commentarySync";
import { intervalJitterSample, streamTransportDelayMs, type StreamTimingSample } from "../lib/rtcTiming";

const timing = (overrides: Partial<StreamTimingSample> = {}): StreamTimingSample => ({
  version: 1,
  sampledAtMonotonicMs: 10_000,
  jitterBufferMs: 50,
  jitterBufferTargetMs: 60,
  rttMs: 40,
  ...overrides
});

describe("commentary sync clock", () => {
  it("estimates remote clock offset and network RTT with NTP timestamps", () => {
    const estimate = estimateClockOffset({
      version: 1,
      type: "clock-pong",
      id: "ping-1",
      t0Ms: 1000,
      t1Ms: 1250,
      t2Ms: 1260
    }, 1110);
    expect(estimate).toMatchObject({ offsetMs: 200, rttMs: 100, measuredAtMs: 1110 });
  });

  it("maps commentator monotonic timestamps onto the program clock", () => {
    const age = previewSampleAgeOnProgramClock(timing({ sampledAtMonotonicMs: 5200 }), {
      offsetMs: 200,
      rttMs: 80,
      measuredAtMs: 5000
    }, 5500);
    expect(age).toBe(500);
  });

  it("round-trips validated preview timing messages and rejects malformed data", () => {
    const message: PreviewTimingMessage = {
      version: 1,
      type: "preview-timing",
      courtNumber: 1,
      timing: timing()
    };
    expect(decodeCommentarySyncMessage(encodeCommentarySyncMessage(message))).toEqual(message);
    expect(decodeCommentarySyncMessage(new TextEncoder().encode('{"version":1,"type":"clock-ping"}'))).toBeNull();
  });
});

describe("RTC timing", () => {
  it("uses interval deltas instead of lifetime jitter averages", () => {
    const sample = intervalJitterSample({
      emittedCount: 100,
      jitterBufferDelaySeconds: 5,
      jitterBufferTargetDelaySeconds: 7
    }, {
      emittedCount: 120,
      jitterBufferDelaySeconds: 6,
      jitterBufferTargetDelaySeconds: 8.4
    });
    expect(sample.jitterBufferMs).toBeCloseTo(50);
    expect(sample.jitterBufferTargetMs).toBeCloseTo(70);
  });

  it("combines playout buffering with half the measured RTT", () => {
    expect(streamTransportDelayMs(timing())).toBe(80);
  });
});

describe("commentary sync controller", () => {
  it("locks a baseline then applies bounded, slew-limited transport correction", () => {
    let state = initialCommentarySyncController(3000);
    const baseline = { programTransportMs: 100, previewTransportMs: 60, commentaryTransportMs: 90 };
    expect(observationOffsetMs(baseline)).toBe(-50);
    for (let index = 0; index < 8; index += 1) state = commentarySyncStep(state, baseline);
    expect(state.status).toBe("locked");
    expect(state.baselineOffsetMs).toBe(-50);

    const shifted = { programTransportMs: 180, previewTransportMs: 60, commentaryTransportMs: 90 };
    for (let index = 0; index < 5; index += 1) state = commentarySyncStep(state, shifted);
    expect(state.targetDelayMs).toBe(3080);
    expect(state.appliedDelayMs).toBeGreaterThan(3000);
    expect(state.appliedDelayMs).toBeLessThanOrEqual(3080);
  });

  it("builds observations only when all three transport legs are measured", () => {
    expect(syncObservation({
      programTiming: timing({ jitterBufferTargetMs: 80 }),
      previewTiming: timing({ jitterBufferTargetMs: 60 }),
      commentaryJitterMs: 40,
      commentaryClockRttMs: 100
    })).toEqual({
      programTransportMs: 100,
      previewTransportMs: 80,
      commentaryTransportMs: 90
    });
    expect(syncObservation({
      programTiming: null,
      previewTiming: timing(),
      commentaryJitterMs: 40,
      commentaryClockRttMs: 100
    })).toBeNull();
  });
});
