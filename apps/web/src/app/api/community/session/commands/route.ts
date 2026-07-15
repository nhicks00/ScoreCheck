import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashToken, requestIpHash } from "@/lib/security";
import { submitCommunityCommand } from "@/lib/communityWitness";
import { communityApiError, communityMutationResponse, communityToken } from "@/lib/communityHttp";
import { submitCommandSchema } from "@/lib/communityWitnessSchemas";

export async function POST(req: NextRequest) {
  const token = communityToken(req);
  if (!token) return NextResponse.json({ error: "Community session not found" }, { status: 401 });
  if (!checkRateLimit(`community-command:${hashToken(token)}`, 180, 60_000)
    || !checkRateLimit(`community-command-ip:${requestIpHash(req)}`, 5_000, 60_000)) {
    return NextResponse.json({ error: "Too many score commands" }, { status: 429 });
  }
  try {
    const parsed = submitCommandSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid score command" }, { status: 400 });
    const result = await submitCommunityCommand({ sessionToken: token, ...parsed.data });
    return communityMutationResponse(result);
  } catch (error) {
    return communityApiError(error);
  }
}
