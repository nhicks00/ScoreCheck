export const STREAM_TIMING_INTERVAL_MS = 1000;

export type StreamTimingSample = {
  version: 1;
  sampledAtMonotonicMs: number;
  jitterBufferMs: number | null;
  jitterBufferTargetMs: number | null;
  rttMs: number | null;
};

export type RtcJitterTotals = {
  emittedCount: number;
  jitterBufferDelaySeconds: number;
  jitterBufferTargetDelaySeconds: number | null;
};

export function intervalJitterSample(
  previous: RtcJitterTotals | null,
  current: RtcJitterTotals
): Pick<StreamTimingSample, "jitterBufferMs" | "jitterBufferTargetMs"> {
  if (!previous) return { jitterBufferMs: null, jitterBufferTargetMs: null };
  const emitted = current.emittedCount - previous.emittedCount;
  if (!Number.isFinite(emitted) || emitted <= 0) {
    return { jitterBufferMs: null, jitterBufferTargetMs: null };
  }

  const jitterBufferMs = secondsPerItem(
    current.jitterBufferDelaySeconds - previous.jitterBufferDelaySeconds,
    emitted
  );
  const jitterBufferTargetMs = current.jitterBufferTargetDelaySeconds == null
    || previous.jitterBufferTargetDelaySeconds == null
    ? null
    : secondsPerItem(
      current.jitterBufferTargetDelaySeconds - previous.jitterBufferTargetDelaySeconds,
      emitted
    );

  return { jitterBufferMs, jitterBufferTargetMs };
}

export function streamTransportDelayMs(sample: StreamTimingSample | null | undefined): number | null {
  if (!sample) return null;
  const playout = finiteNonNegative(sample.jitterBufferTargetMs)
    ?? finiteNonNegative(sample.jitterBufferMs);
  const network = finiteNonNegative(sample.rttMs);
  if (playout == null && network == null) return null;
  return (playout ?? 0) + (network ?? 0) / 2;
}

export function monotonicEpochMs(): number {
  if (typeof performance !== "undefined"
    && Number.isFinite(performance.timeOrigin)
    && Number.isFinite(performance.now())) {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

export function timingSampleAgeMs(sample: StreamTimingSample, nowMs = monotonicEpochMs()): number {
  return Math.max(0, nowMs - sample.sampledAtMonotonicMs);
}

function secondsPerItem(seconds: number, count: number): number | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return clamp(seconds * 1000 / count, 0, 5000);
}

function finiteNonNegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
