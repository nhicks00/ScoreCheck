export const PROGRAM_HLS_TARGET_LATENCY_MS = 12_000;
export const PROGRAM_HLS_MAX_LATENCY_MS = 24_000;
export const PROGRAM_HLS_BUFFER_LENGTH_SECONDS = 30;
export const PROGRAM_HLS_INITIAL_SEGMENT_COUNT = 6;
export const PROGRAM_MAX_TIMELINE_DELAY_MS = 30_000;

export function programTimelineDelayMs(programVideoDelayMs: number, hlsLatencyMs: number | null | undefined): number {
  const sourceDelayMs = clamp(programVideoDelayMs, 0, PROGRAM_MAX_TIMELINE_DELAY_MS);
  const playbackDelayMs = clamp(
    hlsLatencyMs ?? PROGRAM_HLS_TARGET_LATENCY_MS,
    0,
    PROGRAM_HLS_MAX_LATENCY_MS
  );
  return clamp(sourceDelayMs + playbackDelayMs, 0, PROGRAM_MAX_TIMELINE_DELAY_MS);
}

export function programOverlayApplyAtMs(materializedAt: string | null, timelineDelayMs: number, nowMs: number): number {
  const materializedAtMs = Date.parse(materializedAt ?? "");
  const baseMs = Number.isFinite(materializedAtMs) ? Math.min(materializedAtMs, nowMs) : nowMs;
  return baseMs + clamp(timelineDelayMs, 0, PROGRAM_MAX_TIMELINE_DELAY_MS);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
