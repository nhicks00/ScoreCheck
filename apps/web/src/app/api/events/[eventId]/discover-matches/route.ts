import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { discoverMatchesFromUrl } from "@/lib/vbl";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  const db = supabaseAdmin();
  const { data: sources, error: sourceError } = await db
    .from("bracket_sources")
    .select("*")
    .eq("event_id", eventId);
  if (sourceError) return NextResponse.json({ error: sourceError.message }, { status: 500 });

  let discovered = 0;
  const errors: string[] = [];
  for (const source of sources ?? []) {
    try {
      const matches = await discoverMatchesFromUrl(source.source_url);
      discovered += matches.length;
      if (matches.length) {
        const rows = matches.map((match) => ({
          event_id: eventId,
          external_match_id: match.externalMatchId,
          source_type: "vbl",
          api_url: match.apiUrl,
          bracket_url: match.bracketUrl,
          match_number: match.matchNumber,
          round_name: match.roundName,
          scheduled_time: match.scheduledTime,
          scheduled_date: match.scheduledDate,
          court_number: match.courtNumber,
          physical_court: match.physicalCourt,
          team_a: match.teamA,
          team_b: match.teamB,
          team_a_seed: match.teamASeed,
          team_b_seed: match.teamBSeed,
          team_a_players: match.teamAPlayers,
          team_b_players: match.teamBPlayers,
          format: match.format,
          source_payload: match.sourcePayload,
          updated_at: new Date().toISOString()
        }));
        const { data: savedMatches, error } = await db.from("matches").upsert(rows, { onConflict: "event_id,api_url" }).select("*");
        if (error) throw error;
        await autoQueueDiscoveredMatches(eventId, savedMatches ?? []);
      }
      await db.from("bracket_sources").update({
        status: "success",
        last_error: null,
        discovered_at: new Date().toISOString()
      }).eq("id", source.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Discovery failed";
      errors.push(`${source.source_url}: ${message}`);
      await db.from("bracket_sources").update({ status: "error", last_error: message }).eq("id", source.id);
    }
  }

  return NextResponse.json({ discovered, errors });
}

async function autoQueueDiscoveredMatches(eventId: string, matches: Record<string, unknown>[]) {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  for (const match of matches) {
    const courtNumber = Number(match.court_number);
    const matchId = typeof match.id === "string" ? match.id : null;
    if (!matchId || !Number.isFinite(courtNumber)) continue;

    const { data: court } = await db
      .from("courts")
      .select("*")
      .eq("event_id", eventId)
      .eq("court_number", courtNumber)
      .maybeSingle();
    if (!court) continue;

    const { data: existingQueue } = await db
      .from("court_match_queue")
      .select("id")
      .eq("court_id", court.id)
      .eq("match_id", matchId)
      .maybeSingle();
    if (existingQueue) continue;

    const { data: active } = await db
      .from("court_match_queue")
      .select("id")
      .eq("court_id", court.id)
      .eq("is_active", true)
      .maybeSingle();
    const { data: lastQueue } = await db
      .from("court_match_queue")
      .select("queue_position")
      .eq("court_id", court.id)
      .order("queue_position", { ascending: false })
      .limit(1)
      .maybeSingle();
    const shouldActivate = !active && !court.current_match_id;

    const { error: queueError } = await db.from("court_match_queue").insert({
      event_id: eventId,
      court_id: court.id,
      match_id: matchId,
      queue_position: Number(lastQueue?.queue_position ?? 0) + 1,
      is_active: shouldActivate,
      status: shouldActivate ? "active" : "queued",
      updated_at: now
    });
    if (queueError) throw queueError;

    if (shouldActivate) {
      const { error: courtError } = await db
        .from("courts")
        .update({ current_match_id: matchId, status: "waiting", updated_at: now })
        .eq("id", court.id);
      if (courtError) throw courtError;
    }
  }
}
