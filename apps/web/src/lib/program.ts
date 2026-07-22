import { createHmac } from "node:crypto";
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

const MAX_COMMENTARY_BUFFER_MS = 10000;
const PROGRAM_SESSION_VERSION = 1;
const PROGRAM_SESSION_SECONDS = 18 * 60 * 60;
const GIT_SHA = /^[a-f0-9]{40}$/;
const VERCEL_DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;

export const PROGRAM_SESSION_COOKIE = "scorecheck_program_session";
export const programSessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/program",
  maxAge: PROGRAM_SESSION_SECONDS
};

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

export type ProgramRendererBinding = {
  build: string;
  deployment: string;
};

export const PROGRAM_RENDERER_CONTRACTS = Object.freeze({
  programSession: "program-session-v1",
  overlayState: "overlay-state-v1",
  commentary: "commentary-v1",
  browserHeartbeat: "browser-heartbeat-v5"
});

/** The immutable renderer identity exposed by Vercel (or an explicit local host). */
export function programRendererBinding(): ProgramRendererBinding | null {
  const build = programBuildVersion().trim();
  const deployment = (process.env.VERCEL_DEPLOYMENT_ID
    ?? process.env.RENDER_DEPLOYMENT_ID
    ?? (process.env.NODE_ENV === "production" ? "" : "local")).trim();
  if (!validRendererBuild(build) || !validRendererDeployment(deployment)) return null;
  return { build, deployment };
}

export function programRendererOrigin(): string | null {
  const candidate = (process.env.VERCEL_URL ?? process.env.NEXT_PUBLIC_VERCEL_URL ?? "").trim();
  if (!candidate) return process.env.NODE_ENV === "production" ? null : "http://localhost:3000";
  try {
    const parsed = new URL(candidate.startsWith("https://") ? candidate : `https://${candidate}`);
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel.app") || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Exchanges the event-scoped bootstrap token for a signed browser session.
 * The raw token is supplied in a URL fragment and therefore never reaches
 * Vercel request URLs, logs, browser history, or Referrer headers.
 */
export function issueProgramSession(input: {
  token: string | null | undefined;
  court: number;
  expectedBuild: string | null | undefined;
  expectedDeployment: string | null | undefined;
  nowMs?: number;
}): string | null {
  if (!checkProgramToken(input.token) || !validProgramCourt(input.court)) return null;
  const binding = programRendererBinding();
  if (!binding
    || !constantTimeEqual(input.expectedBuild?.trim(), binding.build)
    || !constantTimeEqual(input.expectedDeployment?.trim(), binding.deployment)) return null;
  const nowMs = input.nowMs ?? Date.now();
  const payload = Buffer.from(JSON.stringify({
    v: PROGRAM_SESSION_VERSION,
    c: input.court,
    b: binding.build,
    d: binding.deployment,
    exp: Math.floor(nowMs / 1000) + PROGRAM_SESSION_SECONDS
  })).toString("base64url");
  return `${payload}.${signProgramSession(payload)}`;
}

export function verifyProgramSession(input: {
  session: string | null | undefined;
  court: number;
  expectedBuild: string | null | undefined;
  expectedDeployment: string | null | undefined;
  nowMs?: number;
}): boolean {
  if (!input.session || !validProgramCourt(input.court)) return false;
  const [payload, signature, extra] = input.session.split(".");
  if (!payload || !signature || extra || !constantTimeEqual(signature, signProgramSession(payload))) return false;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  const binding = programRendererBinding();
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  return Boolean(binding
    && session.v === PROGRAM_SESSION_VERSION
    && session.c === input.court
    && session.b === binding.build
    && session.d === binding.deployment
    && constantTimeEqual(input.expectedBuild?.trim(), binding.build)
    && constantTimeEqual(input.expectedDeployment?.trim(), binding.deployment)
    && Number.isInteger(session.exp)
    && Number(session.exp) > nowSeconds
    && Number(session.exp) <= nowSeconds + PROGRAM_SESSION_SECONDS);
}

export function programCourtPath(court: number, binding: ProgramRendererBinding, options: {
  cbuf?: string | null;
  scene?: string | null;
  debug?: string | null;
} = {}): string {
  if (!validProgramCourt(court) || !validRendererBuild(binding.build) || !validRendererDeployment(binding.deployment)) {
    throw new Error("Program renderer binding is invalid");
  }
  const query = new URLSearchParams({ build: binding.build, deployment: binding.deployment });
  for (const [key, value] of Object.entries(options)) {
    const trimmed = value?.trim();
    if (trimmed) query.set(key, trimmed);
  }
  return `/program/court/${court}?${query.toString()}`;
}

export function programBootstrapPath(court: number, token: string, binding: ProgramRendererBinding, options: {
  cbuf?: string | null;
  scene?: string | null;
  debug?: string | null;
} = {}): string {
  const courtPath = programCourtPath(court, binding, options);
  const query = courtPath.slice(courtPath.indexOf("?") + 1);
  return `/program/bootstrap?court=${court}&${query}#token=${encodeURIComponent(token)}`;
}

/**
 * ?cbuf= override for the Web Audio commentary DelayNode on program pages.
 * Absent/blank/invalid means use the court's persisted commentary_delay_ms.
 */
export function programCommentaryBufferMs(raw: string | null | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return clampBufferMs(value);
}

/** Same build-version pattern as the overlay pages and /api/overlay/version. */
export function programBuildVersion(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.RENDER_GIT_COMMIT
    ?? "local";
}

function signProgramSession(payload: string): string {
  const secret = programPageToken();
  if (!secret) return "";
  return createHmac("sha256", `scorecheck:program-session:v1:${secret}`).update(payload).digest("base64url");
}

function validProgramCourt(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 8;
}

function validRendererBuild(value: string): boolean {
  return GIT_SHA.test(value) || (process.env.NODE_ENV !== "production" && value === "local");
}

function validRendererDeployment(value: string): boolean {
  return VERCEL_DEPLOYMENT_ID.test(value) || (process.env.NODE_ENV !== "production" && value === "local");
}

function clampBufferMs(value: number): number {
  return Math.min(MAX_COMMENTARY_BUFFER_MS, Math.max(0, Math.round(value)));
}
