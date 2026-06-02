import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { defaultManualState } from "@/lib/manualScoring";
import { persistScoreAndOverlay } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

type QueueMatch = {
  id: string;
  source_type?: "vbl" | "manual" | null;
  api_url?: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const db = supabaseAdmin();
  const now = new Date().toISOString();

  const { data: court, error: courtError } = await db.from("courts").select("*").eq("id", courtId).single();
  if (courtError || !court) return NextResponse.json({ error: courtError?.message ?? "Court not found" }, { status: 404 });

  const { data: active } = await db
    .from("court_match_queue")
    .select("*")
    .eq("court_id", courtId)
    .eq("is_active", true)
    .maybeSingle();
  const basePosition = Number(active?.queue_position ?? 0);
  const { data: next, error: nextError } = await db
    .from("court_match_queue")
    .select("*, matches:match_id(*)")
    .eq("court_id", courtId)
    .gt("queue_position", basePosition)
    .order("queue_position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (nextError) return NextResponse.json({ error: nextError.message }, { status: 500 });
  if (!next) return NextResponse.json({ error: "No queued match is available" }, { status: 404 });

  if (active) {
    await db.from("court_match_queue").update({ is_active: false, status: "finished", updated_at: now }).eq("id", active.id);
  }
  const { error: queueError } = await db
    .from("court_match_queue")
    .update({ is_active: true, status: "active", updated_at: now })
    .eq("id", next.id);
  if (queueError) return NextResponse.json({ error: queueError.message }, { status: 500 });

  const { data: updatedCourt, error: updateError } = await db
    .from("courts")
    .update({ current_match_id: next.match_id, status: "waiting", frozen: false, last_update_at: now, updated_at: now })
    .eq("id", courtId)
    .select("*")
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  const match = Array.isArray(next.matches) ? next.matches[0] : next.matches;
  const state = defaultManualState();
  const saved = await persistScoreAndOverlay(updatedCourt, match ?? null, {
    court_id: updatedCourt.id,
    match_id: next.match_id,
    team_a_score: state.team_a_score,
    team_b_score: state.team_b_score,
    team_a_sets: state.team_a_sets,
    team_b_sets: state.team_b_sets,
    current_set: state.current_set,
    set_scores: state.set_scores,
    serving_team: null,
    timeouts: {},
    status: "Pre-Match",
    source: scoreSourceForMatch(match ?? null),
    stale: false,
    message: null
  });

  return NextResponse.json({ ok: true, court: updatedCourt, match, score: saved.score, overlay: saved.overlay });
}

function scoreSourceForMatch(match: QueueMatch | null) {
  if (!match) return "manual";
  return match.source_type === "manual" || !match.api_url ? "manual" : "api";
}
