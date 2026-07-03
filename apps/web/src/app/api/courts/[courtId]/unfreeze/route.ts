import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { buildOverlayStateWithEventSettings } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const { data: court, error } = await db
    .from("courts")
    .update({ frozen: false, updated_at: now })
    .eq("id", courtId)
    .select("*, matches:current_match_id(*), score_states(*)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const match = Array.isArray(court.matches) ? court.matches[0] : court.matches;
  const score = Array.isArray(court.score_states) ? court.score_states[0] : court.score_states;
  const overlay = await buildOverlayStateWithEventSettings(court, match ?? null, score ?? null);
  await db.from("overlay_states").upsert({
    court_id: court.id,
    event_id: court.event_id,
    court_number: court.court_number,
    payload: overlay,
    stale: score?.stale ?? false,
    updated_at: now
  });
  return NextResponse.json({ ok: true });
}
