import { buildOverlayState } from "./overlay";
import { supabaseAdmin } from "./supabase";

export type CourtRecord = {
  id: string;
  event_id: string;
  court_number: number;
  display_name: string;
  mode: "api" | "manual" | "hybrid";
  frozen: boolean;
  status: string;
  last_update_at: string | null;
};

export type MatchRecord = {
  id: string;
  event_id: string;
  match_number: string | null;
  round_name: string | null;
  scheduled_time: string | null;
  team_a: string | null;
  team_b: string | null;
  team_a_seed: string | null;
  team_b_seed: string | null;
  team_a_players: string[] | null;
  team_b_players: string[] | null;
  format: Record<string, unknown> | null;
};

export type ScoreRecord = {
  court_id: string;
  match_id: string | null;
  team_a_score: number;
  team_b_score: number;
  team_a_sets: number;
  team_b_sets: number;
  current_set: number;
  set_scores: unknown;
  serving_team: string | null;
  timeouts?: Record<string, unknown> | null;
  status: string;
  source: "api" | "manual" | "override";
  stale: boolean;
  message: string | null;
  last_api_poll_at: string | null;
  last_score_change_at: string | null;
  updated_at: string | null;
};

export async function persistScoreAndOverlay(
  court: CourtRecord,
  match: MatchRecord | null,
  score: Partial<ScoreRecord> & {
    court_id: string;
    match_id: string | null;
    team_a_score: number;
    team_b_score: number;
    team_a_sets: number;
    team_b_sets: number;
    current_set: number;
    set_scores: unknown;
    serving_team?: string | null;
    status: string;
    source: "api" | "manual" | "override";
    stale?: boolean;
    message?: string | null;
  }
) {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const { data: savedScore, error } = await db
    .from("score_states")
    .upsert({
      court_id: score.court_id,
      match_id: score.match_id,
      team_a_score: score.team_a_score,
      team_b_score: score.team_b_score,
      team_a_sets: score.team_a_sets,
      team_b_sets: score.team_b_sets,
      current_set: score.current_set,
      set_scores: score.set_scores,
      serving_team: score.serving_team ?? null,
      timeouts: score.timeouts ?? {},
      status: score.status,
      source: score.source,
      stale: score.stale ?? false,
      message: score.message ?? null,
      last_api_poll_at: score.last_api_poll_at ?? null,
      last_score_change_at: score.last_score_change_at ?? now,
      updated_at: now
    }, { onConflict: "court_id" })
    .select()
    .single();
  if (error) throw error;

  const status = resolveCourtStatus(score.status, score.set_scores);
  const { data: updatedCourt, error: courtError } = await db
    .from("courts")
    .update({ status, last_update_at: now, updated_at: now })
    .eq("id", court.id)
    .select("*")
    .single();
  if (courtError) throw courtError;

  const overlay = buildOverlayState({
    event: { id: court.event_id },
    court: updatedCourt,
    match,
    score: savedScore
  });

  const { error: overlayError } = await db.from("overlay_states").upsert({
    court_id: court.id,
    event_id: court.event_id,
    court_number: court.court_number,
    payload: overlay,
    stale: savedScore.stale,
    updated_at: now
  });
  if (overlayError) throw overlayError;
  return { score: savedScore, overlay };
}

function resolveCourtStatus(status: string, setScores: unknown): string {
  const lower = status.toLowerCase();
  if (lower.includes("final") || lower.includes("complete")) return "finished";
  if (Array.isArray(setScores) && setScores.length > 0) return "live";
  return "waiting";
}
