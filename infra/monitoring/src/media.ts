import type { MediaPathSnapshot } from "./contracts.js";

type MediaPathApiRow = {
  name?: unknown;
  ready?: unknown;
  readyTime?: unknown;
  bytesReceived?: unknown;
  bytesSent?: unknown;
  readers?: unknown;
  tracks?: unknown;
};

export type ByteSample = { bytes: number; sampledAtMs: number };

export function parseMediaPath(
  input: MediaPathApiRow,
  previous: ByteSample | null,
  sampledAtMs: number,
  frameErrors = 0
): { path: MediaPathSnapshot; byteSample: ByteSample } | null {
  const name = typeof input.name === "string" ? input.name : "";
  const match = /^court([1-8])_(raw|preview|program|calibration|monitor)$/.exec(name);
  if (!match) return null;
  const courtNumber = Number(match[1]);
  const branch = match[2] as MediaPathSnapshot["branch"];
  const bytesReceived = nonNegativeInteger(input.bytesReceived);
  const bytesSent = nonNegativeInteger(input.bytesSent);
  const bitrate = deriveBitrate(previous, { bytes: bytesReceived, sampledAtMs });
  const codecs = parseCodecs(input.tracks);
  return {
    path: {
      name,
      courtNumber,
      branch,
      ready: input.ready === true,
      readySince: isoDateOrNull(input.readyTime),
      bytesReceived,
      bytesSent,
      inboundBitrateBps: bitrate,
      frameErrors: Math.max(0, Math.trunc(frameErrors)),
      readerCount: Array.isArray(input.readers) ? input.readers.length : 0,
      videoCodec: codecs.video,
      audioCodec: codecs.audio
    },
    byteSample: { bytes: bytesReceived, sampledAtMs }
  };
}

export function deriveBitrate(previous: ByteSample | null, current: ByteSample): number | null {
  if (!previous || current.sampledAtMs <= previous.sampledAtMs || current.bytes < previous.bytes) return null;
  return ((current.bytes - previous.bytes) * 8_000) / (current.sampledAtMs - previous.sampledAtMs);
}

function parseCodecs(input: unknown): { video: string | null; audio: string | null } {
  if (!Array.isArray(input)) return { video: null, audio: null };
  let video: string | null = null;
  let audio: string | null = null;
  for (const row of input) {
    if (!row || typeof row !== "object") continue;
    const codec = "codec" in row && typeof row.codec === "string" ? row.codec : null;
    if (!codec) continue;
    const normalized = codec.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80) || null;
    const upper = codec.toUpperCase();
    if (!video && /H26|AV1|VP8|VP9/.test(upper)) video = normalized;
    else if (!audio) audio = normalized;
  }
  return { video, audio };
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
