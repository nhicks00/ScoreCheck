import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { transitionCommunityMatch } from "@/lib/communityWitness";
import { refreshCourtOverlay } from "@/lib/scoreState";
import { normalizeVblBracketPayload } from "@/lib/scoring";
import { supabaseAdmin } from "@/lib/supabase";
import { buildActiveVblSourceSet, matchBelongsToActiveVblSource } from "@/lib/vblSources";

type QueueMatch = {
  id: string;
  source_type?: "vbl" | "manual" | null;
  api_url?: string | null;
  bracket_url?: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const body = await req.json().catch(() => ({}));
  const requestedActionId = z.string().uuid().safeParse(body.actionId);
  if (!requestedActionId.success) return NextResponse.json({ error: "actionId must be a UUID" }, { status: 400 });
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
  const { data: activeSources, error: sourceError } = await db
    .from("bracket_sources")
    .select("source_url")
    .eq("event_id", court.event_id);
  if (sourceError) return NextResponse.json({ error: sourceError.message }, { status: 500 });
  const activeSourceUrls = buildActiveVblSourceSet((activeSources ?? []).map((source) => source.source_url));

  const { data: nextRows, error: nextError } = await db
    .from("court_match_queue")
    .select("*, matches:match_id(*)")
    .eq("court_id", courtId)
    .gt("queue_position", basePosition)
    .eq("status", "queued")
    .order("queue_position", { ascending: true })
    .limit(50);
  if (nextError) return NextResponse.json({ error: nextError.message }, { status: 500 });
  const next = (nextRows ?? []).find((queue) => {
    const match = Array.isArray(queue.matches) ? queue.matches[0] : queue.matches;
    return matchBelongsToActiveVblSource(match, activeSourceUrls) && !isFinalQueueMatch(match);
  });
  if (!next) return NextResponse.json({ error: "No queued match is available" }, { status: 404 });

  const match = Array.isArray(next.matches) ? next.matches[0] : next.matches;
  if (!match) return NextResponse.json({ error: "Queued match details are unavailable" }, { status: 409 });
  const transition = await transitionCommunityMatch({
    eventId: court.event_id,
    courtId,
    fromMatchId: court.current_match_id,
    toMatchId: next.match_id,
    actionId: requestedActionId.data,
    actorType: "ADMIN",
    actorLabel: "Admin forced next match",
    initialAuthorityMode: match.source_type === "manual" || !match.api_url ? "PAUSED_DISPUTE" : "PROVIDER_PRIMARY"
  });
  if (transition.duplicate && transition.newMatchId !== next.match_id) {
    const projection = await refreshCourtOverlay(courtId);
    return NextResponse.json({ ok: true, duplicate: true, score: projection.score, overlay: projection.overlay });
  }

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
    .update({ status: "waiting", frozen: false, last_update_at: now, updated_at: now })
    .eq("id", courtId)
    .select("*")
    .single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

  const saved = await refreshCourtOverlay(updatedCourt.id);

  return NextResponse.json({ ok: true, duplicate: transition.duplicate, court: updatedCourt, match, score: saved.score, overlay: saved.overlay });
}

function isFinalQueueMatch(match: (QueueMatch & { source_payload?: unknown; format?: Record<string, unknown> | null }) | null) {
  if (!match) return false;
  return normalizeVblBracketPayload(match.source_payload, match)?.status.toLowerCase().includes("final") ?? false;
}
