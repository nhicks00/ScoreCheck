import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, adminCookieValue } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { readFormOrJson } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";

export async function POST(req: NextRequest) {
  const ipHash = requestIpHash(req);
  if (!checkRateLimit(`admin-login:${ipHash}`, 8, 60_000)) {
    return NextResponse.json({ error: "Too many login attempts" }, { status: 429 });
  }
  const body = await readFormOrJson(req);
  const env = getEnv();
  if (!env.adminSecret || body.secret !== env.adminSecret) {
    return NextResponse.json({ error: "Invalid admin secret" }, { status: 401 });
  }

  const next = body.next || "/admin/events";
  const res = NextResponse.redirect(new URL(next, req.url), { status: 303 });
  res.cookies.set(ADMIN_COOKIE, await adminCookieValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12
  });
  return res;
}
