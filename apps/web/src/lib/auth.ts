import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "./env";
import { checkRateLimit } from "./rateLimit";
import { requestIpHash } from "./security";

export const ADMIN_COOKIE = "mcs_admin";

async function digest(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function adminCookieValue(): Promise<string> {
  const env = getEnv();
  return digest(`multicourt-score:${env.adminSecret}`);
}

export async function isAdminRequest(req?: NextRequest): Promise<boolean> {
  const env = getEnv();
  if (!env.adminSecret) {
    return false;
  }
  const expected = await adminCookieValue();
  const actual = req
    ? req.cookies.get(ADMIN_COOKIE)?.value
    : (await cookies()).get(ADMIN_COOKIE)?.value;
  return actual === expected;
}

export async function requireAdmin(req: NextRequest): Promise<NextResponse | null> {
  if (await isAdminRequest(req)) {
    if (req.method !== "GET" && !checkRateLimit(`admin-mutate:${requestIpHash(req)}`, 180, 60_000)) {
      return NextResponse.json({ error: "Too many admin requests" }, { status: 429 });
    }
    return null;
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
