import { NextRequest, NextResponse } from "next/server";

const ADMIN_COOKIE = "mcs_admin";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (!pathname.startsWith("/admin") || pathname === "/admin/login") {
    return NextResponse.next();
  }

  if (req.cookies.get(ADMIN_COOKIE)?.value) {
    return NextResponse.next();
  }

  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/admin/:path*"]
};
