import { buildOverlayState } from "./overlay";
import { normalizeScorePayload } from "./scoring";
import { persistScoreAndOverlay } from "./scoreState";
import { supabaseAdmin } from "./supabase";

const POLL_WINDOW_MS = 25_000;
const ACTIVE_INTERVAL_MS = 1_800;
const LEASE_MS = 35_000;

type Relation<T> = T | T[] | null | undefined;

type CourtRow = {
  id: string;
  event_id: string;
  court_number: number;
  display_name: string;
  mode: "api" | "manual" | "hybrid";
  frozen: boolean;
  status: string;
  last_update_at: string | null;
  current_match_id: string | null;
  matches?: Relation<MatchRow>;
  score_states?: Relation<{ source?: string | null }>;
};

type MatchRow = {
  id: string;
  event_id: string;
  api_url: string | null;
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

export async function runPollingWindow(eventId: string, courtId?: string) {
  const owner = `local-${crypto.randomUUID()}`;
  const startedAt = Date.now();
  let polls = 0;
  let errors = 0;

  while (Date.now() - startedAt < POLL_WINDOW_MS) {
    const result = await pollActiveCourtsOnce({ eventId, courtId, owner });
    polls += result.polls;
    errors += result.errors;
    await sleep(ACTIVE_INTERVAL_MS);
  }

  return { owner, polls, errors, windowMs: Date.now() - startedAt };
}

export async function pollActiveCourtsOnce(options: { eventId?: string; courtId?: string; owner: string }) {
  const db = supabaseAdmin();
  await recordHeartbeat(options.owner, "polling", options.eventId, { localWindow: Boolean(options.eventId) });

  let query = db
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .in("mode", ["api", "hybrid"])
    .eq("frozen", false)
    .not("current_match_id", "is", null)
    .order("court_number", { ascending: true });

  if (options.eventId) query = query.eq("event_id", options.eventId);
  if (options.courtId) query = query.eq("id", options.courtId);

  const { data, error } = await query;
  if (error) throw error;

  let polls = 0;
  let errors = 0;
  const courts = (data ?? []) as CourtRow[];
  await Promise.all(courts.map(async (court) => {
    const lease = await acquireLease(court.event_id, court.id, options.owner);
    if (!lease) return;
    try {
      const polled = await pollCourt(court);
      if (polled) polls += 1;
    } catch (err) {
      errors += 1;
      await markCourtStale(court, err instanceof Error ? err.message : "Polling failed");
    }
  }));

  await recordHeartbeat(options.owner, "idle", options.eventId, { polls, errors });
  return { polls, errors };
}

export async function recordHeartbeat(workerId: string, status: string, eventId?: string, metadata: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  await supabaseAdmin().from("worker_heartbeats").upsert({
    worker_id: workerId,
    event_id: eventId ?? null,
    status,
    metadata,
    last_seen_at: now
  });
}

async function acquireLease(eventId: string, courtId: string, owner: string): Promise<boolean> {
  const db = supabaseAdmin();
  const expiresAt = new Date(Date.now() + LEASE_MS).toISOString();
  const { data: existing } = await db
    .from("poller_leases")
    .select("owner, expires_at")
    .eq("court_id", courtId)
    .maybeSingle();

  if (existing?.expires_at && new Date(String(existing.expires_at)).getTime() > Date.now() && existing.owner !== owner) {
    return false;
  }

  const { error } = await db.from("poller_leases").upsert({
    event_id: eventId,
    court_id: courtId,
    owner,
    expires_at: expiresAt,
    last_heartbeat_at: new Date().toISOString()
  });
  return !error;
}

async function pollCourt(court: CourtRow) {
  const db = supabaseAdmin();
  const match = firstRelation(court.matches);
  const currentScore = firstRelation(court.score_states);
  if (currentScore?.source === "override") return false;
  if (!match?.api_url) return false;

  const res = await fetch(match.api_url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Match API HTTP ${res.status}`);
  }
  const payload = await res.json();
  const snapshot = normalizeScorePayload(payload, match);
  const now = new Date().toISOString();

  const updatedMatch = await updateResolvedTeams(match, snapshot.teamAName, snapshot.teamBName, snapshot.teamASeed, snapshot.teamBSeed);
  await persistScoreAndOverlay(court, updatedMatch, {
    court_id: court.id,
    match_id: updatedMatch.id,
    team_a_score: snapshot.teamAScore,
    team_b_score: snapshot.teamBScore,
    team_a_sets: snapshot.teamASets,
    team_b_sets: snapshot.teamBSets,
    current_set: snapshot.currentSet,
    set_scores: snapshot.setScores,
    serving_team: snapshot.servingTeam ?? null,
    status: snapshot.status,
    source: snapshot.source,
    stale: false,
    message: null,
    last_api_poll_at: now,
    last_score_change_at: now,
    updated_at: now
  });
  return true;
}

async function updateResolvedTeams(match: MatchRow, teamAName: string, teamBName: string, teamASeed: string | null | undefined, teamBSeed: string | null | undefined) {
  const teamA = shouldReplaceTeam(match.team_a, teamAName) ? teamAName : match.team_a;
  const teamB = shouldReplaceTeam(match.team_b, teamBName) ? teamBName : match.team_b;
  const teamASeedNext = teamASeed ?? match.team_a_seed;
  const teamBSeedNext = teamBSeed ?? match.team_b_seed;

  if (teamA === match.team_a && teamB === match.team_b && teamASeedNext === match.team_a_seed && teamBSeedNext === match.team_b_seed) {
    return match;
  }

  const { data, error } = await supabaseAdmin()
    .from("matches")
    .update({
      team_a: teamA,
      team_b: teamB,
      team_a_seed: teamASeedNext,
      team_b_seed: teamBSeedNext,
      updated_at: new Date().toISOString()
    })
    .eq("id", match.id)
    .select("*")
    .single();
  if (error) throw error;
  return data as MatchRow;
}

async function markCourtStale(court: CourtRow, message: string) {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const match = firstRelation(court.matches);
  const { data: score } = await db
    .from("score_states")
    .select("*")
    .eq("court_id", court.id)
    .maybeSingle();

  let staleScore = score;
  if (score) {
    const { data: updatedScore } = await db.from("score_states").update({
      stale: true,
      message,
      last_api_poll_at: now,
      updated_at: now
    }).eq("court_id", court.id).select("*").single();
    staleScore = updatedScore;
  }

  const { data: updatedCourt } = await db
    .from("courts")
    .update({ status: "error", last_update_at: now, updated_at: now })
    .eq("id", court.id)
    .select("*")
    .single();

  await db.from("poller_errors").insert({
    event_id: court.event_id,
    court_id: court.id,
    match_id: match?.id ?? null,
    source_url: match?.api_url ?? null,
    message,
    payload: { courtNumber: court.court_number }
  });

  const overlay = buildOverlayState({
    event: { id: court.event_id },
    court: updatedCourt ?? { ...court, status: "error", last_update_at: now },
    match: match ?? null,
    score: staleScore ?? null
  });
  await db.from("overlay_states").upsert({
    court_id: court.id,
    event_id: court.event_id,
    court_number: court.court_number,
    payload: overlay,
    stale: true,
    updated_at: now
  });
}

function shouldReplaceTeam(current: string | null, next: string) {
  const clean = next.trim();
  if (!clean || clean === "Team A" || clean === "Team B") return false;
  if (!current) return true;
  return /^(TBD|Team A|Team B|Winner|Loser)/i.test(current);
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
