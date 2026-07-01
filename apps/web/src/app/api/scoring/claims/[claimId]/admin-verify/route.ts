import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { adminVerifyClaim } from "@/lib/scorerSessions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ claimId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { claimId } = await params;
  const result = await adminVerifyClaim(claimId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
