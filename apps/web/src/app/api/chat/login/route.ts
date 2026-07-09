import { NextRequest, NextResponse } from "next/server";
import {
  CHAT_COOKIE,
  CHAT_SESSION_MS,
  chatMonitorEnabled,
  checkChatPasscode,
  signChatCookie
} from "@/lib/chatAuth";
import { getEnv } from "@/lib/env";
import { readFormOrJson } from "@/lib/http";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const wantsJson = isJsonRequest(req);
  const ipHash = requestIpHash(req);
  if (!checkRateLimit(`chat-login:${ipHash}`, 8, 60_000)) {
    if (!wantsJson) return redirectToLogin(req, "rate_limited");
    return NextResponse.json({ error: "Too many login attempts" }, { status: 429 });
  }
  const body = await readFormOrJson(req);
  const env = getEnv();

  // Unset/blank CHAT_MONITOR_PASSCODE (or no signing secret) = feature disabled.
  if (!chatMonitorEnabled() || !env.adminSecret) {
    if (!wantsJson) return redirectToLogin(req, "disabled");
    return NextResponse.json(
      { error: "The chat monitor is not enabled. Ask the producer to set CHAT_MONITOR_PASSCODE." },
      { status: 503 }
    );
  }

  if (!checkChatPasscode(body.passcode)) {
    if (!wantsJson) return redirectToLogin(req, "invalid");
    return NextResponse.json({ error: "Invalid passcode" }, { status: 401 });
  }

  const res = NextResponse.redirect(new URL("/chat", req.url), { status: 303 });
  res.cookies.set(CHAT_COOKIE, signChatCookie(env.adminSecret, Date.now() + CHAT_SESSION_MS), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: CHAT_SESSION_MS / 1000
  });
  return res;
}

function isJsonRequest(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept") ?? "";
  return contentType.includes("application/json") || (accept.includes("application/json") && !accept.includes("text/html"));
}

function redirectToLogin(req: NextRequest, error: "invalid" | "rate_limited" | "disabled") {
  const url = new URL("/chat", req.url);
  url.searchParams.set("error", error);
  return NextResponse.redirect(url, { status: 303 });
}
