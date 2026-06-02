import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { buildOverlayState } from "@/lib/overlay";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const { data: court, error } = await supabaseAdmin()
    .from("courts")
    .select("*, events!inner(id), matches:current_match_id(*), score_states(*)")
    .eq("id", courtId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!court) return NextResponse.json({ error: "Court not found" }, { status: 404 });
  const match = Array.isArray(court.matches) ? court.matches[0] : court.matches;
  const score = Array.isArray(court.score_states) ? court.score_states[0] : court.score_states;
  return NextResponse.json(buildOverlayState({
    event: { id: court.event_id },
    court,
    match: match ?? null,
    score: score ?? null
  }));
}
