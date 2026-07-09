import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { getEnv } from "./env";
import { constantTimeEqual } from "./security";

/**
 * Standalone passcode gate for the live-chat monitor (/chat). Mirrors the
 * commentator-portal gate: a signed httpOnly cookie HMAC'd with ADMIN_SECRET,
 * but a DISTINCT cookie name and signature namespace so it never grants admin
 * and a commentary cookie can't be replayed here. Commentators and on-site
 * emcees reach /chat with just this passcode — no admin cookie required.
 */

export const CHAT_COOKIE = "scorecheck_chat";
export const CHAT_SESSION_MS = 24 * 60 * 60 * 1000;
const COOKIE_VERSION = "v1";

/** The passcode from env (trimmed). Blank/unset disables the feature. */
export function chatMonitorPasscode(): string {
  return process.env.CHAT_MONITOR_PASSCODE?.trim() ?? "";
}

/** Empty/unset CHAT_MONITOR_PASSCODE disables /chat entirely. */
export function chatMonitorEnabled(): boolean {
  return chatMonitorPasscode().length > 0;
}

export function checkChatPasscode(input: string | null | undefined): boolean {
  const expected = chatMonitorPasscode();
  if (!expected) return false;
  return constantTimeEqual((input ?? "").trim(), expected);
}

function chatSignature(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(`scorecheck-chat:${payload}`).digest("hex");
}

/** HMAC-signed cookie value carrying its own expiry: `v1.<expiresAtMs>.<hmac>`. */
export function signChatCookie(secret: string, expiresAtMs: number): string {
  const payload = `${COOKIE_VERSION}.${expiresAtMs}`;
  return `${payload}.${chatSignature(secret, payload)}`;
}

export function verifyChatCookie(value: string | null | undefined, secret: string, nowMs = Date.now()): boolean {
  if (!value || !secret) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return false;
  const expiresAtMs = Number(parts[1]);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;
  return constantTimeEqual(parts[2], chatSignature(secret, `${parts[0]}.${parts[1]}`));
}

/** Server-side gate for /chat and its API. */
export async function isChatRequest(req?: NextRequest): Promise<boolean> {
  const env = getEnv();
  if (!env.adminSecret) return false;
  const value = req
    ? req.cookies.get(CHAT_COOKIE)?.value
    : (await cookies()).get(CHAT_COOKIE)?.value;
  return verifyChatCookie(value, env.adminSecret);
}
