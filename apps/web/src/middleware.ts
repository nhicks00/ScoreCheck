import { NextRequest, NextResponse } from "next/server";

const ADMIN_COOKIE = "mcs_admin";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/program")) {
    return programResponse(req);
  }

  if (pathname === "/api/program/session") return noStoreResponse(req);
  if (!pathname.startsWith("/admin") || pathname === "/admin/login") return NextResponse.next();
  if (req.cookies.get(ADMIN_COOKIE)?.value) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/admin/:path*", "/program/:path*", "/api/program/:path*"]
};

function programResponse(req: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", programContentSecurityPolicy(nonce));
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  if (deploymentId?.startsWith("dpl_")) {
    response.cookies.set("__vdpl", deploymentId, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/"
    });
  }
  return response;
}

function noStoreResponse(req: NextRequest) {
  const response = NextResponse.next({ request: { headers: new Headers(req.headers) } });
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function programContentSecurityPolicy(nonce: string): string {
  const connect = new Set(["'self'"]);
  for (const value of [
    process.env.MEDIAMTX_WHEP_BASE_URL,
    process.env.NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL,
    process.env.MONITOR_PUBLIC_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL
  ]) addOrigin(connect, value);
  const supabase = safeUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (supabase?.protocol === "https:") connect.add(`wss://${supabase.host}`);
  const script = [`'nonce-${nonce}'`, "'strict-dynamic'", ...(process.env.NODE_ENV === "production" ? [] : ["'unsafe-eval'"])];
  return [
    "default-src 'none'",
    `script-src ${script.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");
}

function addOrigin(values: Set<string>, input: string | undefined) {
  const parsed = safeUrl(input);
  if (parsed && ["https:", "wss:", "http:", "ws:"].includes(parsed.protocol)) values.add(parsed.origin);
}

function safeUrl(input: string | undefined): URL | null {
  try {
    return input ? new URL(input) : null;
  } catch {
    return null;
  }
}
