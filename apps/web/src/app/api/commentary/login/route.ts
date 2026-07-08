import { NextRequest, NextResponse } from "next/server";
import {
  checkCommentaryPasscode,
  commentaryPortalEnabled,
  COMMENTARY_COOKIE,
  COMMENTARY_SESSION_MS,
  signCommentaryCookie
} from "@/lib/commentary";
import { getEnv } from "@/lib/env";
import { readFormOrJson } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";

export async function POST(req: NextRequest) {
  const wantsJson = isJsonRequest(req);
  const ipHash = requestIpHash(req);
  if (!checkRateLimit(`commentary-login:${ipHash}`, 8, 60_000)) {
    if (!wantsJson) return redirectToLogin(req, "rate_limited");
    return NextResponse.json({ error: "Too many login attempts" }, { status: 429 });
  }
  const body = await readFormOrJson(req);
  const env = getEnv();

  // Unset/blank COMMENTATOR_PASSCODE (or no signing secret) = portal disabled.
  if (!commentaryPortalEnabled() || !env.adminSecret) {
    if (!wantsJson) return redirectToLogin(req, "disabled");
    return NextResponse.json(
      { error: "The commentator portal is not enabled. Ask the producer to set COMMENTATOR_PASSCODE." },
      { status: 503 }
    );
  }

  if (!checkCommentaryPasscode(body.passcode)) {
    if (!wantsJson) return redirectToLogin(req, "invalid");
    return NextResponse.json({ error: "Invalid passcode" }, { status: 401 });
  }

  const res = NextResponse.redirect(new URL("/commentary", req.url), { status: 303 });
  res.cookies.set(COMMENTARY_COOKIE, signCommentaryCookie(env.adminSecret, Date.now() + COMMENTARY_SESSION_MS), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COMMENTARY_SESSION_MS / 1000
  });
  return res;
}

function isJsonRequest(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return contentType.includes("application/json") || (accept.includes("application/json") && !accept.includes("text/html"));
}

function redirectToLogin(req: NextRequest, error: "invalid" | "rate_limited" | "disabled") {
  const url = new URL("/commentary", req.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, { status: 303 });
}
