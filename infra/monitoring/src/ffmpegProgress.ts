import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FfmpegBranchSnapshot } from "./contracts.js";

const FILE_PATTERN = /^(court([1-8])_(preview|program|calibration|monitor))\.progress$/;
const MAX_FILE_BYTES = 4_096;
const MAX_SAMPLE_AGE_MS = 20_000;
const MIN_DERIVATION_WINDOW_MS = 15_000;
const MAX_DERIVATION_WINDOW_MS = 30_000;

export async function collectFfmpegProgress(directory: string | null, nowMs = Date.now()): Promise<FfmpegBranchSnapshot[]> {
  if (!directory) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshots = await Promise.all(entries.filter((entry) => entry.isFile() && FILE_PATTERN.test(entry.name)).map(async (entry) => {
    const match = FILE_PATTERN.exec(entry.name);
    if (!match?.[1] || !match[2] || !match[3]) return null;
    const filePath = path.join(directory, entry.name);
    const metadata = await stat(filePath);
    if (metadata.size > MAX_FILE_BYTES || nowMs - metadata.mtimeMs > MAX_SAMPLE_AGE_MS) return null;
    const text = await readFile(filePath, "utf8");
    const values = parseKeyValues(text);
    return {
      name: match[1],
      courtNumber: Number(match[2]),
      branch: match[3] as FfmpegBranchSnapshot["branch"],
      sampledAt: metadata.mtime.toISOString(),
      frame: nonNegativeInteger(values.get("frame")),
      framesPerSecond: boundedNumber(values.get("fps"), 0, 240),
      bitrateBps: scaleNumber(values.get("bitrate_kbps"), 1_000),
      outputTimeMs: scaleNumber(values.get("out_time_us"), 1 / 1_000),
      duplicatedFrames: nonNegativeInteger(values.get("dup_frames")),
      droppedFrames: nonNegativeInteger(values.get("drop_frames")),
      speedRatio: boundedNumber(values.get("speed"), 0, 20)
    } satisfies FfmpegBranchSnapshot;
  }));
  return snapshots.filter((snapshot): snapshot is FfmpegBranchSnapshot => snapshot !== null);
}

export class FfmpegSpeedDeriver {
  private readonly previous = new Map<string, {
    samples: Array<{ sampledAtMs: number; frame: number; outputTimeMs: number }>;
    framesPerSecond: number | null;
    speedRatio: number | null;
  }>();

  update(branches: FfmpegBranchSnapshot[]): FfmpegBranchSnapshot[] {
    const active = new Set(branches.map((branch) => branch.name));
    for (const name of this.previous.keys()) {
      if (!active.has(name)) this.previous.delete(name);
    }
    return branches.map((branch) => this.observe(branch));
  }

  private observe(branch: FfmpegBranchSnapshot): FfmpegBranchSnapshot {
    const sampledAtMs = Date.parse(branch.sampledAt);
    const outputTimeMs = branch.outputTimeMs;
    if (!Number.isFinite(sampledAtMs) || outputTimeMs == null || !Number.isFinite(outputTimeMs)) {
      this.previous.delete(branch.name);
      return branch;
    }

    const current = { sampledAtMs, frame: branch.frame, outputTimeMs };
    const previous = this.previous.get(branch.name);
    if (!previous) {
      this.previous.set(branch.name, { samples: [current], framesPerSecond: null, speedRatio: null });
      return { ...branch, framesPerSecond: null, speedRatio: null };
    }

    const latest = previous.samples.at(-1);
    if (!latest) throw new Error("FFmpeg cadence history is empty");
    if (sampledAtMs === latest.sampledAtMs && branch.frame === latest.frame && outputTimeMs === latest.outputTimeMs) {
      return { ...branch, framesPerSecond: previous.framesPerSecond, speedRatio: previous.speedRatio };
    }
    if (sampledAtMs <= latest.sampledAtMs || branch.frame < latest.frame || outputTimeMs < latest.outputTimeMs) {
      this.previous.set(branch.name, { samples: [current], framesPerSecond: null, speedRatio: null });
      return { ...branch, framesPerSecond: null, speedRatio: null };
    }

    const samples = [...previous.samples, current]
      .filter((sample) => sampledAtMs - sample.sampledAtMs <= MAX_DERIVATION_WINDOW_MS);
    const anchor = samples.find((sample) => sampledAtMs - sample.sampledAtMs >= MIN_DERIVATION_WINDOW_MS);
    let framesPerSecond: number | null = null;
    let speedRatio: number | null = null;
    if (anchor) {
      const elapsedMs = sampledAtMs - anchor.sampledAtMs;
      const derivedFramesPerSecond = ((branch.frame - anchor.frame) * 1_000) / elapsedMs;
      framesPerSecond = Number.isFinite(derivedFramesPerSecond) && derivedFramesPerSecond <= 240
        ? derivedFramesPerSecond
        : null;
      const derivedSpeedRatio = (outputTimeMs - anchor.outputTimeMs) / elapsedMs;
      speedRatio = Number.isFinite(derivedSpeedRatio) && derivedSpeedRatio <= 20 ? derivedSpeedRatio : null;
    }
    this.previous.set(branch.name, { samples, framesPerSecond, speedRatio });
    return { ...branch, framesPerSecond, speedRatio };
  }
}

export function parseKeyValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/).slice(0, 64)) {
    const match = /^([a-z_]{1,32})=([0-9.]{0,32})$/.exec(line.trim());
    if (match?.[1] && match[2] != null) values.set(match[1], match[2]);
  }
  return values;
}

function nonNegativeInteger(value: string | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function boundedNumber(value: string | undefined, min: number, max: number): number | null {
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : null;
}

function scaleNumber(value: string | undefined, scale: number): number | null {
  const number = boundedNumber(value, 0, Number.MAX_SAFE_INTEGER);
  return number == null ? null : number * scale;
}
