export const VISUAL_ANALYSIS_INTERVAL_MS = 1_000;
export const VISUAL_ANALYSIS_WIDTH = 160;
export const VISUAL_ANALYSIS_HEIGHT = 90;

const DARK_LUMA_THRESHOLD = 16;
const BLACK_DARK_PIXEL_RATIO = 0.97;
const BLACK_MEAN_LUMA = 16;
const BLACK_LUMA_VARIANCE = 40;
const FREEZE_MEAN_DIFFERENCE = 0.8;

export type ProgramVisualHealth = {
  sampledAt: string | null;
  meanLuma: number | null;
  lumaVariance: number | null;
  darkPixelRatio: number | null;
  frameDifference: number | null;
  frozenDurationMs: number;
  blackDurationMs: number;
};

export type VisualAnalysisState = {
  previousLuma: Uint8Array | null;
  frozenSinceMs: number | null;
  blackSinceMs: number | null;
};

export const EMPTY_PROGRAM_VISUAL_HEALTH: ProgramVisualHealth = {
  sampledAt: null,
  meanLuma: null,
  lumaVariance: null,
  darkPixelRatio: null,
  frameDifference: null,
  frozenDurationMs: 0,
  blackDurationMs: 0
};

export function initialVisualAnalysisState(): VisualAnalysisState {
  return { previousLuma: null, frozenSinceMs: null, blackSinceMs: null };
}

export function analyzeVisualFrame(
  state: VisualAnalysisState,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  nowMs: number
): { state: VisualAnalysisState; health: ProgramVisualHealth } {
  const pixelCount = Math.trunc(width) * Math.trunc(height);
  if (pixelCount <= 0 || rgba.length < pixelCount * 4 || !Number.isFinite(nowMs)) {
    return { state: initialVisualAnalysisState(), health: EMPTY_PROGRAM_VISUAL_HEALTH };
  }

  const luma = new Uint8Array(pixelCount);
  let sum = 0;
  let darkPixels = 0;
  for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
    const value = (54 * rgba[offset] + 183 * rgba[offset + 1] + 19 * rgba[offset + 2]) >> 8;
    luma[pixel] = value;
    sum += value;
    if (value <= DARK_LUMA_THRESHOLD) darkPixels += 1;
  }
  const meanLuma = sum / pixelCount;
  let varianceSum = 0;
  let differenceSum = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const centered = luma[pixel] - meanLuma;
    varianceSum += centered * centered;
    if (state.previousLuma?.length === pixelCount) differenceSum += Math.abs(luma[pixel] - state.previousLuma[pixel]);
  }
  const lumaVariance = varianceSum / pixelCount;
  const darkPixelRatio = darkPixels / pixelCount;
  const frameDifference = state.previousLuma?.length === pixelCount ? differenceSum / pixelCount : null;
  const frozen = frameDifference != null && frameDifference <= FREEZE_MEAN_DIFFERENCE;
  const black = darkPixelRatio >= BLACK_DARK_PIXEL_RATIO
    && meanLuma <= BLACK_MEAN_LUMA
    && lumaVariance <= BLACK_LUMA_VARIANCE;
  const frozenSinceMs = frozen ? state.frozenSinceMs ?? nowMs : null;
  const blackSinceMs = black ? state.blackSinceMs ?? nowMs : null;

  return {
    state: { previousLuma: luma, frozenSinceMs, blackSinceMs },
    health: {
      sampledAt: new Date(nowMs).toISOString(),
      meanLuma,
      lumaVariance,
      darkPixelRatio,
      frameDifference,
      frozenDurationMs: frozenSinceMs == null ? 0 : Math.max(0, nowMs - frozenSinceMs),
      blackDurationMs: blackSinceMs == null ? 0 : Math.max(0, nowMs - blackSinceMs)
    }
  };
}
