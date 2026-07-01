import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { defaultManualState } from "@/lib/manualScoring";
import { persistScoreAndOverlay } from "@/lib/scoreState";
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
  let queued = 0;
  let activated = 0;
  const unmappedCourts = new Set<string>();
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
        const queueResult = await autoQueueDiscoveredMatches(eventId, savedMatches ?? []);
        queued += queueResult.queued;
        activated += queueResult.activated;
        queueResult.unmappedCourts.forEach((court) => unmappedCourts.add(court));
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

  return NextResponse.json({ discovered, queued, activated, unmappedCourts: [...unmappedCourts].sort(compareCourtLabels), errors });
}

async function autoQueueDiscoveredMatches(eventId: string, matches: Record<string, unknown>[]) {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  let queued = 0;
  let activated = 0;
  const unmappedCourts = new Set<string>();
  for (const match of matches) {
    const vblCourtNumber = cleanText(match.court_number);
    const matchId = typeof match.id === "string" ? match.id : null;
    if (!matchId || !vblCourtNumber) continue;

    const { data: court } = await db
      .from("courts")
      .select("*")
      .eq("event_id", eventId)
      .eq("vbl_court_number", vblCourtNumber)
      .order("court_number", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!court) {
      unmappedCourts.add(vblCourtNumber);
      continue;
    }

    const { data: existingQueue } = await db
      .from("court_match_queue")
      .select("id")
      .eq("court_id", court.id)
      .eq("match_id", matchId)
      .maybeSingle();
    if (existingQueue) continue;

    const { data: active } = await db
      .from("court_match_queue")
      .select("id, matches:match_id(id,source_type,source_payload)")
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
    const activeMatch = firstRelation(active?.matches);
    const shouldReplaceSeed = activeMatch?.source_type === "manual" && recordValue(activeMatch.source_payload)?.seededBy === "seed:avp-denver";
    const shouldActivate = !active || !court.current_match_id || shouldReplaceSeed;

    if (shouldActivate) {
      await db
        .from("court_match_queue")
        .update({ is_active: false, status: "queued", updated_at: now })
        .eq("court_id", court.id)
        .eq("is_active", true);
    }

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
    queued += 1;

    if (shouldActivate) {
      const { error: courtError } = await db
        .from("courts")
        .update({ current_match_id: matchId, status: "waiting", mode: court.mode === "manual" ? "hybrid" : court.mode, updated_at: now })
        .eq("id", court.id)
        .select("*")
        .single();
      if (courtError) throw courtError;
      const { data: updatedCourt } = await db.from("courts").select("*").eq("id", court.id).single();
      if (updatedCourt) {
        const initial = defaultManualState();
        await persistScoreAndOverlay(updatedCourt, match as Parameters<typeof persistScoreAndOverlay>[1], {
          court_id: court.id,
          match_id: matchId,
          team_a_score: initial.team_a_score,
          team_b_score: initial.team_b_score,
          team_a_sets: initial.team_a_sets,
          team_b_sets: initial.team_b_sets,
          current_set: initial.current_set,
          set_scores: initial.set_scores,
          serving_team: initial.serving_team,
          timeouts: initial.timeouts,
          status: "Pre-Match",
          source: "api",
          source_available: false,
          source_priority: "fallback",
          stale: false,
          message: "VolleyballLife match assigned; waiting for live scoring."
        });
      }
      activated += 1;
    }
  }
  return { queued, activated, unmappedCourts: [...unmappedCourts] };
}

function cleanText(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function compareCourtLabels(a: string, b: string) {
  return Number(a) - Number(b) || a.localeCompare(b);
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
