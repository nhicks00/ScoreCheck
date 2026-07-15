import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashToken, requestIpHash } from "@/lib/security";
import { submitCommunityObservation } from "@/lib/communityWitness";
import { communityApiError, communityMutationResponse, communityToken } from "@/lib/communityHttp";
import { submitObservationSchema } from "@/lib/communityWitnessSchemas";

export async function POST(req: NextRequest) {
  const token = communityToken(req);
  if (!token) return NextResponse.json({ error: "Community session not found" }, { status: 401 });
  if (!checkRateLimit(`community-observation:${hashToken(token)}`, 180, 60_000)
    || !checkRateLimit(`community-observation-ip:${requestIpHash(req)}`, 5_000, 60_000)) {
    return NextResponse.json({ error: "Too many observations" }, { status: 429 });
  }
  try {
    const parsed = submitObservationSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid rally observation" }, { status: 400 });
    const result = await submitCommunityObservation({ sessionToken: token, ...parsed.data });
    return communityMutationResponse(result);
  } catch (error) {
    return communityApiError(error);
  }
}
