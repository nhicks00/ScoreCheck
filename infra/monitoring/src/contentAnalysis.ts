import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { CameraContentSnapshot } from "./contracts.js";

export const CONTENT_ANALYSIS_WIDTH = 160;
export const CONTENT_ANALYSIS_HEIGHT = 90;
export const CONTENT_ANALYSIS_FRAME_BYTES = CONTENT_ANALYSIS_WIDTH * CONTENT_ANALYSIS_HEIGHT;
export const CONTENT_ANALYSIS_AUDIO_RATE = 8_000;
export const CONTENT_ANALYSIS_AUDIO_WINDOW_BYTES = CONTENT_ANALYSIS_AUDIO_RATE * 2;

const DARK_LUMA_THRESHOLD = 16;
const BLACK_DARK_PIXEL_RATIO = 0.97;
const BLACK_MEAN_LUMA = 16;
const BLACK_LUMA_VARIANCE = 40;
const FREEZE_MEAN_DIFFERENCE = 0.8;
const AUDIO_SIGNAL_THRESHOLD_DB = -70;
const CLIPPED_SAMPLE_LEVEL = 32_700;
const SAMPLE_STALE_MS = 4_000;
const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 15_000;
const PROBE_TIMEOUT_MS = 10_000;
const ANALYZER_OUTPUT_TIMEOUT_MS = 10_000;
const ANALYZER_WATCHDOG_INTERVAL_MS = 1_000;

export type VisualAnalysisState = {
  previousLuma: Uint8Array | null;
  frozenSinceMonotonicMs: number | null;
  blackSinceMonotonicMs: number | null;
};

export type AudioAnalysisState = {
  firstSampleMonotonicMs: number | null;
  lastSampleMonotonicMs: number | null;
  lastSignalMonotonicMs: number | null;
};

type StreamProbe = { video: boolean; audio: boolean };

export type ContentAnalyzerSource = {
  courtNumber: number;
  url: string;
};

export type ContentAnalyzerRuntime = {
  ffmpegPath: string;
  ffprobePath: string;
  sources: ContentAnalyzerSource[];
};

type WorkerDependencies = {
  spawnProcess?: typeof spawn;
  nowMs?: () => number;
  monotonicMs?: () => number;
  log?: (message: string) => void;
};

export function initialVisualAnalysisState(): VisualAnalysisState {
  return { previousLuma: null, frozenSinceMonotonicMs: null, blackSinceMonotonicMs: null };
}

export function initialAudioAnalysisState(): AudioAnalysisState {
  return { firstSampleMonotonicMs: null, lastSampleMonotonicMs: null, lastSignalMonotonicMs: null };
}

export function analyzeGrayFrame(
  state: VisualAnalysisState,
  frame: Uint8Array,
  sampledAtMs: number,
  monotonicMs: number
): { state: VisualAnalysisState; health: CameraContentSnapshot["visual"] } {
  if (frame.length !== CONTENT_ANALYSIS_FRAME_BYTES || !Number.isFinite(sampledAtMs) || !Number.isFinite(monotonicMs)) {
    throw new Error("Invalid visual-analysis frame.");
  }
  let sum = 0;
  let darkPixels = 0;
  for (const value of frame) {
    sum += value;
    if (value <= DARK_LUMA_THRESHOLD) darkPixels += 1;
  }
  const meanLuma = sum / frame.length;
  let varianceSum = 0;
  let differenceSum = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const value = frame[index] ?? 0;
    const centered = value - meanLuma;
    varianceSum += centered * centered;
    if (state.previousLuma?.length === frame.length) differenceSum += Math.abs(value - (state.previousLuma[index] ?? 0));
  }
  const lumaVariance = varianceSum / frame.length;
  const darkPixelRatio = darkPixels / frame.length;
  const frameDifference = state.previousLuma?.length === frame.length ? differenceSum / frame.length : null;
  const frozen = frameDifference != null && frameDifference <= FREEZE_MEAN_DIFFERENCE;
  const black = darkPixelRatio >= BLACK_DARK_PIXEL_RATIO
    && meanLuma <= BLACK_MEAN_LUMA
    && lumaVariance <= BLACK_LUMA_VARIANCE;
  const frozenSinceMonotonicMs = frozen ? state.frozenSinceMonotonicMs ?? monotonicMs : null;
  const blackSinceMonotonicMs = black ? state.blackSinceMonotonicMs ?? monotonicMs : null;
  return {
    state: {
      previousLuma: Uint8Array.from(frame),
      frozenSinceMonotonicMs,
      blackSinceMonotonicMs
    },
    health: {
      sampledAt: new Date(sampledAtMs).toISOString(),
      meanLuma,
      lumaVariance,
      darkPixelRatio,
      frameDifference,
      frozenDurationMs: frozenSinceMonotonicMs == null ? 0 : Math.max(0, monotonicMs - frozenSinceMonotonicMs),
      blackDurationMs: blackSinceMonotonicMs == null ? 0 : Math.max(0, monotonicMs - blackSinceMonotonicMs)
    }
  };
}

export function analyzePcm16Window(
  state: AudioAnalysisState,
  pcm: Uint8Array,
  sampledAtMs: number,
  monotonicMs: number
): { state: AudioAnalysisState; health: Omit<CameraContentSnapshot["audio"], "trackPresent"> } {
  if (pcm.length !== CONTENT_ANALYSIS_AUDIO_WINDOW_BYTES || pcm.length % 2 !== 0) {
    throw new Error("Invalid audio-analysis window.");
  }
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const sampleCount = pcm.length / 2;
  let squareSum = 0;
  let peak = 0;
  let clipped = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = view.getInt16(offset, true);
    const level = Math.abs(sample);
    squareSum += (sample / 32_768) ** 2;
    peak = Math.max(peak, level);
    if (level >= CLIPPED_SAMPLE_LEVEL) clipped += 1;
  }
  const rms = Math.sqrt(squareSum / sampleCount);
  const rmsDb = amplitudeDb(rms);
  const peakDb = amplitudeDb(peak / 32_768);
  const firstSampleMonotonicMs = state.firstSampleMonotonicMs ?? monotonicMs;
  const lastSignalMonotonicMs = rmsDb > AUDIO_SIGNAL_THRESHOLD_DB ? monotonicMs : state.lastSignalMonotonicMs;
  const silenceOrigin = lastSignalMonotonicMs ?? firstSampleMonotonicMs;
  return {
    state: { firstSampleMonotonicMs, lastSampleMonotonicMs: monotonicMs, lastSignalMonotonicMs },
    health: {
      sampledAt: new Date(sampledAtMs).toISOString(),
      rmsDb,
      peakDb,
      clippedSampleRatio: clipped / sampleCount,
      secondsSinceAudio: Math.max(0, monotonicMs - silenceOrigin) / 1_000
    }
  };
}

export function contentAnalyzerFfprobeArgs(url: string): string[] {
  return [
    "-v", "error",
    "-rtsp_transport", "tcp",
    "-show_entries", "stream=codec_type",
    "-of", "csv=p=0",
    url
  ];
}

export function parseContentAnalyzerProbe(output: string): StreamProbe {
  const types = new Set(output.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean));
  return { video: types.has("video"), audio: types.has("audio") };
}

export function contentAnalyzerFfmpegArgs(url: string, audio: boolean): string[] {
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-fflags", "nobuffer", "-flags", "low_delay",
    "-rtsp_transport", "tcp", "-skip_frame", "nokey",
    "-i", url,
    "-map", "0:v:0", "-an",
    "-vf", `fps=1,scale=${CONTENT_ANALYSIS_WIDTH}:${CONTENT_ANALYSIS_HEIGHT}:flags=fast_bilinear,format=gray`,
    "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"
  ];
  if (audio) {
    args.push(
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(CONTENT_ANALYSIS_AUDIO_RATE),
      "-f", "s16le", "pipe:3"
    );
  }
  return args;
}

export class ContentAnalyzerManager {
  private readonly workers: ContentAnalyzerWorker[];

  constructor(runtime: ContentAnalyzerRuntime, dependencies: WorkerDependencies = {}) {
    this.workers = runtime.sources.map((source) => new ContentAnalyzerWorker(runtime, source, dependencies));
  }

  start(): void {
    for (const worker of this.workers) worker.start();
  }

  snapshots(): CameraContentSnapshot[] {
    return this.workers.map((worker) => worker.snapshot());
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.stop()));
  }
}

class ContentAnalyzerWorker {
  private readonly spawnProcess: typeof spawn;
  private readonly nowMs: () => number;
  private readonly monotonicMs: () => number;
  private readonly log: (message: string) => void;
  private stopped = true;
  private cycleRunning = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private probeChild: ChildProcess | null = null;
  private analyzerChild: ChildProcess | null = null;
  private retryMs = INITIAL_RETRY_MS;
  private restartCount = 0;
  private lastExitAt: string | null = null;
  private sessionStartedAt: string | null = null;
  private framesAnalyzed = 0;
  private visualState = initialVisualAnalysisState();
  private visual: CameraContentSnapshot["visual"] = emptyVisual();
  private audioExpected = false;
  private audioState = initialAudioAnalysisState();
  private audio: CameraContentSnapshot["audio"] = emptyAudio();
  private videoBuffer = Buffer.alloc(0);
  private audioBuffer = Buffer.alloc(0);
  private lastVideoOutputMonotonicMs: number | null = null;

  constructor(
    private readonly runtime: ContentAnalyzerRuntime,
    private readonly source: ContentAnalyzerSource,
    dependencies: WorkerDependencies
  ) {
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.nowMs = dependencies.nowMs ?? Date.now;
    this.monotonicMs = dependencies.monotonicMs ?? (() => performance.now());
    this.log = dependencies.log ?? ((message) => console.error(message));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.watchdogTimer = setInterval(() => this.checkAnalyzerOutput(), ANALYZER_WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
    void this.startCycle();
  }

  snapshot(): CameraContentSnapshot {
    const now = this.nowMs();
    const sampleAgeMs = this.visual.sampledAt ? now - Date.parse(this.visual.sampledAt) : Number.POSITIVE_INFINITY;
    const state = this.analyzerChild && sampleAgeMs <= SAMPLE_STALE_MS
      ? "ANALYZING"
      : this.analyzerChild ? "STARTING" : "UNAVAILABLE";
    const lastAudioAgeMs = this.audio.sampledAt ? now - Date.parse(this.audio.sampledAt) : Number.POSITIVE_INFINITY;
    return {
      courtNumber: this.source.courtNumber,
      sourceBranch: "raw",
      state,
      sessionStartedAt: this.sessionStartedAt,
      framesAnalyzed: this.framesAnalyzed,
      visual: this.visual,
      audio: { ...this.audio, trackPresent: this.audioExpected && lastAudioAgeMs <= SAMPLE_STALE_MS },
      process: {
        running: this.analyzerChild != null,
        restartCount: this.restartCount,
        lastExitAt: this.lastExitAt
      }
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    await Promise.all([terminate(this.probeChild), terminate(this.analyzerChild)]);
    this.probeChild = null;
    this.analyzerChild = null;
  }

  private async startCycle(): Promise<void> {
    if (this.stopped || this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      const probe = await this.probe();
      if (!probe.video) throw new Error("VIDEO_STREAM_MISSING");
      if (this.stopped) return;
      this.audioExpected = probe.audio;
      this.resetSession();
      this.spawnAnalyzer(probe.audio);
    } catch {
      if (!this.stopped) this.scheduleRetry("SOURCE_PROBE_FAILED");
    } finally {
      this.cycleRunning = false;
    }
  }

  private probe(): Promise<StreamProbe> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.runtime.ffprobePath, contentAnalyzerFfprobeArgs(this.source.url), {
        stdio: ["ignore", "pipe", "ignore"]
      });
      this.probeChild = child;
      const chunks: Buffer[] = [];
      let bytes = 0;
      let finished = false;
      const timeout = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
      timeout.unref();
      child.stdout?.on("data", (chunk: Buffer) => {
        if (bytes >= 4_096) return;
        const bounded = chunk.subarray(0, 4_096 - bytes);
        chunks.push(bounded);
        bytes += bounded.length;
      });
      const finish = (error: Error | null, code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        this.probeChild = null;
        if (error || code !== 0) reject(error ?? new Error("SOURCE_PROBE_FAILED"));
        else resolve(parseContentAnalyzerProbe(Buffer.concat(chunks).toString("utf8")));
      };
      child.once("error", (error) => finish(error, null));
      child.once("close", (code) => finish(null, code));
    });
  }

  private spawnAnalyzer(audio: boolean): void {
    const stdio: ["ignore", "pipe", "ignore", "pipe" | "ignore"] = ["ignore", "pipe", "ignore", audio ? "pipe" : "ignore"];
    const child = this.spawnProcess(this.runtime.ffmpegPath, contentAnalyzerFfmpegArgs(this.source.url, audio), { stdio });
    this.analyzerChild = child;
    this.lastVideoOutputMonotonicMs = this.monotonicMs();
    child.stdout?.on("data", (chunk: Buffer) => this.acceptVideo(chunk));
    const audioStream = audio ? child.stdio[3] as Readable | null : null;
    audioStream?.on("data", (chunk: Buffer) => this.acceptAudio(chunk));
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (this.analyzerChild === child) this.analyzerChild = null;
      this.lastVideoOutputMonotonicMs = null;
      this.lastExitAt = new Date(this.nowMs()).toISOString();
      if (!this.stopped) this.scheduleRetry("ANALYZER_EXITED");
    };
    child.once("error", finish);
    child.once("close", finish);
  }

  private acceptVideo(chunk: Buffer): void {
    this.lastVideoOutputMonotonicMs = this.monotonicMs();
    this.videoBuffer = Buffer.concat([this.videoBuffer, chunk]);
    while (this.videoBuffer.length >= CONTENT_ANALYSIS_FRAME_BYTES) {
      const frame = this.videoBuffer.subarray(0, CONTENT_ANALYSIS_FRAME_BYTES);
      this.videoBuffer = this.videoBuffer.subarray(CONTENT_ANALYSIS_FRAME_BYTES);
      const result = analyzeGrayFrame(this.visualState, frame, this.nowMs(), this.monotonicMs());
      this.visualState = result.state;
      this.visual = result.health;
      this.framesAnalyzed += 1;
      this.retryMs = INITIAL_RETRY_MS;
    }
  }

  private acceptAudio(chunk: Buffer): void {
    this.audioBuffer = Buffer.concat([this.audioBuffer, chunk]);
    while (this.audioBuffer.length >= CONTENT_ANALYSIS_AUDIO_WINDOW_BYTES) {
      const window = this.audioBuffer.subarray(0, CONTENT_ANALYSIS_AUDIO_WINDOW_BYTES);
      this.audioBuffer = this.audioBuffer.subarray(CONTENT_ANALYSIS_AUDIO_WINDOW_BYTES);
      const result = analyzePcm16Window(this.audioState, window, this.nowMs(), this.monotonicMs());
      this.audioState = result.state;
      this.audio = { ...result.health, trackPresent: true };
    }
  }

  private resetSession(): void {
    this.sessionStartedAt = new Date(this.nowMs()).toISOString();
    this.visualState = initialVisualAnalysisState();
    this.visual = emptyVisual();
    this.audioState = initialAudioAnalysisState();
    this.audio = emptyAudio();
    this.videoBuffer = Buffer.alloc(0);
    this.audioBuffer = Buffer.alloc(0);
    this.lastVideoOutputMonotonicMs = null;
  }

  private checkAnalyzerOutput(): void {
    if (!this.analyzerChild || this.lastVideoOutputMonotonicMs == null) return;
    if (this.monotonicMs() - this.lastVideoOutputMonotonicMs <= ANALYZER_OUTPUT_TIMEOUT_MS) return;
    this.log(`camera-content analyzer court=${this.source.courtNumber} state=restart code=VIDEO_OUTPUT_STALE`);
    this.lastVideoOutputMonotonicMs = this.monotonicMs();
    this.analyzerChild.kill("SIGKILL");
  }

  private scheduleRetry(code: string): void {
    this.restartCount += 1;
    this.log(`camera-content analyzer court=${this.source.courtNumber} state=retry code=${code} delay_ms=${this.retryMs}`);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.startCycle();
    }, this.retryMs);
    this.retryTimer.unref();
    this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
  }
}

function emptyVisual(): CameraContentSnapshot["visual"] {
  return {
    sampledAt: null,
    meanLuma: null,
    lumaVariance: null,
    darkPixelRatio: null,
    frameDifference: null,
    frozenDurationMs: 0,
    blackDurationMs: 0
  };
}

function emptyAudio(): CameraContentSnapshot["audio"] {
  return {
    sampledAt: null,
    trackPresent: false,
    rmsDb: null,
    peakDb: null,
    clippedSampleRatio: null,
    secondsSinceAudio: null
  };
}

function amplitudeDb(amplitude: number): number {
  return Math.max(-120, Math.min(0, 20 * Math.log10(Math.max(amplitude, 1e-6))));
}

async function terminate(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([closed.then(() => true), sleep(2_000).then(() => false)]);
  if (graceful) return;
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  await Promise.race([closed, sleep(2_000)]);
}
