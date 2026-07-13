import type { MediaPathSnapshot, MediaTransportSnapshot } from "./contracts.js";

export type MediaPathApiRow = {
  name?: unknown;
  ready?: unknown;
  readyTime?: unknown;
  bytesReceived?: unknown;
  bytesSent?: unknown;
  readers?: unknown;
  source?: unknown;
  tracks?: unknown;
  tracks2?: unknown;
};

type SafeMediaPathDetail = Pick<MediaPathApiRow, "source" | "tracks" | "tracks2">;
type CachedPathDetail = {
  readyTime: string | null;
  lastBytesReceived: number;
  detail: SafeMediaPathDetail;
};
type FailedPathDetail = { readyTime: string | null; retryAfterMs: number };

export type ByteSample = { bytes: number; sampledAtMs: number };

export class MediaPathDetailCache {
  private readonly byPath = new Map<string, CachedPathDetail>();
  private readonly failures = new Map<string, FailedPathDetail>();

  async enrich(
    rows: unknown[],
    fetchDetail: (pathName: string) => Promise<unknown>,
    nowMs = Date.now()
  ): Promise<{ rows: unknown[]; failedPaths: number }> {
    const activePaths = new Set<string>();
    let failedPaths = 0;
    const enriched = await mapInBatches(rows, 8, async (input) => {
      if (!input || typeof input !== "object") return input;
      const row = input as MediaPathApiRow;
      const name = mediaPathName(row.name);
      if (!name) return input;
      activePaths.add(name);
      if (row.ready !== true) {
        this.byPath.delete(name);
        this.failures.delete(name);
        return input;
      }

      const readyTime = isoDateOrNull(row.readyTime);
      const bytesReceived = nonNegativeInteger(row.bytesReceived);
      if (hasCompletePathDetail(row)) {
        this.failures.delete(name);
        this.byPath.set(name, {
          readyTime,
          lastBytesReceived: bytesReceived,
          detail: sanitizePathDetail(row)
        });
        return input;
      }

      const cached = this.byPath.get(name);
      const sameReadyEpoch = cached
        && cached.readyTime === readyTime
        && (readyTime !== null || bytesReceived >= cached.lastBytesReceived);
      if (sameReadyEpoch) {
        cached.lastBytesReceived = bytesReceived;
        return { ...row, ...cached.detail };
      }

      const failed = this.failures.get(name);
      if (failed?.readyTime === readyTime && failed.retryAfterMs > nowMs) {
        failedPaths += 1;
        return input;
      }

      try {
        const detailInput = await fetchDetail(name);
        if (!detailInput || typeof detailInput !== "object") throw new Error("Invalid MediaMTX path detail.");
        const detail = sanitizePathDetail(detailInput as MediaPathApiRow);
        if (!hasCompletePathDetail(detail)) throw new Error("Incomplete MediaMTX path detail.");
        this.failures.delete(name);
        this.byPath.set(name, { readyTime, lastBytesReceived: bytesReceived, detail });
        return { ...row, ...detail };
      } catch {
        failedPaths += 1;
        this.failures.set(name, { readyTime, retryAfterMs: nowMs + 30_000 });
        return input;
      }
    });

    for (const name of this.byPath.keys()) {
      if (!activePaths.has(name)) this.byPath.delete(name);
    }
    for (const name of this.failures.keys()) {
      if (!activePaths.has(name)) this.failures.delete(name);
    }
    return { rows: enriched, failedPaths };
  }
}

export function parseMediaPath(
  input: MediaPathApiRow,
  previous: ByteSample | null,
  sampledAtMs: number,
  frameErrors = 0,
  transport: MediaTransportSnapshot | null = null
): { path: MediaPathSnapshot; byteSample: ByteSample } | null {
  const name = mediaPathName(input.name);
  if (!name) return null;
  const match = /^court([1-8])_(raw|preview|program|calibration|monitor)$/.exec(name)!;
  const courtNumber = Number(match[1]);
  const branch = match[2] as MediaPathSnapshot["branch"];
  const bytesReceived = nonNegativeInteger(input.bytesReceived);
  const bytesSent = nonNegativeInteger(input.bytesSent);
  const bitrate = deriveBitrate(previous, { bytes: bytesReceived, sampledAtMs });
  const codecs = parseCodecs(Array.isArray(input.tracks2) ? input.tracks2 : input.tracks);
  const source = parseSource(input.source);
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
      sourceProtocol: source.protocol,
      sourceMode: source.mode,
      videoCodec: codecs.video.codec,
      audioCodec: codecs.audio.codec,
      videoWidth: codecs.video.width,
      videoHeight: codecs.video.height,
      videoProfile: codecs.video.profile,
      audioSampleRateHz: codecs.audio.sampleRateHz,
      audioChannelCount: codecs.audio.channelCount,
      transport
    },
    byteSample: { bytes: bytesReceived, sampledAtMs }
  };
}

export function parseSrtTransports(input: unknown): Map<string, MediaTransportSnapshot> {
  const result = new Map<string, MediaTransportSnapshot>();
  if (!input || typeof input !== "object" || !("items" in input) || !Array.isArray(input.items)) return result;
  for (const item of input.items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const path = mediaPathName(row.path);
    if (!path || row.state !== "publish") continue;
    result.set(path, {
      rttMs: finiteNumberOrNull(row.msRTT, 60_000),
      packetsReceived: nonNegativeIntegerOrNull(row.packetsReceived),
      packetsLost: nonNegativeIntegerOrNull(row.packetsReceivedLoss),
      packetsRetransmitted: nonNegativeIntegerOrNull(row.packetsReceivedRetrans),
      packetsDropped: nonNegativeIntegerOrNull(row.packetsReceivedDrop),
      receiveRateBps: finiteNumberOrNull(row.mbpsReceiveRate) == null ? null : Number(row.mbpsReceiveRate) * 1_000_000,
      receiveBufferMs: finiteNumberOrNull(row.msReceiveBuf, 60_000),
      configuredLatencyMs: finiteNumberOrNull(row.msReceiveTsbPdDelay, 60_000)
    });
  }
  return result;
}

export function deriveBitrate(previous: ByteSample | null, current: ByteSample): number | null {
  if (!previous || current.sampledAtMs <= previous.sampledAtMs || current.bytes < previous.bytes) return null;
  return ((current.bytes - previous.bytes) * 8_000) / (current.sampledAtMs - previous.sampledAtMs);
}

function parseCodecs(input: unknown): {
  video: { codec: string | null; width: number | null; height: number | null; profile: string | null };
  audio: { codec: string | null; sampleRateHz: number | null; channelCount: number | null };
} {
  const video = { codec: null as string | null, width: null as number | null, height: null as number | null, profile: null as string | null };
  const audio = { codec: null as string | null, sampleRateHz: null as number | null, channelCount: null as number | null };
  if (!Array.isArray(input)) return { video, audio };
  for (const row of input) {
    const codecValue = typeof row === "string"
      ? row
      : row && typeof row === "object" && "codec" in row && typeof row.codec === "string"
        ? row.codec
        : null;
    if (!codecValue) continue;
    const codec = normalizeCodec(codecValue);
    if (!codec) continue;
    const props = row && typeof row === "object" && "codecProps" in row && row.codecProps && typeof row.codecProps === "object"
      ? row.codecProps as Record<string, unknown>
      : {};
    const upper = codecValue.toUpperCase();
    if (!video.codec && /H26|HEVC|AVC|AV1|VP8|VP9/.test(upper)) {
      video.codec = codec;
      video.width = positiveIntegerOrNull(props.width, 8192);
      video.height = positiveIntegerOrNull(props.height, 8192);
      video.profile = boundedIdentifier(props.profile);
    } else if (!audio.codec && /AUDIO|AAC|OPUS|MP3|PCMU|PCMA|G7(?:11|22|29)/.test(upper)) {
      audio.codec = codec;
      audio.sampleRateHz = positiveIntegerOrNull(props.sampleRate, 384_000);
      audio.channelCount = positiveIntegerOrNull(props.channelCount, 32);
    }
  }
  return { video, audio };
}

function parseSource(input: unknown): {
  protocol: MediaPathSnapshot["sourceProtocol"];
  mode: MediaPathSnapshot["sourceMode"];
} {
  if (!input || typeof input !== "object" || !("type" in input) || typeof input.type !== "string") {
    return { protocol: null, mode: null };
  }
  const type = input.type.toLowerCase();
  const protocol = type.includes("rtmp") ? "RTMP"
    : type.includes("srt") ? "SRT"
      : type.includes("rtsp") ? "RTSP"
        : type.includes("webrtc") || type.includes("whep") || type.includes("whip") ? "WEBRTC"
          : type.includes("hls") ? "HLS"
            : null;
  const mode = type.endsWith("source") ? "PULL" : type.endsWith("conn") || type.endsWith("session") ? "PUSH" : null;
  return { protocol, mode };
}

function sanitizePathDetail(input: MediaPathApiRow): SafeMediaPathDetail {
  const sourceType = input.source && typeof input.source === "object" && "type" in input.source && typeof input.source.type === "string"
    ? input.source.type
    : null;
  return {
    source: sourceType ? { type: sourceType } : undefined,
    tracks: Array.isArray(input.tracks) ? input.tracks : undefined,
    tracks2: Array.isArray(input.tracks2) ? input.tracks2 : undefined
  };
}

function hasCompletePathDetail(input: MediaPathApiRow): boolean {
  const hasSource = Boolean(input.source && typeof input.source === "object" && "type" in input.source && typeof input.source.type === "string");
  return hasSource && (Array.isArray(input.tracks2) || Array.isArray(input.tracks));
}

function mediaPathName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^court[1-8]_(raw|preview|program|calibration|monitor)$/.test(value) ? value : null;
}

function normalizeCodec(value: string): string | null {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact === "H264" || compact === "AVC") return "H264";
  if (compact === "H265" || compact === "HEVC") return "H265";
  if (compact === "MPEG4AUDIO" || compact === "AAC") return "AAC";
  if (compact === "OPUS") return "OPUS";
  return boundedIdentifier(value);
}

function boundedIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80) || null;
}

function nonNegativeInteger(value: unknown): number {
  return nonNegativeIntegerOrNull(value) ?? 0;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function positiveIntegerOrNull(value: unknown, max: number): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max ? Math.trunc(number) : null;
}

function finiteNumberOrNull(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function mapInBatches<T, U>(inputs: T[], batchSize: number, mapper: (input: T) => Promise<U>): Promise<U[]> {
  const output: U[] = [];
  for (let index = 0; index < inputs.length; index += batchSize) {
    output.push(...await Promise.all(inputs.slice(index, index + batchSize).map(mapper)));
  }
  return output;
}
