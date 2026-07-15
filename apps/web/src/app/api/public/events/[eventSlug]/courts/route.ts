import { NextRequest, NextResponse } from "next/server";
import { getCommunityStatusForEvent } from "@/lib/communityWitness";
import { getEventBySlug } from "@/lib/eventConfig";
import { scoreForCurrentMatch } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";
import { toPublicCourtCardDto, toPublicEventDetailDto, toPublicScorerStatusDto } from "@/lib/publicDtos";

type Relation<T> = T | T[] | null | undefined;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ eventSlug: string }> }) {
  try {
    const { eventSlug } = await params;
    const db = supabaseAdmin();
    const event = await getEventBySlug(eventSlug, db);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    // Reconcile every lease-backed authority mode under deterministic court
    // locks before building the public list. This avoids one RPC per card and
    // never reports stale designated/consensus coverage after leases expire.
    const communityStatuses = await getCommunityStatusForEvent(event.id);
    const communityStatusByCourt = new Map(communityStatuses.map((status) => [status.courtId, status] as const));
    const { data, error } = await db
      .from("courts")
      .select("id,court_number,display_name,scoring_open,backup_requested,last_update_at,youtube_video_id,current_match_id,matches:current_match_id(id,match_number,round_name,team_a,team_b),score_states(match_id,team_a_score,team_b_score,team_a_sets,team_b_sets,current_set,set_scores,status,authority_mode,last_score_change_at,updated_at)")
      .eq("event_id", event.id)
      .order("court_number", { ascending: true });
    if (error) throw error;
    const courtRows = data ?? [];
    const courts = courtRows.map((court) => {
      const match = firstRelation(court.matches);
      const score = scoreForCurrentMatch(court.score_states, match?.id);
      const communityStatus = communityStatusByCourt.get(court.id);
      const scopedStatus = communityStatus?.matchId === (match?.id ?? null) ? communityStatus : null;
      const needsScorer = scopedStatus?.needsScorer ?? Boolean(match);
      return toPublicCourtCardDto({
        court,
        match,
        score,
        scorerStatus: toPublicScorerStatusDto({
          needsScorer,
          backupRequested: court.backup_requested,
          hasActive: Boolean(match) && !needsScorer,
          backupCount: scopedStatus?.activeWitnessCount ?? 0,
          activeName: scopedStatus?.activeDesignatedName ?? null
        })
      });
    });
    // Public browse data, identical for every viewer — let the Vercel CDN absorb
    // fan-scaled polling so many watchers collapse to ~1 DB read per few seconds.
    // Next strips s-maxage from dynamic route handlers, so target the CDN directly
    // with CDN-Cache-Control (Vercel honors it); keep the browser uncached.
    return NextResponse.json({ event: toPublicEventDetailDto(event), courts }, { headers: {
      "cache-control": "no-store",
      "cdn-cache-control": "public, s-maxage=3, stale-while-revalidate=15"
    } });
  } catch (err) {
    console.error("Could not load public courts", err);
    return NextResponse.json({ error: "Could not load courts" }, { status: 500 });
  }
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
