import "server-only";
import { supabaseAdmin } from "./supabase";

/**
 * Loads the admin court relation and only the score row belonging to each
 * court's current match. This keeps historical score rows out of dashboard
 * payloads and makes an idle court's score unambiguously null.
 */
export async function loadAdminCourtsWithCurrentScores<TCourt = Record<string, unknown>>(
  eventId: string,
  db: ReturnType<typeof supabaseAdmin> = supabaseAdmin()
): Promise<TCourt[]> {
  const { data: courts, error: courtError } = await db
    .from("courts")
    .select("*, matches:current_match_id(*)")
    .eq("event_id", eventId)
    .order("court_number", { ascending: true });
  if (courtError) throw courtError;

  const courtRows = (courts ?? []) as Array<Record<string, unknown> & { current_match_id?: string | null }>;
  const matchIds = [...new Set(courtRows
    .map((court) => court.current_match_id)
    .filter((matchId): matchId is string => typeof matchId === "string" && matchId.length > 0))];

  let scores: Array<Record<string, unknown> & { match_id?: string | null }> = [];
  if (matchIds.length > 0) {
    const { data, error } = await db.from("score_states").select("*").in("match_id", matchIds);
    if (error) throw error;
    scores = (data ?? []) as Array<Record<string, unknown> & { match_id?: string | null }>;
  }
  const scoreByMatch = new Map(scores
    .filter((score): score is Record<string, unknown> & { match_id: string } => typeof score.match_id === "string")
    .map((score) => [score.match_id, score] as const));

  return courtRows.map((court) => ({
    ...court,
    score_states: court.current_match_id ? scoreByMatch.get(court.current_match_id) ?? null : null
  })) as unknown as TCourt[];
}
