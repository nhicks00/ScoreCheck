import { describe, expect, it } from "vitest";
import { comparePacingPhases, summarizePacingSamples, type PacingDiagnosticSample, type PacingDiagnosticSummary } from "../lib/pacingDiagnostic";

describe("summarizePacingSamples", () => {
  it("accumulates counter deltas without turning a reset into a spike", () => {
    const samples = [
      sample(0, { framesReceived: 100, framesDecoded: 98, framesDropped: 2, freezeCount: 1, totalFreezesDurationMs: 500 }),
      sample(10_000, { framesReceived: 400, framesDecoded: 392, framesDropped: 8, freezeCount: 2, totalFreezesDurationMs: 900 }),
      sample(20_000, { framesReceived: 10, framesDecoded: 10, framesDropped: 0, freezeCount: 0, totalFreezesDurationMs: 0 }),
      sample(40_000, { framesReceived: 1_010, framesDecoded: 990, framesDropped: 20, freezeCount: 2, totalFreezesDurationMs: 1_000 })
    ];

    const summary = summarizePacingSamples(samples);

    expect(summary.framesReceived).toBe(1_300);
    expect(summary.framesDecoded).toBe(1_274);
    expect(summary.framesDropped).toBe(26);
    expect(summary.freezeCount).toBe(3);
    expect(summary.freezeDurationMs).toBe(1_400);
    expect(summary.frameDropRatio).toBeCloseTo(0.02);
    expect(summary.freezeTimeRatio).toBeCloseTo(0.035);
    expect(summary.sufficient).toBe(false);
  });

  it("excludes disconnected samples and summarizes transport percentiles", () => {
    const samples = [
      sample(0, { connectionState: "connecting", framesReceived: 5, jitterBufferMs: 900 }),
      sample(1_000, { framesReceived: 100, framesDecoded: 100, jitterBufferMs: 10, framesPerSecond: 29 }),
      sample(2_000, { framesReceived: 130, framesDecoded: 130, jitterBufferMs: 30, framesPerSecond: 31 }),
      sample(3_000, { framesReceived: 160, framesDecoded: 160, jitterBufferMs: 20, framesPerSecond: 30 })
    ];

    const summary = summarizePacingSamples(samples);

    expect(summary.connectedSampleRatio).toBe(0.75);
    expect(summary.framesReceived).toBe(60);
    expect(summary.medianFps).toBe(30);
    expect(summary.p95JitterBufferMs).toBe(30);
  });
});

describe("comparePacingPhases", () => {
  it("isolates a delayed-program pacing defect when both preview controls are healthy", () => {
    expect(comparePacingPhases(summary(), summary({ frameDropRatio: 0.02 }), summary())).toEqual({
      classification: "PROGRAM_PATH",
      summary: "Only the delayed program phase crossed a pacing warning band; investigate the delay/remux path before the shared source or client."
    });
  });

  it("classifies degradation in every phase as shared evidence", () => {
    const degraded = summary({ freezeTimeRatio: 0.03 });
    expect(comparePacingPhases(degraded, degraded, degraded).classification).toBe("SHARED");
  });

  it("refuses attribution when a phase is undersampled or preview controls disagree", () => {
    expect(comparePacingPhases(summary(), summary({ sufficient: false }), summary()).classification).toBe("INCONCLUSIVE");
    expect(comparePacingPhases(summary({ frameDropRatio: 0.02 }), summary(), summary()).classification).toBe("INCONCLUSIVE");
  });
});

function sample(sampledAtMs: number, overrides: Partial<PacingDiagnosticSample> = {}): PacingDiagnosticSample {
  return {
    sampledAtMs,
    connectionState: "connected",
    framesPerSecond: 30,
    rttMs: 2,
    jitterMs: 1,
    jitterBufferMs: 10,
    packetsLost: 0,
    packetsReceived: sampledAtMs / 10,
    framesReceived: sampledAtMs / 33,
    framesDecoded: sampledAtMs / 33,
    framesDropped: 0,
    freezeCount: 0,
    totalFreezesDurationMs: 0,
    nackCount: 0,
    pliCount: 0,
    firCount: 0,
    ...overrides
  };
}

function summary(overrides: Partial<PacingDiagnosticSummary> = {}): PacingDiagnosticSummary {
  return {
    sampleCount: 120,
    measuredDurationMs: 120_000,
    connectedSampleRatio: 1,
    framesReceived: 3_600,
    framesDecoded: 3_600,
    framesDropped: 0,
    frameDropRatio: 0,
    freezeCount: 0,
    freezeDurationMs: 0,
    freezeTimeRatio: 0,
    packetsReceived: 30_000,
    packetsLost: 0,
    packetLossRatio: 0,
    nackCount: 0,
    pliCount: 0,
    firCount: 0,
    medianFps: 30,
    p95JitterBufferMs: 10,
    p95JitterMs: 1,
    p95RttMs: 2,
    sufficient: true,
    ...overrides
  };
}
