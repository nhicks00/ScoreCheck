import { NextRequest, NextResponse } from "next/server";
import { getCommunitySession } from "@/lib/communityWitness";
import { communityApiError, communityToken } from "@/lib/communityHttp";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashToken, requestIpHash } from "@/lib/security";

export async function GET(req: NextRequest) {
  const token = communityToken(req);
  if (!token) return NextResponse.json({ error: "Community session not found" }, { status: 401 });
  if (!checkRateLimit(`community-session:${hashToken(token)}`, 120, 60_000)
    || !checkRateLimit(`community-session-ip:${requestIpHash(req)}`, 5_000, 60_000)) {
    return NextResponse.json({ error: "Too many session requests" }, { status: 429 });
  }
  try {
    return NextResponse.json(await getCommunitySession(token));
  } catch (error) {
    return communityApiError(error);
  }
}
