import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashToken, requestIpHash } from "@/lib/security";
import { isCommunityCommandRecorded } from "@/lib/communityWitness";
import { communityApiError, communityToken } from "@/lib/communityHttp";
import { commandStatusSchema } from "@/lib/communityWitnessSchemas";

export async function POST(req: NextRequest) {
  const token = communityToken(req);
  if (!token) return NextResponse.json({ error: "Community session not found" }, { status: 401 });
  if (!checkRateLimit(`community-command-status:${hashToken(token)}`, 60, 60_000)
    || !checkRateLimit(`community-command-status-ip:${requestIpHash(req)}`, 2_000, 60_000)) {
    return NextResponse.json({ error: "Too many receipt checks" }, { status: 429 });
  }
  try {
    const parsed = commandStatusSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid score receipt check" }, { status: 400 });
    const recorded = await isCommunityCommandRecorded({
      sessionToken: token,
      clientActionId: parsed.data.clientActionId
    });
    return NextResponse.json({ ok: true, recorded });
  } catch (error) {
    return communityApiError(error);
  }
}
