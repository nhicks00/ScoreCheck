import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin()
    .from("courts")
    .update({
      scorer_token_hash: null,
      scorer_token_revoked_at: now,
      updated_at: now
    })
    .eq("id", courtId)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, court: data });
}
