import { NextRequest, NextResponse } from "next/server";
import { publicScorerState, validateScorerRequest } from "@/lib/manualScoreApi";

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const { courtId } = await params;
  const auth = await validateScorerRequest(req, courtId);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ ok: true, ...publicScorerState(auth.context) });
}
