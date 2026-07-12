import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  BROADCAST_EXPECTATIONS,
  COMMENTARY_EXPECTATIONS,
  COVERAGE_PHASES,
  MEDIA_EXPECTATIONS,
  SCORING_EXPECTATIONS,
  type CompetitionCourtSnapshot,
  type CompetitionMatchSnapshot,
  type CompetitionScoreSnapshot,
  type ControlPlaneSnapshot,
  type CourtExpectation,
  type HealthState
} from "./contracts.js";

const OFF_EXPECTATION: CourtExpectation = {
  coveragePhase: "OFF",
  mediaExpectation: "OFF",
  broadcastExpectation: "OFF",
  commentaryExpectation: "NONE",
  scoringExpectation: "NONE",
  overrideExpiresAt: null
};

type CourtRow = {
  id: string;
  court_number: number;
  display_name: string | null;
  vbl_court_label: string | null;
  vbl_court_number: string | null;
  status: string | null;
  current_match_id: string | null;
  youtube_video_id: string | null;
  matches: MatchRow | MatchRow[] | null;
  score_states: ScoreRow | ScoreRow[] | null;
};

type MatchRow = {
  id: string;
  match_number: string | null;
  round_name: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  team_a: string | null;
  team_b: string | null;
};

type ScoreRow = {
  match_id: string | null;
  team_a_score: number;
  team_b_score: number;
  team_a_sets: number;
  team_b_sets: number;
  current_set: number;
  set_scores: unknown;
  status: string;
  source: string;
  source_available: boolean | null;
  source_priority: string | null;
  stale: boolean;
  last_api_poll_at: string | null;
  updated_at: string | null;
};

type OverlayRow = { court_id: string; payload: unknown; stale: boolean; updated_at: string | null };
type QueueRow = { court_id: string; queue_position: number; is_active: boolean; status: string; matches: MatchRow | MatchRow[] | null };
type ExpectationRow = {
  court_id: string;
  coverage_phase: string;
  media_expectation: string;
  broadcast_expectation: string;
  commentary_expectation: string;
  scoring_expectation: string;
  override_expires_at: string | null;
};

export class ControlPlaneCollector {
  private readonly db: SupabaseClient | null;
  private last: ControlPlaneSnapshot | null = null;
  private lastAttemptAtMs = 0;

  constructor(url: string | null, serviceRoleKey: string | null, private readonly intervalMs = 10_000) {
    this.db = url && serviceRoleKey ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  }

  async refresh(nowMs = Date.now()): Promise<ControlPlaneSnapshot | null> {
    if (!this.db) return null;
    if (this.last && nowMs - this.lastAttemptAtMs < this.intervalMs) return this.last;
    this.lastAttemptAtMs = nowMs;
    this.last = await loadControlPlane(this.db, nowMs);
    return this.last;
  }

  current(): ControlPlaneSnapshot | null {
    return this.last;
  }
}

export async function loadControlPlane(db: SupabaseClient, nowMs = Date.now()): Promise<ControlPlaneSnapshot> {
  const { data: event, error: eventError } = await db
    .from("events")
    .select("id,name,status,event_date")
    .eq("is_active", true)
    .maybeSingle();
  if (eventError) throw eventError;
  if (!event) return emptyControlPlane(nowMs);

  const [courtsResult, overlaysResult, queueResult, expectationsResult, workerResult] = await Promise.all([
    db.from("courts")
      .select("id,court_number,display_name,vbl_court_label,vbl_court_number,status,current_match_id,youtube_video_id,matches:current_match_id(id,match_number,round_name,scheduled_date,scheduled_time,team_a,team_b),score_states(match_id,team_a_score,team_b_score,team_a_sets,team_b_sets,current_set,set_scores,status,source,source_available,source_priority,stale,last_api_poll_at,updated_at)")
      .eq("event_id", event.id)
      .order("court_number", { ascending: true }),
    db.from("overlay_states").select("court_id,payload,stale,updated_at").eq("event_id", event.id),
    db.from("court_match_queue")
      .select("court_id,queue_position,is_active,status,matches:match_id(id,match_number,round_name,scheduled_date,scheduled_time,team_a,team_b)")
      .eq("event_id", event.id)
      .order("queue_position", { ascending: true }),
    db.from("court_monitoring_expectations")
      .select("court_id,coverage_phase,media_expectation,broadcast_expectation,commentary_expectation,scoring_expectation,override_expires_at")
      .eq("event_id", event.id),
    db.from("worker_heartbeats").select("status,last_seen_at").eq("event_id", event.id).order("last_seen_at", { ascending: false }).limit(1).maybeSingle()
  ]);
  const failure = [courtsResult.error, overlaysResult.error, queueResult.error, expectationsResult.error, workerResult.error].find(Boolean);
  if (failure) throw failure;

  const overlays = new Map((overlaysResult.data as OverlayRow[]).map((row) => [row.court_id, row]));
  const expectations = new Map((expectationsResult.data as ExpectationRow[]).map((row) => [row.court_id, parseExpectation(row, nowMs)]));
  const queueByCourt = groupBy(queueResult.data as QueueRow[], (row) => row.court_id);
  const courts = (courtsResult.data as unknown as CourtRow[]).map((court) => {
    const score = first(court.score_states);
    const overlay = overlays.get(court.id) ?? null;
    const queue = queueByCourt.get(court.id) ?? [];
    return buildCourt(court, score, overlay, queue, expectations.get(court.id) ?? OFF_EXPECTATION, nowMs);
  });

  const worker = workerHealth(workerResult.data as { status: string | null; last_seen_at: string | null } | null, nowMs);
  return {
    observedAt: new Date(nowMs).toISOString(),
    event: { id: event.id, name: event.name, status: event.status, eventDate: event.event_date },
    worker,
    courts
  };
}

function emptyControlPlane(nowMs: number): ControlPlaneSnapshot {
  return {
    observedAt: new Date(nowMs).toISOString(),
    event: null,
    worker: { state: "NOT_APPLICABLE", status: null, lastSeenAt: null, ageMs: null },
    courts: []
  };
}

function buildCourt(
  court: CourtRow,
  scoreRow: ScoreRow | null,
  overlayRow: OverlayRow | null,
  queue: QueueRow[],
  expectation: CourtExpectation,
  nowMs: number
): CompetitionCourtSnapshot {
  const currentMatch = toMatch(first(court.matches));
  const score = toScore(scoreRow);
  const overlay = parseOverlay(overlayRow);
  const sourceAgeMs = timestampAge(score?.lastApiPollAt ?? null, nowMs);
  const issueCodes = scoreAlignmentIssueCodes({
    currentMatchId: court.current_match_id,
    currentMatch,
    score,
    overlay,
    scoringExpectation: expectation.scoringExpectation,
    sourceAgeMs
  });

  const activePosition = queue.find((row) => row.is_active)?.queue_position ?? -1;
  const next = queue.find((row) => !row.is_active && row.queue_position > activePosition && row.status !== "completed");
  return {
    courtId: court.id,
    courtNumber: court.court_number,
    displayName: clean(court.display_name) ?? `Court ${court.court_number}`,
    physicalCourtLabel: clean(court.vbl_court_label) ?? clean(court.vbl_court_number) ?? clean(court.display_name) ?? `Court ${court.court_number}`,
    courtStatus: clean(court.status) ?? "unknown",
    expectation,
    currentMatch,
    nextMatch: toMatch(first(next?.matches)),
    score,
    overlay,
    alignment: {
      state: issueCodes.some((code) => ["OVERLAY_MATCH_MISMATCH", "OVERLAY_TEAM_MISMATCH", "OVERLAY_SCORE_MISMATCH", "IMPLAUSIBLE_67_67"].includes(code))
        ? "CRITICAL"
        : issueCodes.length > 0 ? "DEGRADED" : expectation.scoringExpectation === "NONE" ? "NOT_APPLICABLE" : "HEALTHY",
      issueCodes,
      sourceAgeMs
    },
    youtubeVideoId: clean(court.youtube_video_id)
  };
}

export function scoreAlignmentIssueCodes(input: {
  currentMatchId: string | null;
  currentMatch: CompetitionMatchSnapshot | null;
  score: CompetitionScoreSnapshot | null;
  overlay: CompetitionCourtSnapshot["overlay"];
  scoringExpectation: CourtExpectation["scoringExpectation"];
  sourceAgeMs: number | null;
}): string[] {
  const { currentMatchId, currentMatch, score, overlay, scoringExpectation, sourceAgeMs } = input;
  const issueCodes: string[] = [];
  if (currentMatchId && score?.matchId !== currentMatchId) issueCodes.push("SCORE_MATCH_MISMATCH");
  if (currentMatchId && overlay?.matchId !== currentMatchId) issueCodes.push("OVERLAY_MATCH_MISMATCH");
  if (currentMatch && overlay && (normalizeName(currentMatch.teamA) !== normalizeName(overlay.teamA) || normalizeName(currentMatch.teamB) !== normalizeName(overlay.teamB))) {
    issueCodes.push("OVERLAY_TEAM_MISMATCH");
  }
  if (score && overlay && !sameScore(score, overlay)) issueCodes.push("OVERLAY_SCORE_MISMATCH");
  if ((score?.teamAScore === 67 && score.teamBScore === 67) || (overlay?.teamAScore === 67 && overlay.teamBScore === 67)) issueCodes.push("IMPLAUSIBLE_67_67");
  if (score?.stale || overlay?.stale) issueCodes.push("SCORE_STATE_STALE");
  if (score && !score.sourceAvailable && scoringExpectation === "LIVE") issueCodes.push("LIVE_SCORE_SOURCE_UNAVAILABLE");
  if (scoringExpectation === "LIVE" && (sourceAgeMs == null || sourceAgeMs > 20_000)) issueCodes.push("LIVE_SCORE_SOURCE_STALE");
  return issueCodes;
}

function parseExpectation(row: ExpectationRow, nowMs: number): CourtExpectation {
  if (row.override_expires_at && Date.parse(row.override_expires_at) <= nowMs) return OFF_EXPECTATION;
  return {
    coveragePhase: member(row.coverage_phase, COVERAGE_PHASES, "OFF"),
    mediaExpectation: member(row.media_expectation, MEDIA_EXPECTATIONS, "OFF"),
    broadcastExpectation: member(row.broadcast_expectation, BROADCAST_EXPECTATIONS, "OFF"),
    commentaryExpectation: member(row.commentary_expectation, COMMENTARY_EXPECTATIONS, "NONE"),
    scoringExpectation: member(row.scoring_expectation, SCORING_EXPECTATIONS, "NONE"),
    overrideExpiresAt: validIso(row.override_expires_at)
  };
}

function parseOverlay(row: OverlayRow | null): CompetitionCourtSnapshot["overlay"] {
  const payload = record(row?.payload);
  const match = record(payload?.match);
  const teamA = record(match?.teamA);
  const teamB = record(match?.teamB);
  const score = record(payload?.score);
  if (!payload || !match || !score) return null;
  return {
    matchId: clean(match.id),
    teamA: clean(teamA?.name),
    teamB: clean(teamB?.name),
    teamAScore: integer(score.teamAScore),
    teamBScore: integer(score.teamBScore),
    teamASets: integer(score.teamASets),
    teamBSets: integer(score.teamBSets),
    currentSet: Math.max(1, integer(score.currentSet, 1)),
    phase: clean(payload.phase) ?? "UNKNOWN",
    stale: Boolean(row?.stale || record(payload.health)?.stale),
    updatedAt: validIso(row?.updated_at)
  };
}

function toMatch(row: MatchRow | null): CompetitionMatchSnapshot | null {
  return row ? {
    id: row.id,
    matchNumber: clean(row.match_number),
    roundName: clean(row.round_name),
    scheduledDate: clean(row.scheduled_date),
    scheduledTime: clean(row.scheduled_time),
    teamA: clean(row.team_a),
    teamB: clean(row.team_b)
  } : null;
}

function toScore(row: ScoreRow | null): CompetitionScoreSnapshot | null {
  return row ? {
    matchId: clean(row.match_id),
    teamAScore: integer(row.team_a_score),
    teamBScore: integer(row.team_b_score),
    teamASets: integer(row.team_a_sets),
    teamBSets: integer(row.team_b_sets),
    currentSet: Math.max(1, integer(row.current_set, 1)),
    setScores: Array.isArray(row.set_scores) ? row.set_scores.slice(0, 5) : [],
    status: clean(row.status) ?? "unknown",
    source: clean(row.source) ?? "unknown",
    sourceAvailable: row.source_available === true,
    sourcePriority: clean(row.source_priority) ?? "unknown",
    stale: Boolean(row.stale),
    lastApiPollAt: validIso(row.last_api_poll_at),
    updatedAt: validIso(row.updated_at)
  } : null;
}

function sameScore(score: CompetitionScoreSnapshot, overlay: NonNullable<CompetitionCourtSnapshot["overlay"]>) {
  return score.teamAScore === overlay.teamAScore
    && score.teamBScore === overlay.teamBScore
    && score.teamASets === overlay.teamASets
    && score.teamBSets === overlay.teamBSets
    && score.currentSet === overlay.currentSet;
}

function workerHealth(row: { status: string | null; last_seen_at: string | null } | null, nowMs: number): ControlPlaneSnapshot["worker"] {
  const ageMs = timestampAge(row?.last_seen_at ?? null, nowMs);
  const state: HealthState = !row || ageMs == null || ageMs > 60_000 ? "UNKNOWN" : ageMs > 20_000 ? "DEGRADED" : "HEALTHY";
  return { state, status: clean(row?.status), lastSeenAt: validIso(row?.last_seen_at), ageMs };
}

function first<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

function member<T extends readonly string[]>(value: string, allowed: T, fallback: T[number]): T[number] {
  return allowed.includes(value as T[number]) ? value as T[number] : fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function integer(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function clean(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
}

function normalizeName(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function validIso(value: unknown): string | null {
  const parsed = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function timestampAge(value: string | null, nowMs: number): number | null {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

export { OFF_EXPECTATION };
