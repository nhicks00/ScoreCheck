import { NextRequest, NextResponse } from "next/server";
import {
  issueProgramSession,
  PROGRAM_SESSION_COOKIE,
  programCourtPath,
  programRendererBinding,
  programSessionCookieOptions
} from "@/lib/program";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!checkRateLimit(`program-session:${requestIpHash(req)}`, 20, 60_000)) return notFound();
  const body = await req.json().catch(() => null);
  const court = Number(body?.court);
  const binding = programRendererBinding();
  const session = issueProgramSession({
    token: typeof body?.token === "string" ? body.token : null,
    court,
    expectedBuild: typeof body?.build === "string" ? body.build : null,
    expectedDeployment: typeof body?.deployment === "string" ? body.deployment : null
  });
  if (!session || !binding) return notFound();

  const options = {
    cbuf: typeof body?.cbuf === "string" ? body.cbuf : null,
    scene: typeof body?.scene === "string" ? body.scene : null,
    debug: typeof body?.debug === "string" ? body.debug : null
  };
  const response = NextResponse.json(
    { next: programCourtPath(court, binding, options) },
    { headers: { "cache-control": "private, no-store" } }
  );
  response.cookies.set(PROGRAM_SESSION_COOKIE, session, programSessionCookieOptions);
  return response;
}

function notFound() {
  return new NextResponse(null, {
    status: 404,
    headers: { "cache-control": "private, no-store" }
  });
}
