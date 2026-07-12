import crypto from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { constantTimeEqual } from "./security";

export const COMMENTARY_COOKIE = "scorecheck_commentary";
export const COMMENTARY_SESSION_MS = 24 * 60 * 60 * 1000;
export const COMMENTARY_ROOM_COUNT = 8;

const COMMENTARY_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const COOKIE_VERSION = "v1";
const DEFAULT_ROOM_PREFIX = "scorecheck-court-";

export type CommentaryRole = "commentator" | "producer" | "program";

export type CommentaryConnection = {
  serverUrl: string;
  roomName: string;
  token: string;
};

export function commentaryRoomName(courtNumber: number): string {
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || courtNumber > COMMENTARY_ROOM_COUNT) {
    throw new Error("Commentary court number must be between 1 and 8");
  }
  const prefix = process.env.LIVEKIT_COMMENTARY_ROOM_PREFIX?.trim() || DEFAULT_ROOM_PREFIX;
  return `${prefix}${courtNumber}`;
}

export function commentaryLiveKitConfigured(): boolean {
  return commentaryLiveKitConfig() !== null;
}

export function commentaryLiveKitPublicUrl(): string {
  return process.env.NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL?.trim() ?? "";
}

export async function createCommentaryConnection(input: {
  courtNumber: number;
  displayName: string;
  role: CommentaryRole;
}): Promise<CommentaryConnection> {
  const config = commentaryLiveKitConfig();
  if (!config) throw new Error("LiveKit commentary is not configured");
  const displayName = normalizeDisplayName(input.displayName, input.role);
  const identity = `${input.role}-${input.courtNumber}-${crypto.randomUUID()}`;
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    name: displayName,
    ttl: COMMENTARY_TOKEN_TTL_SECONDS,
    metadata: JSON.stringify({ courtNumber: input.courtNumber, role: input.role })
  });
  token.addGrant({
    roomJoin: true,
    room: commentaryRoomName(input.courtNumber),
    canPublish: input.role !== "program",
    canSubscribe: true,
    canPublishData: input.role !== "program"
  });
  return {
    serverUrl: config.publicUrl,
    roomName: commentaryRoomName(input.courtNumber),
    token: await token.toJwt()
  };
}

function commentaryLiveKitConfig(): { publicUrl: string; apiKey: string; apiSecret: string } | null {
  const publicUrl = commentaryLiveKitPublicUrl();
  const apiKey = process.env.LIVEKIT_COMMENTARY_API_KEY?.trim() ?? "";
  const apiSecret = process.env.LIVEKIT_COMMENTARY_API_SECRET?.trim() ?? "";
  if (!publicUrl || !apiKey || !apiSecret || !/^wss:\/\//i.test(publicUrl)) return null;
  return { publicUrl, apiKey, apiSecret };
}

function normalizeDisplayName(value: string, role: CommentaryRole): string {
  const trimmed = value.trim().replace(/\s+/g, " ").slice(0, 80);
  if (trimmed) return trimmed;
  if (role === "program") return "Program mixer";
  if (role === "producer") return "Producer";
  return "Commentator";
}

export function commentaryPasscode(): string {
  return process.env.COMMENTATOR_PASSCODE?.trim() ?? "";
}

export function commentaryPortalEnabled(): boolean {
  return commentaryPasscode().length > 0;
}

export function checkCommentaryPasscode(input: string | null | undefined): boolean {
  const expected = commentaryPasscode();
  if (!expected) return false;
  return constantTimeEqual((input ?? "").trim(), expected);
}

function commentarySignature(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(`scorecheck-commentary:${payload}`).digest("hex");
}

export function signCommentaryCookie(secret: string, expiresAtMs: number): string {
  const payload = `${COOKIE_VERSION}.${expiresAtMs}`;
  return `${payload}.${commentarySignature(secret, payload)}`;
}

export function verifyCommentaryCookie(
  value: string | null | undefined,
  secret: string,
  nowMs = Date.now()
): boolean {
  if (!value || !secret) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return false;
  const expiresAtMs = Number(parts[1]);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
  return constantTimeEqual(parts[2], commentarySignature(secret, `${parts[0]}.${parts[1]}`));
}
