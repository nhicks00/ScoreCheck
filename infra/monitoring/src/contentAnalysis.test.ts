import { describe, expect, it } from "vitest";
import {
  CONTENT_ANALYSIS_AUDIO_WINDOW_BYTES,
  CONTENT_ANALYSIS_FRAME_BYTES,
  analyzeGrayFrame,
  analyzePcm16Window,
  contentAnalyzerFfmpegArgs,
  contentAnalyzerFfprobeArgs,
  initialAudioAnalysisState,
  initialVisualAnalysisState,
  parseContentAnalyzerProbe
} from "./contentAnalysis.js";

describe("host-local camera-content analysis", () => {
  it("uses monotonic time for repeated-picture persistence", () => {
    const frame = new Uint8Array(CONTENT_ANALYSIS_FRAME_BYTES).fill(120);
    const first = analyzeGrayFrame(initialVisualAnalysisState(), frame, Date.parse("2026-07-16T00:00:00Z"), 1_000);
    const repeated = analyzeGrayFrame(first.state, frame, Date.parse("2026-07-16T00:00:01Z"), 2_000);
    const persisted = analyzeGrayFrame(repeated.state, frame, Date.parse("2026-07-16T00:00:20Z"), 21_000);
    expect(first.health.frameDifference).toBeNull();
    expect(repeated.health.frameDifference).toBe(0);
    expect(persisted.health.frozenDurationMs).toBe(19_000);
    expect(persisted.health.blackDurationMs).toBe(0);
  });

  it("distinguishes black pictures from repeated nonblack pictures", () => {
    const black = new Uint8Array(CONTENT_ANALYSIS_FRAME_BYTES).fill(8);
    const normal = new Uint8Array(CONTENT_ANALYSIS_FRAME_BYTES).fill(120);
    const first = analyzeGrayFrame(initialVisualAnalysisState(), black, Date.parse("2026-07-16T00:00:00Z"), 0);
    const blackPersisted = analyzeGrayFrame(first.state, black, Date.parse("2026-07-16T00:00:21Z"), 21_000);
    const recovered = analyzeGrayFrame(blackPersisted.state, normal, Date.parse("2026-07-16T00:00:22Z"), 22_000);
    expect(blackPersisted.health.blackDurationMs).toBe(21_000);
    expect(blackPersisted.health.darkPixelRatio).toBe(1);
    expect(recovered.health.blackDurationMs).toBe(0);
    expect(recovered.health.frozenDurationMs).toBe(0);
  });

  it("measures camera-audio silence and clipping from bounded PCM windows", () => {
    const silent = new Uint8Array(CONTENT_ANALYSIS_AUDIO_WINDOW_BYTES);
    const first = analyzePcm16Window(initialAudioAnalysisState(), silent, Date.parse("2026-07-16T00:00:00Z"), 1_000);
    const persisted = analyzePcm16Window(first.state, silent, Date.parse("2026-07-16T00:01:01Z"), 62_000);
    expect(persisted.health.rmsDb).toBe(-120);
    expect(persisted.health.secondsSinceAudio).toBe(61);

    const clipped = new Uint8Array(CONTENT_ANALYSIS_AUDIO_WINDOW_BYTES);
    const view = new DataView(clipped.buffer);
    for (let offset = 0; offset < clipped.length; offset += 2) view.setInt16(offset, 32_767, true);
    const active = analyzePcm16Window(persisted.state, clipped, Date.parse("2026-07-16T00:01:02Z"), 63_000);
    expect(active.health.clippedSampleRatio).toBe(1);
    expect(active.health.secondsSinceAudio).toBe(0);
  });

  it("decodes every frame before low-cadence analysis and probes optional audio first", () => {
    const url = "rtsp://10.0.0.2:8554/court4_raw";
    expect(contentAnalyzerFfprobeArgs(url).at(-1)).toBe(url);
    expect(parseContentAnalyzerProbe("video\naudio\n")).toEqual({ video: true, audio: true });
    expect(parseContentAnalyzerProbe("video\n")).toEqual({ video: true, audio: false });
    const withAudio = contentAnalyzerFfmpegArgs(url, true);
    const withoutAudio = contentAnalyzerFfmpegArgs(url, false);
    expect(withAudio).not.toContain("-skip_frame");
    expect(withAudio).not.toContain("nokey");
    expect(withAudio).toContain("fps=1,scale=160:90:flags=fast_bilinear,format=gray");
    expect(withAudio).toContain("pipe:3");
    expect(withoutAudio).not.toContain("pipe:3");
    expect(withAudio).not.toContain("sh");
  });
});
