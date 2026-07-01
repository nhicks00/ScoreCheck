import { NextRequest, NextResponse } from "next/server";
import { getClaimStatus } from "@/lib/scorerSessions";

export async function GET(req: NextRequest, { params }: { params: Promise<{ claimId: string }> }) {
  const { claimId } = await params;
  const result = await getClaimStatus({
    claimId,
    claimStatusToken: req.nextUrl.searchParams.get("claimStatusToken"),
    origin: new URL(req.url).origin
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
