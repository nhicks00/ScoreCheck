import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, adminCookieValue } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { readFormOrJson } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";

export async function POST(req: NextRequest) {
  const wantsJson = isJsonRequest(req);
  const ipHash = requestIpHash(req);
  if (!checkRateLimit(`admin-login:${ipHash}`, 8, 60_000)) {
    if (!wantsJson) return redirectToLogin(req, "/admin/events", "rate_limited");
    return NextResponse.json({ error: "Too many login attempts" }, { status: 429 });
  }
  const body = await readFormOrJson(req);
  const env = getEnv();
  const next = safeNextPath(body.next);

  if (!env.adminSecret || body.secret !== env.adminSecret) {
    if (!wantsJson) return redirectToLogin(req, next, "invalid");
    return NextResponse.json({ error: "Invalid admin secret" }, { status: 401 });
  }

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

function isJsonRequest(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return contentType.includes("application/json") || (accept.includes("application/json") && !accept.includes("text/html"));
}

function safeNextPath(next: string | undefined) {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/admin/events";
}

function redirectToLogin(req: NextRequest, next: string, error: "invalid" | "rate_limited") {
  const url = new URL("/admin/login", req.url);
  url.searchParams.set("next", next);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, { status: 303 });
}
