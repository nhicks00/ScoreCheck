import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { generateScorerToken, hashSecret } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const token = generateScorerToken();
  const now = new Date().toISOString();
  const { data: court, error } = await supabaseAdmin()
    .from("courts")
    .update({
      scorer_token_hash: hashSecret(token),
      scorer_token_created_at: now,
      scorer_token_rotated_at: now,
      scorer_token_revoked_at: null,
      mode: "manual",
      updated_at: now
    })
    .eq("id", courtId)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const origin = (getEnv().publicSiteUrl || new URL(req.url).origin).replace(/\/$/, "");
  return NextResponse.json({
    ok: true,
    token,
    court,
    scorerUrl: `${origin}/score/court/${court.id}?token=${encodeURIComponent(token)}`
  });
}
