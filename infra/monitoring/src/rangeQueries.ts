import { z } from "zod";

const rangeInputSchema = z.object({
  windowSec: z.coerce.number().int().min(300).max(3_600).default(300),
  stepSec: z.coerce.number().int().min(5).max(60).default(15)
}).refine((value) => value.windowSec / value.stepSec <= 240, "Range query is too dense.");

const PROMETHEUS_QUERIES = {
  rawBitrate: 'scorecheck_media_path_inbound_bitrate_bps{branch="raw"}',
  previewFps: 'scorecheck_ffmpeg_frames_per_second{branch="preview"}',
  programFps: "scorecheck_program_browser_frames_per_second",
  programDropRatio: "scorecheck_program_browser_frame_drop_ratio_2m",
  programFreezeRatio: "scorecheck_program_browser_freeze_time_ratio_2m"
} as const;

export type CourtPipelineRange = {
  generatedAt: string;
  windowSec: number;
  stepSec: number;
  courts: Array<{
    courtNumber: number;
    rawBitrate: Array<[number, number]>;
    previewFps: Array<[number, number]>;
    programFps: Array<[number, number]>;
    programDropRatio: Array<[number, number]>;
    programFreezeRatio: Array<[number, number]>;
  }>;
};

export function parseRangeInput(input: Record<string, unknown>): { windowSec: number; stepSec: number } {
  return rangeInputSchema.parse(input);
}

export async function loadCourtPipelineRange(
  prometheusBaseUrl: string,
  input: { windowSec: number; stepSec: number },
  nowMs = Date.now(),
  fetcher: typeof fetch = fetch
): Promise<CourtPipelineRange> {
  const endSec = Math.floor(nowMs / 1_000);
  const startSec = endSec - input.windowSec;
  const entries = await Promise.all(Object.entries(PROMETHEUS_QUERIES).map(async ([name, query]) => {
    const url = new URL("/api/v1/query_range", `${prometheusBaseUrl.replace(/\/+$/, "")}/`);
    url.searchParams.set("query", query);
    url.searchParams.set("start", String(startSec));
    url.searchParams.set("end", String(endSec));
    url.searchParams.set("step", String(input.stepSec));
    const response = await fetcher(url, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error(`Prometheus range query failed with ${response.status}.`);
    return [name, parseMatrix(await response.json())] as const;
  }));
  const matrices = Object.fromEntries(entries) as Record<keyof typeof PROMETHEUS_QUERIES, Map<number, Array<[number, number]>>>;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowSec: input.windowSec,
    stepSec: input.stepSec,
    courts: Array.from({ length: 8 }, (_, index) => ({
      courtNumber: index + 1,
      rawBitrate: matrices.rawBitrate.get(index + 1) ?? [],
      previewFps: matrices.previewFps.get(index + 1) ?? [],
      programFps: matrices.programFps.get(index + 1) ?? [],
      programDropRatio: matrices.programDropRatio.get(index + 1) ?? [],
      programFreezeRatio: matrices.programFreezeRatio.get(index + 1) ?? []
    }))
  };
}

function parseMatrix(input: unknown): Map<number, Array<[number, number]>> {
  const payload = input as { status?: unknown; data?: { resultType?: unknown; result?: unknown } };
  if (payload?.status !== "success" || payload.data?.resultType !== "matrix" || !Array.isArray(payload.data.result)) throw new Error("Prometheus returned an invalid matrix response.");
  const result = new Map<number, Array<[number, number]>>();
  for (const row of payload.data.result.slice(0, 32)) {
    if (!row || typeof row !== "object") continue;
    const metric = "metric" in row && row.metric && typeof row.metric === "object" ? row.metric as Record<string, unknown> : {};
    const courtNumber = Number(metric.court);
    if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > 8 || !("values" in row) || !Array.isArray(row.values)) continue;
    const rawValues = row.values as unknown[];
    const points = rawValues.slice(-240).flatMap((point: unknown): Array<[number, number]> => {
      if (!Array.isArray(point) || point.length < 2) return [];
      const timestamp = Number(point[0]);
      const value = Number(point[1]);
      return Number.isFinite(timestamp) && Number.isFinite(value) && value >= 0 ? [[timestamp, value]] : [];
    });
    if (!result.has(courtNumber) || points.length > (result.get(courtNumber)?.length ?? 0)) result.set(courtNumber, points);
  }
  return result;
}
