import { vdoSceneUrl } from "./commentary";
import { constantTimeEqual } from "./security";

/**
 * Program page (/program/court/{n}) server-side config: the token gate shared
 * by the page and /api/program/heartbeat, plus the commentary scene link the
 * page embeds. The program page is the compositor scene a headless-Chrome
 * LiveKit egress captures and pushes to YouTube — see
 * docs/PRODUCTION_PLATFORM_PLAN.md §3.1.
 *
 * Client-safe runtime logic (watchdog, heartbeat payload) lives in
 * ./programWatchdog so this module can keep its node:crypto dependency.
 */

const MAX_COMMENTARY_BUFFER_MS = 4000;

export function programPageToken(): string {
  return process.env.PROGRAM_PAGE_TOKEN?.trim() ?? "";
}

/**
 * Gate for /program/court/{n} and /api/program/heartbeat. Unset/blank
 * PROGRAM_PAGE_TOKEN disables program pages entirely — every token (including
 * none) fails, and callers respond with a plain 404.
 */
export function checkProgramToken(input: string | null | undefined): boolean {
  const expected = programPageToken();
  if (!expected) return false;
  return constantTimeEqual((input ?? "").trim(), expected);
}

/**
 * ?cbuf= override for the commentary audio delay on program pages. The egress
 * path gets its own alignment, so absent/blank/invalid means "no &buffer
 * param at all" (null) — unlike the StreamRun scene link, which always
 * carries VDO_SCENE_BUFFER_MS. Numeric values clamp into 0..4000 whole ms.
 */
export function programCommentaryBufferMs(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return clampBufferMs(value);
}

/**
 * Audio-only VDO.Ninja scene link for the program page's hidden commentary
 * iframe. Derived from the exact StreamRun scene link (vdoSceneUrl) so room,
 * password, and audio flags can never drift — but with the `&buffer` param
 * stripped by default: the program/egress path aligns commentary itself via
 * ?cbuf= (or SRT pull latency upstream).
 */
export function programCommentarySceneUrl(streamNumber: number, bufferMs: number | null = null): string {
  const base = vdoSceneUrl(streamNumber).replace(/&buffer=\d+/, "");
  if (bufferMs == null) return base;
  return `${base}&buffer=${clampBufferMs(bufferMs)}`;
}

/** Same build-version pattern as the overlay pages and /api/overlay/version. */
export function programBuildVersion(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.RENDER_GIT_COMMIT
    ?? "local";
}

function clampBufferMs(value: number): number {
  return Math.min(MAX_COMMENTARY_BUFFER_MS, Math.max(0, Math.round(value)));
}
