import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { transitionCommunityMatch } from "@/lib/communityWitness";
import { readFormOrJson } from "@/lib/http";
import { refreshCourtOverlay } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

type AssignableMatch = {
  id: string;
  event_id: string;
  source_type?: "vbl" | "manual" | null;
  api_url?: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const body = await readFormOrJson(req);
  const matchId = body.matchId || null;
  const now = new Date().toISOString();
  const db = supabaseAdmin();
  let selectedMatch: AssignableMatch | null = null;
  const { data: existingCourt, error: courtLoadError } = await db
    .from("courts")
    .select("*")
    .eq("id", courtId)
    .single();
  if (courtLoadError) return NextResponse.json({ error: courtLoadError.message }, { status: 500 });

  if (matchId) {
    const { data: match, error: matchError } = await db
      .from("matches")
      .select("id,event_id,source_type,api_url")
      .eq("id", matchId)
      .eq("event_id", existingCourt.event_id)
      .single();
    if (matchError || !match) return NextResponse.json({ error: matchError?.message ?? "Match not found for this event" }, { status: 404 });
    selectedMatch = match;

  }

  const requestedActionId = z.string().uuid().safeParse(body.actionId);
  if (!requestedActionId.success) return NextResponse.json({ error: "actionId must be a UUID" }, { status: 400 });
  const transition = await transitionCommunityMatch({
    eventId: existingCourt.event_id,
    courtId,
    fromMatchId: existingCourt.current_match_id,
    toMatchId: matchId,
    actionId: requestedActionId.data,
    actorType: "ADMIN",
    actorLabel: "Admin court assignment",
    initialAuthorityMode: selectedMatch && selectedMatch.source_type !== "manual" && selectedMatch.api_url
      ? "PROVIDER_PRIMARY"
      : "PAUSED_DISPUTE"
  });
  if (transition.duplicate && transition.newMatchId !== matchId) {
    const projection = await refreshCourtOverlay(courtId);
    return NextResponse.json({ ok: true, duplicate: true, eventId: existingCourt.event_id, score: projection.score, overlay: projection.overlay });
  }

  await db.from("court_match_queue").update({ is_active: false, status: "queued", updated_at: now }).eq("court_id", courtId).eq("is_active", true);

  if (matchId) {

    const { data: existingQueue } = await db
      .from("court_match_queue")
      .select("*")
      .eq("court_id", courtId)
      .eq("match_id", matchId)
      .maybeSingle();
    if (existingQueue) {
      const { error: queueError } = await db
        .from("court_match_queue")
        .update({ is_active: true, status: "active", updated_at: now })
        .eq("id", existingQueue.id);
      if (queueError) return NextResponse.json({ error: queueError.message }, { status: 500 });
    } else {
      const { data: lastQueue } = await db
        .from("court_match_queue")
        .select("queue_position")
        .eq("court_id", courtId)
        .order("queue_position", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { error: queueError } = await db.from("court_match_queue").insert({
        event_id: existingCourt.event_id,
        court_id: courtId,
        match_id: matchId,
        queue_position: Number(lastQueue?.queue_position ?? 0) + 1,
        is_active: true,
        status: "active",
        updated_at: now
      });
      if (queueError) return NextResponse.json({ error: queueError.message }, { status: 500 });
    }
  }

  const { data: court, error } = await db
    .from("courts")
    .update({
      status: matchId ? "waiting" : "idle",
      mode: matchId ? modeForAssignedMatch(selectedMatch, existingCourt.mode) : "hybrid",
      last_update_at: now,
      updated_at: now
    })
    .eq("id", courtId)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const projection = await refreshCourtOverlay(court.id);
  return NextResponse.json({ ok: true, duplicate: transition.duplicate, eventId: court.event_id, score: projection.score, overlay: projection.overlay });
}

function modeForAssignedMatch(match: AssignableMatch | null, currentMode: "api" | "manual" | "hybrid") {
  if (match?.source_type === "manual" || !match?.api_url) return "manual";
  return currentMode === "manual" ? "hybrid" : currentMode;
}
