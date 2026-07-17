import { streamTransportDelayMs, type StreamTimingSample } from "./rtcTiming";

export const COMMENTARY_SYNC_CLOCK_TOPIC = "scorecheck.sync.clock.v1";
export const COMMENTARY_SYNC_PREVIEW_TOPIC = "scorecheck.sync.preview.v1";
export const COMMENTARY_SYNC_INTERVAL_MS = 1000;
export const COMMENTARY_SYNC_PING_INTERVAL_MS = 3000;
export const COMMENTARY_SYNC_SAMPLE_MAX_AGE_MS = 5000;
export const COMMENTARY_SYNC_BASELINE_SAMPLES = 8;
export const COMMENTARY_SYNC_MISSING_OBSERVATION_GRACE_SAMPLES = 5;
export const COMMENTARY_SYNC_MAX_CORRECTION_MS = 500;
export const COMMENTARY_SYNC_SLEW_MS_PER_TICK = 25;

export type SyncClockPing = {
  version: 1;
  type: "clock-ping";
  id: string;
  t0Ms: number;
};

export type SyncClockPong = {
  version: 1;
  type: "clock-pong";
  id: string;
  t0Ms: number;
  t1Ms: number;
  t2Ms: number;
};

export type PreviewTimingMessage = {
  version: 1;
  type: "preview-timing";
  courtNumber: number;
  timing: StreamTimingSample;
};

export type CommentarySyncMessage = SyncClockPing | SyncClockPong | PreviewTimingMessage;

export type ClockEstimate = {
  offsetMs: number;
  rttMs: number;
  measuredAtMs: number;
};

export type SyncObservation = {
  programTransportMs: number;
  previewTransportMs: number;
  commentaryTransportMs: number;
};

export type CommentarySyncStatus = "fallback" | "calibrating" | "locked";

export type CommentarySyncController = {
  status: CommentarySyncStatus;
  configuredDelayMs: number;
  appliedDelayMs: number;
  targetDelayMs: number;
  baselineOffsetsMs: number[];
  baselineOffsetMs: number | null;
  recentOffsetsMs: number[];
  missingObservationSamples: number;
};

export function encodeCommentarySyncMessage(message: CommentarySyncMessage): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(message));
}

export function decodeCommentarySyncMessage(payload: Uint8Array<ArrayBufferLike>): CommentarySyncMessage | null {
  if (payload.byteLength === 0 || payload.byteLength > 4096) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as unknown;
    return parseMessage(value);
  } catch {
    return null;
  }
}

export function estimateClockOffset(pong: SyncClockPong, t3Ms: number): ClockEstimate | null {
  const values = [pong.t0Ms, pong.t1Ms, pong.t2Ms, t3Ms];
  if (values.some((value) => !Number.isFinite(value))) return null;
  if (pong.t1Ms < pong.t0Ms - 86_400_000 || pong.t2Ms < pong.t1Ms || t3Ms < pong.t0Ms) return null;
  const rttMs = (t3Ms - pong.t0Ms) - (pong.t2Ms - pong.t1Ms);
  if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > 2000) return null;
  const offsetMs = ((pong.t1Ms - pong.t0Ms) + (pong.t2Ms - t3Ms)) / 2;
  return { offsetMs, rttMs, measuredAtMs: t3Ms };
}

export function bestClockEstimate(estimates: ClockEstimate[], nowMs: number): ClockEstimate | null {
  return estimates
    .filter((estimate) => nowMs - estimate.measuredAtMs <= 30_000)
    .sort((a, b) => a.rttMs - b.rttMs)[0] ?? null;
}

export function previewSampleAgeOnProgramClock(
  timing: StreamTimingSample,
  clock: ClockEstimate,
  programNowMs: number
): number {
  const sampledOnProgramClock = timing.sampledAtMonotonicMs - clock.offsetMs;
  return Math.max(0, programNowMs - sampledOnProgramClock);
}

export function syncObservation(input: {
  programTiming: StreamTimingSample | null;
  previewTiming: StreamTimingSample | null;
  commentaryJitterMs: number | null;
  commentaryClockRttMs: number | null;
}): SyncObservation | null {
  const programTransportMs = streamTransportDelayMs(input.programTiming);
  const previewTransportMs = streamTransportDelayMs(input.previewTiming);
  const commentaryJitterMs = finiteNonNegative(input.commentaryJitterMs);
  const commentaryClockRttMs = finiteNonNegative(input.commentaryClockRttMs);
  if (programTransportMs == null || previewTransportMs == null || commentaryJitterMs == null || commentaryClockRttMs == null) {
    return null;
  }
  return {
    programTransportMs,
    previewTransportMs,
    commentaryTransportMs: commentaryJitterMs + commentaryClockRttMs / 2
  };
}

export function observationOffsetMs(observation: SyncObservation): number {
  return observation.programTransportMs
    - observation.previewTransportMs
    - observation.commentaryTransportMs;
}

export function initialCommentarySyncController(configuredDelayMs: number): CommentarySyncController {
  const safeDelay = clamp(Math.round(configuredDelayMs), 0, 10_000);
  return {
    status: "fallback",
    configuredDelayMs: safeDelay,
    appliedDelayMs: safeDelay,
    targetDelayMs: safeDelay,
    baselineOffsetsMs: [],
    baselineOffsetMs: null,
    recentOffsetsMs: [],
    missingObservationSamples: 0
  };
}

export function commentarySyncStep(
  state: CommentarySyncController,
  observation: SyncObservation | null
): CommentarySyncController {
  if (!observation) {
    const missingObservationSamples = state.missingObservationSamples + 1;
    return {
      ...state,
      status: state.baselineOffsetMs != null
        && missingObservationSamples <= COMMENTARY_SYNC_MISSING_OBSERVATION_GRACE_SAMPLES
        ? "locked"
        : "fallback",
      missingObservationSamples
    };
  }
  const offset = observationOffsetMs(observation);

  if (state.baselineOffsetMs == null) {
    const samples = [...state.baselineOffsetsMs, offset].slice(-COMMENTARY_SYNC_BASELINE_SAMPLES);
    if (samples.length < COMMENTARY_SYNC_BASELINE_SAMPLES) {
      return { ...state, status: "calibrating", baselineOffsetsMs: samples, missingObservationSamples: 0 };
    }
    return {
      ...state,
      status: "locked",
      baselineOffsetsMs: samples,
      baselineOffsetMs: median(samples),
      recentOffsetsMs: [offset],
      missingObservationSamples: 0
    };
  }

  const recentOffsetsMs = [...state.recentOffsetsMs, offset].slice(-5);
  const correctionMs = clamp(
    median(recentOffsetsMs) - state.baselineOffsetMs,
    -COMMENTARY_SYNC_MAX_CORRECTION_MS,
    COMMENTARY_SYNC_MAX_CORRECTION_MS
  );
  const targetDelayMs = clamp(
    Math.round(state.configuredDelayMs + correctionMs),
    Math.max(0, state.configuredDelayMs - COMMENTARY_SYNC_MAX_CORRECTION_MS),
    Math.min(10_000, state.configuredDelayMs + COMMENTARY_SYNC_MAX_CORRECTION_MS)
  );
  const appliedDelayMs = slew(
    state.appliedDelayMs,
    targetDelayMs,
    COMMENTARY_SYNC_SLEW_MS_PER_TICK
  );
  return {
    ...state,
    status: "locked",
    targetDelayMs,
    appliedDelayMs,
    recentOffsetsMs,
    missingObservationSamples: 0
  };
}

function parseMessage(value: unknown): CommentarySyncMessage | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") return null;
  if (value.type === "clock-ping") {
    if (!validId(value.id) || !finite(value.t0Ms)) return null;
    return { version: 1, type: "clock-ping", id: value.id, t0Ms: value.t0Ms };
  }
  if (value.type === "clock-pong") {
    if (!validId(value.id) || !finite(value.t0Ms) || !finite(value.t1Ms) || !finite(value.t2Ms)) return null;
    return {
      version: 1,
      type: "clock-pong",
      id: value.id,
      t0Ms: value.t0Ms,
      t1Ms: value.t1Ms,
      t2Ms: value.t2Ms
    };
  }
  if (value.type === "preview-timing") {
    if (typeof value.courtNumber !== "number"
      || !Number.isInteger(value.courtNumber)
      || value.courtNumber < 1
      || value.courtNumber > 8) return null;
    const timing = parseTiming(value.timing);
    if (!timing) return null;
    return { version: 1, type: "preview-timing", courtNumber: value.courtNumber, timing };
  }
  return null;
}

function parseTiming(value: unknown): StreamTimingSample | null {
  if (!isRecord(value) || value.version !== 1 || !finite(value.sampledAtMonotonicMs)) return null;
  const jitterBufferMs = nullableNonNegative(value.jitterBufferMs);
  const jitterBufferTargetMs = nullableNonNegative(value.jitterBufferTargetMs);
  const rttMs = nullableNonNegative(value.rttMs);
  if (jitterBufferMs === undefined || jitterBufferTargetMs === undefined || rttMs === undefined) return null;
  return { version: 1, sampledAtMonotonicMs: value.sampledAtMonotonicMs, jitterBufferMs, jitterBufferTargetMs, rttMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNonNegative(value: unknown): number | null | undefined {
  if (value === null) return null;
  return finite(value) && value >= 0 && value <= 10_000 ? value : undefined;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function finiteNonNegative(value: number | null): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function slew(current: number, target: number, maxStep: number): number {
  if (target > current) return Math.min(target, current + maxStep);
  if (target < current) return Math.max(target, current - maxStep);
  return current;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
