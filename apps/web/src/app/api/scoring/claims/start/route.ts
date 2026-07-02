import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { startClaim } from "@/lib/scorerSessions";

const schema = z.object({
  eventSlug: z.string().min(1).default(getEnv().defaultEventSlug),
  courtNumber: z.coerce.number().int().min(1).max(8),
  displayName: z.string().min(1).max(80),
  watchMode: z.enum(["website", "courtside"]).default("courtside")
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Enter a display name and court." }, { status: 400 });
    const result = await startClaim({ req, ...parsed.data });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      claimId: result.claim.id,
      claimStatusToken: result.claimStatusToken,
      verificationCode: result.claim.verification_code_label,
      expiresAt: result.claim.expires_at,
      message: result.message
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not start scoring" }, { status: 500 });
  }
}
