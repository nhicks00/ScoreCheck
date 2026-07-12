import { z } from "zod";
import { verifyCredential } from "./browserHeartbeats.js";

const thumbnailHeadersSchema = z.object({
  credentialId: z.string().uuid(),
  courtNumber: z.coerce.number().int().min(1).max(8),
  sequence: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sampledAt: z.string().datetime({ offset: true })
}).strict();

const MAX_THUMBNAIL_BYTES = 96 * 1_024;
const MIN_THUMBNAIL_BYTES = 256;
const REPLAY_WINDOW_MS = 60_000;
const FUTURE_SKEW_MS = 10_000;

export type BrowserThumbnail = {
  courtNumber: number;
  credentialId: string;
  sequence: number;
  sampledAt: string;
  receivedAt: string;
  contentType: "image/jpeg";
  byteLength: number;
  body: Buffer;
};

export class BrowserThumbnailManager {
  private readonly byCourt = new Map<number, BrowserThumbnail>();
  private readonly lastSequence = new Map<string, { sequence: number; expiresAtMs: number }>();

  constructor(private readonly secret: string) {}

  accept(token: string, headers: Record<string, unknown>, body: unknown, now = new Date()): BrowserThumbnail {
    const nowMs = now.getTime();
    const credential = verifyCredential(token, this.secret, nowMs);
    const parsed = thumbnailHeadersSchema.parse(headers);
    if (parsed.credentialId !== credential.cid || parsed.courtNumber !== credential.court) throw new Error("Credential scope mismatch.");
    const sampledAtMs = Date.parse(parsed.sampledAt);
    if (sampledAtMs < nowMs - REPLAY_WINDOW_MS || sampledAtMs > nowMs + FUTURE_SKEW_MS) throw new Error("Thumbnail timestamp is outside the replay window.");
    if (!Buffer.isBuffer(body) || body.length < MIN_THUMBNAIL_BYTES || body.length > MAX_THUMBNAIL_BYTES) throw new Error("Invalid thumbnail size.");
    if (body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) throw new Error("Thumbnail is not JPEG data.");
    const previous = this.lastSequence.get(parsed.credentialId);
    if (previous && parsed.sequence <= previous.sequence) throw new Error("Thumbnail sequence was replayed.");
    for (const [id, value] of this.lastSequence) if (value.expiresAtMs < nowMs) this.lastSequence.delete(id);
    this.lastSequence.set(parsed.credentialId, { sequence: parsed.sequence, expiresAtMs: credential.exp });
    const thumbnail: BrowserThumbnail = {
      courtNumber: parsed.courtNumber,
      credentialId: parsed.credentialId,
      sequence: parsed.sequence,
      sampledAt: new Date(sampledAtMs).toISOString(),
      receivedAt: now.toISOString(),
      contentType: "image/jpeg",
      byteLength: body.length,
      body: Buffer.from(body)
    };
    this.byCourt.set(parsed.courtNumber, thumbnail);
    return thumbnail;
  }

  get(courtNumber: number): BrowserThumbnail | null {
    return this.byCourt.get(courtNumber) ?? null;
  }

  metadata(): Map<number, Omit<BrowserThumbnail, "body">> {
    return new Map([...this.byCourt].map(([court, thumbnail]) => {
      const { body: _body, ...metadata } = thumbnail;
      return [court, metadata];
    }));
  }
}
