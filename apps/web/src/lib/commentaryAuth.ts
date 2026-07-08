import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { COMMENTARY_COOKIE, verifyCommentaryCookie } from "./commentary";
import { getEnv } from "./env";

/**
 * Server-side gate for the commentator portal. Separate from lib/commentary
 * so that module stays pure (unit-testable without next/headers).
 */
export async function isCommentaryRequest(req?: NextRequest): Promise<boolean> {
  const env = getEnv();
  if (!env.adminSecret) return false;
  const value = req
    ? req.cookies.get(COMMENTARY_COOKIE)?.value
    : (await cookies()).get(COMMENTARY_COOKIE)?.value;
  return verifyCommentaryCookie(value, env.adminSecret);
}
