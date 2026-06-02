import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { defaultManualState } from "@/lib/manualScoring";
import { persistScoreAndOverlay } from "@/lib/scoreState";
import { generateScorerToken, hashSecret } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase";

const defaultFormat = {
  bestOf: 3,
  pointsPerSet: [21, 21, 15],
  winByTwo: true,
  cap: null,
  setsToWin: 2
};

const manualSessionSchema = z.object({
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
  const token = generateScorerToken();
  const format = formatFromBody(parsed.data);
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
    scorer_token_hash: hashSecret(token),
    scorer_token_created_at: existingCourt?.scorer_token_created_at ?? now,
    scorer_token_rotated_at: now,
    scorer_token_revoked_at: null,
    updated_at: now
  };

  const courtResult = existingCourt
    ? await db.from("courts").update(courtPayload).eq("id", existingCourt.id).select("*").single()
    : await db.from("courts").insert(courtPayload).select("*").single();
  if (courtResult.error) return NextResponse.json({ error: courtResult.error.message }, { status: 500 });
  const court = courtResult.data;

  const { data: match, error: matchError } = await db.from("matches").insert({
    event_id: eventId,
    external_match_id: `manual-${crypto.randomUUID()}`,
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
    source_payload: { createdBy: "admin", createdAt: now },
    updated_at: now
  }).select("*").single();
  if (matchError) return NextResponse.json({ error: matchError.message }, { status: 500 });

  const { error: currentError } = await db
    .from("courts")
    .update({ current_match_id: match.id, status: "waiting", last_update_at: now, updated_at: now })
    .eq("id", court.id);
  if (currentError) return NextResponse.json({ error: currentError.message }, { status: 500 });

  await db.from("court_match_queue").update({ is_active: false, status: "queued", updated_at: now }).eq("court_id", court.id).eq("is_active", true);
  const { data: lastQueue } = await db
    .from("court_match_queue")
    .select("queue_position")
    .eq("court_id", court.id)
    .order("queue_position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const queuePosition = Number(lastQueue?.queue_position ?? 0) + 1;
  const { error: queueError } = await db.from("court_match_queue").insert({
    event_id: eventId,
    court_id: court.id,
    match_id: match.id,
    queue_position: queuePosition,
    is_active: true,
    status: "active",
    updated_at: now
  });
  if (queueError) return NextResponse.json({ error: queueError.message }, { status: 500 });

  const initialState = defaultManualState();
  const updatedCourt = { ...court, current_match_id: match.id, status: "waiting", last_update_at: now };
  const saved = await persistScoreAndOverlay(updatedCourt, match, {
    court_id: court.id,
    match_id: match.id,
    team_a_score: initialState.team_a_score,
    team_b_score: initialState.team_b_score,
    team_a_sets: initialState.team_a_sets,
    team_b_sets: initialState.team_b_sets,
    current_set: initialState.current_set,
    set_scores: initialState.set_scores,
    serving_team: initialState.serving_team,
    timeouts: initialState.timeouts,
    status: "Pre-Match",
    source: "manual",
    stale: false,
    message: null
  });

  const origin = publicOrigin(req);
  return NextResponse.json({
    ok: true,
    event,
    court: updatedCourt,
    match,
    score: saved.score,
    overlay: saved.overlay,
    token,
    scorerUrl: `${origin}/score/court/${court.id}?token=${encodeURIComponent(token)}`,
    overlayUrl: `${origin}/overlay/stream/${parsed.data.courtNumber}`,
    eventOverlayUrl: `${origin}/overlay/court/${parsed.data.courtNumber}?eventId=${eventId}`
  });
}

function formatFromBody(body: z.infer<typeof manualSessionSchema>) {
  const bestOf = body.bestOf ?? defaultFormat.bestOf;
  const pointsPerSet = [
    body.pointsSet1 ?? 21,
    body.pointsSet2 ?? 21,
    body.pointsSet3 ?? 15
  ].slice(0, bestOf);
  const cap = body.cap && body.cap !== "none" ? Number(body.cap) : null;
  return {
    ...defaultFormat,
    bestOf,
    pointsPerSet,
    cap: Number.isFinite(cap) ? cap : null,
    setsToWin: Math.ceil(bestOf / 2)
  };
}

function publicOrigin(req: NextRequest) {
  const configured = getEnv().publicSiteUrl;
  return (configured || new URL(req.url).origin).replace(/\/$/, "");
}

function cleanText(value: string | undefined) {
  const text = value?.trim();
  return text?.length ? text : null;
}
