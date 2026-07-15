import { NextRequest, NextResponse } from "next/server";
import { communityStatusForCourt } from "@/lib/communityWitness";
import { resolveCourtIdentifier } from "@/lib/eventConfig";
import { scoreForCurrentMatch } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";
import { publicCourtCoverage, toPublicCourtDetailDto, toPublicScorerStatusDto } from "@/lib/publicDtos";

type Relation<T> = T | T[] | null | undefined;

export async function GET(req: NextRequest, { params }: { params: Promise<{ courtParam: string }> }) {
  try {
    const { courtParam } = await params;
    const eventSlug = req.nextUrl.searchParams.get("eventSlug") ?? undefined;
    const db = supabaseAdmin();
    const data = await resolveCourtIdentifier({ eventSlug, courtParam, db });
    if (!data) return NextResponse.json({ error: "Court not found" }, { status: 404 });
    // UUID court identifiers must still belong to the event selected by the
    // request. Numeric identifiers are already event-scoped by resolution.
    if (data.court.event_id !== data.event.id) {
      return NextResponse.json({ error: "Court not found" }, { status: 404 });
    }
    const { data: court, error } = await db
      .from("courts")
      .select("id,court_number,display_name,scoring_open,backup_requested,current_match_id,matches:current_match_id(id,team_a,team_b,round_name,match_number,status),score_states(match_id,team_a_score,team_b_score,current_set,status,authority_mode)")
      .eq("id", data.court.id)
      .maybeSingle();
    if (error) throw error;
    if (!court) return NextResponse.json({ error: "Court not found" }, { status: 404 });
    const match = firstRelation(court?.matches);
    const score = scoreForCurrentMatch(court?.score_states, match?.id);
    const communityStatus = await communityStatusForCourt(court.id);
    const coverage = publicCourtCoverage({
      scoringOpen: court.scoring_open,
      hasMatch: Boolean(match),
      authorityMode: communityStatus ? (communityStatus.needsScorer ? "PAUSED_DISPUTE" : "COVERED") : score?.authority_mode
    });
    return NextResponse.json(toPublicCourtDetailDto({
      event: data.event,
      court,
      match,
      score,
      scorerStatus: toPublicScorerStatusDto({
        needsScorer: coverage.needsScorer,
        backupRequested: court.backup_requested,
        hasActive: coverage.hasActive,
        backupCount: communityStatus?.activeWitnessCount ?? 0,
        activeName: communityStatus?.activeDesignatedName
      })
    }), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("Could not load public court", err);
    return NextResponse.json({ error: "Could not load court" }, { status: 500 });
  }
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
