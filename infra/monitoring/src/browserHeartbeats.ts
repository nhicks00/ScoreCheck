import crypto from "node:crypto";
import { z } from "zod";
import {
  browserHeartbeatPayloadSchema,
  MONITORING_CONTRACT_VERSION,
  type BrowserHeartbeatPayload,
  type BrowserHeartbeatSnapshot
} from "./contracts.js";

const credentialSchema = z.object({
  v: z.literal(MONITORING_CONTRACT_VERSION),
  cid: z.string().uuid(),
  court: z.number().int().min(1).max(8),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive()
}).strict();

const MAX_TOKEN_LENGTH = 2_048;
const MAX_CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1_000;
const HEARTBEAT_REPLAY_WINDOW_MS = 30_000;
const HEARTBEAT_FUTURE_SKEW_MS = 10_000;

export class BrowserHeartbeatError extends Error {}

export class BrowserHeartbeatManager {
  private readonly lastSequenceByCredential = new Map<string, { sequence: number; expiresAtMs: number }>();
  private readonly byCourt = new Map<number, BrowserHeartbeatSnapshot>();

  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error("Browser heartbeat secret must be at least 32 characters.");
  }

  accept(token: string, input: unknown, now = new Date()): BrowserHeartbeatSnapshot {
    const nowMs = now.getTime();
    const credential = verifyCredential(token, this.secret, nowMs);
    const payload = browserHeartbeatPayloadSchema.parse(input);
    if (payload.credentialId !== credential.cid || payload.courtNumber !== credential.court) {
      throw new BrowserHeartbeatError("Credential scope mismatch.");
    }

    const sampledAtMs = Date.parse(payload.sampledAt);
    if (sampledAtMs < nowMs - HEARTBEAT_REPLAY_WINDOW_MS || sampledAtMs > nowMs + HEARTBEAT_FUTURE_SKEW_MS) {
      throw new BrowserHeartbeatError("Heartbeat timestamp is outside the replay window.");
    }
    const previous = this.lastSequenceByCredential.get(credential.cid);
    if (previous && payload.heartbeatSeq <= previous.sequence) {
      throw new BrowserHeartbeatError("Heartbeat sequence was replayed.");
    }

    this.pruneExpiredSequences(nowMs);
    this.lastSequenceByCredential.set(credential.cid, { sequence: payload.heartbeatSeq, expiresAtMs: credential.exp });
    const snapshot = { ...payload, receivedAt: now.toISOString() };
    this.byCourt.set(payload.courtNumber, snapshot);
    return snapshot;
  }

  latest(): Map<number, BrowserHeartbeatSnapshot> {
    return new Map(this.byCourt);
  }

  private pruneExpiredSequences(nowMs: number) {
    for (const [credentialId, value] of this.lastSequenceByCredential) {
      if (value.expiresAtMs < nowMs) this.lastSequenceByCredential.delete(credentialId);
    }
  }
}

export function verifyCredential(token: string, secret: string, nowMs = Date.now()) {
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new BrowserHeartbeatError("Invalid credential.");
  const [encoded, signature, ...extra] = token.split(".");
  if (!encoded || !signature || extra.length > 0) throw new BrowserHeartbeatError("Invalid credential.");
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(signature, "base64url");
  } catch {
    throw new BrowserHeartbeatError("Invalid credential.");
  }
  if (presented.length !== expected.length || !crypto.timingSafeEqual(expected, presented)) {
    throw new BrowserHeartbeatError("Invalid credential.");
  }

  let credential: z.infer<typeof credentialSchema>;
  try {
    credential = credentialSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    throw new BrowserHeartbeatError("Invalid credential.");
  }
  if (credential.exp <= nowMs || credential.iat > nowMs + HEARTBEAT_FUTURE_SKEW_MS) {
    throw new BrowserHeartbeatError("Credential is expired or not active.");
  }
  if (credential.exp - credential.iat > MAX_CREDENTIAL_TTL_MS) {
    throw new BrowserHeartbeatError("Credential lifetime exceeds the maximum.");
  }
  return credential;
}

export function signCredentialForTest(input: {
  secret: string;
  credentialId: string;
  courtNumber: number;
  issuedAtMs: number;
  expiresAtMs: number;
}) {
  const encoded = Buffer.from(JSON.stringify({
    v: MONITORING_CONTRACT_VERSION,
    cid: input.credentialId,
    court: input.courtNumber,
    iat: input.issuedAtMs,
    exp: input.expiresAtMs
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", input.secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}
