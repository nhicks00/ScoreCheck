import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { buildOverlayStateWithEventSettings, scoreForCurrentMatch } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

const matchEditSchema = z.object({
  teamA: z.string().max(120).optional(),
  teamB: z.string().max(120).optional(),
  teamASeed: z.string().max(20).optional(),
  teamBSeed: z.string().max(20).optional(),
  matchNumber: z.string().max(40).optional(),
  roundName: z.string().max(80).optional(),
  scheduledTime: z.string().max(40).optional()
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ courtId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { courtId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = matchEditSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid match edit payload" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: court, error: courtError } = await db
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("id", courtId)
    .maybeSingle();
  if (courtError) return NextResponse.json({ error: courtError.message }, { status: 500 });
  if (!court) return NextResponse.json({ error: "Court not found" }, { status: 404 });
  const currentMatch = Array.isArray(court.matches) ? court.matches[0] : court.matches;
  if (!currentMatch?.id) return NextResponse.json({ error: "No active match on this court" }, { status: 409 });

  const updates = {
    team_a: clean(parsed.data.teamA),
    team_b: clean(parsed.data.teamB),
    team_a_seed: clean(parsed.data.teamASeed),
    team_b_seed: clean(parsed.data.teamBSeed),
    match_number: clean(parsed.data.matchNumber),
    round_name: clean(parsed.data.roundName),
    scheduled_time: clean(parsed.data.scheduledTime),
    updated_at: new Date().toISOString()
  };
  const compactUpdates = Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined));
  const { data: match, error: matchError } = await db
    .from("matches")
    .update(compactUpdates)
    .eq("id", currentMatch.id)
    .select("*")
    .single();
  if (matchError) return NextResponse.json({ error: matchError.message }, { status: 500 });

  const score = scoreForCurrentMatch(court.score_states, match.id);
  const overlay = await buildOverlayStateWithEventSettings(court, match, score ?? null);
  await db.from("overlay_states").upsert({
    court_id: court.id,
    event_id: court.event_id,
    court_number: court.court_number,
    payload: overlay,
    stale: score?.stale ?? false,
    updated_at: new Date().toISOString()
  });
  await db.from("audit_logs").insert({
    event_id: court.event_id,
    court_id: court.id,
    actor: "admin",
    action: "match-edit",
    payload: { matchId: match.id, updates: compactUpdates }
  });

  return NextResponse.json({ ok: true, match, overlay });
}

function clean(value: string | undefined) {
  if (value == null) return undefined;
  const text = value.trim();
  return text.length ? text : null;
}
