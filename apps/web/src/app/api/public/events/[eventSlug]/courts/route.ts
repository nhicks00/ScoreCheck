import { NextRequest, NextResponse } from "next/server";
import { getEventBySlug } from "@/lib/eventConfig";
import { computeCourtScorerStatus } from "@/lib/scorerSessions";
import { scoreForCurrentMatch } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

type Relation<T> = T | T[] | null | undefined;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ eventSlug: string }> }) {
  try {
    const { eventSlug } = await params;
    const db = supabaseAdmin();
    const event = await getEventBySlug(eventSlug, db);
    if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    const { data, error } = await db
      .from("courts")
      .select("*, matches:current_match_id(*), score_states(*)")
      .eq("event_id", event.id)
      .order("court_number", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const courts = await Promise.all((data ?? []).map(async (court) => {
      const status = await computeCourtScorerStatus(court.id);
      const match = firstRelation(court.matches);
      const score = scoreForCurrentMatch(court.score_states, match?.id);
      return {
        id: court.id,
        courtNumber: court.court_number,
        displayName: court.display_name,
        scoringOpen: court.scoring_open !== false,
        lastUpdateAt: court.last_update_at ?? null,
        // Public by design (unlike stream keys): fans deep-link to the live broadcast.
        youtubeVideoId: (typeof court.youtube_video_id === "string" && court.youtube_video_id.trim()) || null,
        backupRequested: status.backupRequested,
        scorerStatus: {
          needsScorer: status.needsScorer,
          hasActive: Boolean(status.active),
          backups: status.backups.length,
          activeName: status.active?.display_name ?? null
        },
        match: match ? {
          id: match.id,
          matchNumber: match.match_number,
          roundName: match.round_name,
          teamA: match.team_a,
          teamB: match.team_b
        } : null,
        score: score ? {
          teamAScore: score.team_a_score,
          teamBScore: score.team_b_score,
          teamASets: score.team_a_sets,
          teamBSets: score.team_b_sets,
          currentSet: score.current_set,
          setScores: Array.isArray(score.set_scores) ? score.set_scores : [],
          status: score.status,
          lastScoreChangeAt: score.last_score_change_at ?? null,
          updatedAt: score.updated_at ?? null
        } : null
      };
    }));
    return NextResponse.json({ event, courts }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not load courts" }, { status: 500 });
  }
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
