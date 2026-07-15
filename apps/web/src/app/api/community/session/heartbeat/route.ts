import { NextRequest, NextResponse } from "next/server";
import {
  communitySessionCookie,
  communitySessionCookieOptions,
  heartbeatCommunitySession
} from "@/lib/communityWitness";
import { communityApiError, communityToken } from "@/lib/communityHttp";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashToken, requestIpHash } from "@/lib/security";
import { touchCommunityMediaSessions } from "@/lib/communityMedia";

export async function POST(req: NextRequest) {
  const token = communityToken(req);
  if (!token) return NextResponse.json({ error: "Community session not found" }, { status: 401 });
  if (!checkRateLimit(`community-heartbeat:${hashToken(token)}`, 30, 60_000)
    // Venue Wi-Fi can place hundreds of legitimate witnesses behind one NAT.
    // The per-session ceiling is the primary guard; this is only a broad flood
    // backstop and must not reject a healthy event crowd.
    || !checkRateLimit(`community-heartbeat-ip:${requestIpHash(req)}`, 20_000, 60_000)) {
    return NextResponse.json({ error: "Too many heartbeat requests" }, { status: 429 });
  }
  try {
    const snapshot = await heartbeatCommunitySession(token);
    await touchCommunityMediaSessions(token).catch((error) => {
      console.error("Community media lease touch failed", {
        code: error instanceof Error ? error.name : "UNEXPECTED"
      });
    });
    const response = NextResponse.json(snapshot);
    response.cookies.set(communitySessionCookie, token, communitySessionCookieOptions);
    return response;
  } catch (error) {
    return communityApiError(error);
  }
}
