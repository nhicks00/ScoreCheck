import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  const { data, error } = await supabaseAdmin()
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("event_id", eventId)
    .order("court_number", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ courts: data });
}
