import crypto from "node:crypto";
import { constantTimeEqual } from "./security";

/**
 * Commentator portal config: VDO.Ninja room URL builders plus the signed
 * cookie + passcode helpers behind /commentary. Pure functions only (env +
 * node:crypto) so everything here is unit-testable.
 */

export const COMMENTARY_COOKIE = "scorecheck_commentary";
export const COMMENTARY_SESSION_MS = 24 * 60 * 60 * 1000;

const COOKIE_VERSION = "v1";
const VDO_BASE = "https://vdo.ninja/";
const DEFAULT_ROOM_PREFIX = "BVMCOURT";
// VDO.Ninja room passwords must stay alphanumeric — no punctuation.
const DEFAULT_ROOM_PASSWORD = "bvm2026";
const DEFAULT_SCENE_BUFFER_MS = 2000;
const MAX_SCENE_BUFFER_MS = 4000;

/** Rooms 1..8 mirror the eight StreamRun program feeds. */
export const VDO_ROOM_COUNT = 8;

/**
 * RFC 3986 strict encoding: encodeURIComponent leaves ! ' ( ) * bare, but the
 * VDO.Ninja links we hand to StreamRun/commentators must carry the room
 * password with `!` as `%21`.
 */
function encodeStrict(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function vdoRoomPrefix(): string {
  return process.env.VDO_ROOM_PREFIX?.trim() || DEFAULT_ROOM_PREFIX;
}

export function vdoRoomPassword(): string {
  return process.env.VDO_ROOM_PASSWORD?.trim() || DEFAULT_ROOM_PASSWORD;
}

/**
 * Delay (ms) applied to commentary audio inside the StreamRun scene link so it
 * lines up with the delayed program video. Invalid values fall back to the
 * default; numeric values clamp into 0..4000.
 */
export function vdoSceneBufferMs(): number {
  const raw = process.env.VDO_SCENE_BUFFER_MS?.trim();
  if (!raw) return DEFAULT_SCENE_BUFFER_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_SCENE_BUFFER_MS;
  return Math.min(MAX_SCENE_BUFFER_MS, Math.max(0, Math.round(value)));
}

/** Room per stream/court, e.g. BVMCOURT3. */
export function vdoRoomName(streamNumber: number): string {
  return `${vdoRoomPrefix()}${streamNumber}`;
}

/** Commentator join link: mic only, suggested label, 80 kbps opus, noise gate. */
export function vdoGuestUrl(streamNumber: number): string {
  const room = encodeStrict(vdoRoomName(streamNumber));
  const password = encodeStrict(vdoRoomPassword());
  const label = encodeStrict(`Stream ${streamNumber} Commentator`);
  return `${VDO_BASE}?room=${room}&password=${password}&miconly&labelsuggestion=${label}&oab=80&noisegate`;
}

/** Guest link for flaky wifi: forces TURN relay routing for a steadier connection. */
export function vdoGuestRelayUrl(streamNumber: number): string {
  return `${vdoGuestUrl(streamNumber)}&relay`;
}

/** Producer/director console for a room, with quick switching across all rooms. */
export function vdoDirectorUrl(streamNumber: number): string {
  const room = encodeStrict(vdoRoomName(streamNumber));
  const password = encodeStrict(vdoRoomPassword());
  const rooms = Array.from({ length: VDO_ROOM_COUNT }, (_, index) => encodeStrict(vdoRoomName(index + 1))).join(",");
  return `${VDO_BASE}?director&room=${room}&password=${password}&previewmode&showconnections&notify&rooms=${rooms}`;
}

/**
 * Audio-only scene link for the StreamRun HTML overlay element. `buffer`
 * delays the commentary audio so it aligns with the delayed program video.
 */
export function vdoSceneUrl(streamNumber: number): string {
  const room = encodeStrict(vdoRoomName(streamNumber));
  const password = encodeStrict(vdoRoomPassword());
  return `${VDO_BASE}?scene&room=${room}&password=${password}&novideo&audiobitrate=80&buffer=${vdoSceneBufferMs()}&retry`;
}

/* ---------------------------------------------------------------------------
   Passcode gate + signed cookie (mirrors the admin cookie pattern, but a
   distinct cookie that never grants admin).
--------------------------------------------------------------------------- */

export function commentaryPasscode(): string {
  return process.env.COMMENTATOR_PASSCODE?.trim() ?? "";
}

/** Empty/unset COMMENTATOR_PASSCODE disables the portal entirely. */
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

/** HMAC-signed cookie value carrying its own expiry: `v1.<expiresAtMs>.<hmac>`. */
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
