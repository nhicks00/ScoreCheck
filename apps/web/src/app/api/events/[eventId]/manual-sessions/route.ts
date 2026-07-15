import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { transitionCommunityMatch } from "@/lib/communityWitness";
import { publicOrigin } from "@/lib/env";
import { manualSessionFormat } from "@/lib/manualSessionFormat";
import { refreshCourtOverlay, trustedScoreActionId } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

const manualSessionSchema = z.object({
  actionId: z.string().uuid(),
  courtNumber: z.coerce.number().int().min(1).max(99),
  displayName: z.string().max(80).optional(),
  teamA: z.string().max(120).optional(),
  teamB: z.string().max(120).optional(),
  bestOf: z.coerce.number().int().min(1).max(5).optional(),
  pointsSet1: z.coerce.number().int().min(1).max(99).optional(),
  pointsSet2: z.coerce.number().int().min(1).max(99).optional(),
  pointsSet3: z.coerce.number().int().min(1).max(99).optional(),
  cap: z.string().optional()
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = manualSessionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid manual session payload" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: event, error: eventError } = await db.from("events").select("*").eq("id", eventId).single();
  if (eventError || !event) return NextResponse.json({ error: eventError?.message ?? "Event not found" }, { status: 404 });

  const now = new Date().toISOString();
  const format = manualSessionFormat(parsed.data);
  const courtNumberText = String(parsed.data.courtNumber);
  const displayName = cleanText(parsed.data.displayName) ?? `Court ${parsed.data.courtNumber}`;
  const teamA = cleanText(parsed.data.teamA) ?? "Team A";
  const teamB = cleanText(parsed.data.teamB) ?? "Team B";

  const { data: existingCourt } = await db
    .from("courts")
    .select("*")
    .eq("event_id", eventId)
    .eq("court_number", parsed.data.courtNumber)
    .maybeSingle();

  const courtPayload = {
    event_id: eventId,
    court_number: parsed.data.courtNumber,
    display_name: displayName,
    mode: "manual",
    status: "waiting",
    frozen: false,
    updated_at: now
  };

  const courtResult = existingCourt
    ? await db.from("courts").update(courtPayload).eq("id", existingCourt.id).select("*").single()
    : await db.from("courts").insert(courtPayload).select("*").single();
  if (courtResult.error) return NextResponse.json({ error: courtResult.error.message }, { status: 500 });
  const court = courtResult.data;

  const { data: match, error: matchError } = await db.from("matches").upsert({
    event_id: eventId,
    external_match_id: `manual-${parsed.data.actionId}`,
    source_type: "manual",
    api_url: null,
    bracket_url: null,
    match_number: `Manual ${parsed.data.courtNumber}`,
    round_name: "Manual Session",
    court_number: courtNumberText,
    physical_court: displayName,
    team_a: teamA,
    team_b: teamB,
    team_a_players: [],
    team_b_players: [],
    format,
    status: "scheduled",
    source_payload: { createdBy: "admin", createdAt: now, actionId: parsed.data.actionId },
    updated_at: now
  }, { onConflict: "event_id,external_match_id" }).select("*").single();
  if (matchError) return NextResponse.json({ error: matchError.message }, { status: 500 });

  const transition = await transitionCommunityMatch({
    eventId,
    courtId: court.id,
    fromMatchId: court.current_match_id ?? null,
    toMatchId: match.id,
    actionId: trustedScoreActionId({ type: "manual-session-transition", actionId: parsed.data.actionId, courtId: court.id, matchId: match.id }),
    actorType: "ADMIN",
    actorLabel: "Admin created manual session",
    initialAuthorityMode: "PAUSED_DISPUTE"
  });
  if (transition.duplicate && transition.newMatchId !== match.id) {
    const projection = await refreshCourtOverlay(court.id);
    const origin = publicOrigin(new URL(req.url).origin);
    return NextResponse.json({
      ok: true,
      duplicate: true,
      event,
      court,
      match: transition.match,
      score: projection.score,
      overlay: projection.overlay,
      scoreUrl: `${origin}/score/court/${court.id}`,
      overlayUrl: `${origin}/overlay/stream/${parsed.data.courtNumber}`,
      eventOverlayUrl: `${origin}/overlay/court/${parsed.data.courtNumber}?eventId=${eventId}`
    });
  }

  await db.from("court_match_queue").update({ is_active: false, status: "queued", updated_at: now }).eq("court_id", court.id).eq("is_active", true);
  const { data: existingQueue } = await db
    .from("court_match_queue")
    .select("id")
    .eq("court_id", court.id)
    .eq("match_id", match.id)
    .maybeSingle();
  let queueError: { message: string } | null = null;
  if (existingQueue) {
    ({ error: queueError } = await db.from("court_match_queue")
      .update({ is_active: true, status: "active", updated_at: now })
      .eq("id", existingQueue.id));
  } else {
    const { data: lastQueue } = await db
      .from("court_match_queue")
      .select("queue_position")
      .eq("court_id", court.id)
      .order("queue_position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const queuePosition = Number(lastQueue?.queue_position ?? 0) + 1;
    ({ error: queueError } = await db.from("court_match_queue").insert({
      event_id: eventId,
      court_id: court.id,
      match_id: match.id,
      queue_position: queuePosition,
      is_active: true,
      status: "active",
      updated_at: now
    }));
  }
  if (queueError) return NextResponse.json({ error: queueError.message }, { status: 500 });

  const { data: updatedCourt, error: courtUpdateError } = await db.from("courts")
    .update({ status: "waiting", last_update_at: now, updated_at: now })
    .eq("id", court.id)
    .select("*")
    .single();
  if (courtUpdateError) return NextResponse.json({ error: courtUpdateError.message }, { status: 500 });
  const saved = await refreshCourtOverlay(court.id);

  const origin = publicOrigin(new URL(req.url).origin);
  return NextResponse.json({
    ok: true,
    duplicate: transition.duplicate,
    event,
    court: updatedCourt,
    match,
    score: saved.score,
    overlay: saved.overlay,
    scoreUrl: `${origin}/score/court/${court.id}`,
    overlayUrl: `${origin}/overlay/stream/${parsed.data.courtNumber}`,
    eventOverlayUrl: `${origin}/overlay/court/${parsed.data.courtNumber}?eventId=${eventId}`
  });
}

function cleanText(value: string | undefined) {
  const text = value?.trim();
  return text?.length ? text : null;
}
