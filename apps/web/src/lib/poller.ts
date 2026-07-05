import { isAuthoritativeScorePayload, normalizeScorePayload, normalizeVblBracketPayload } from "./scoring";
import { refreshEventBracketSources } from "./bracketRefresh";
import { defaultManualState } from "./manualScoring";
import { buildOverlayStateWithEventSettings, persistScoreAndOverlay, scoreForCurrentMatch } from "./scoreState";
import { supabaseAdmin } from "./supabase";
import type { ScoreSnapshot, SetScore } from "./types";
import { VBL_OVERLAY_DELAY_MS, delayedScoreFromSnapshot, isDelayedScoreBehindVisible, pendingScoresForMatch, queueDelayedVblScore, shouldHoldDelayedFinalScore, splitDueDelayedVblScores, type DelayedVblScorePayload } from "./vblDelay";
import { buildActiveVblSourceSet, matchBelongsToActiveVblSource } from "./vblSources";

const POLL_WINDOW_MS = 25_000;
const ACTIVE_INTERVAL_MS = 1_800;
const LEASE_MS = 35_000;
const POST_FINAL_NEXT_MATCH_HOLD_MS = 180_000;
const BRACKET_REFRESH_INTERVAL_MS = 45_000;
const EVENT_TIME_ZONE = "America/Denver";

const lastBracketRefreshAtByEvent = new Map<string, number>();

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
  score_states?: Relation<ScoreRow>;
};

type MatchRow = {
  id: string;
  event_id: string;
  source_type?: "vbl" | "manual" | null;
  api_url: string | null;
  bracket_url?: string | null;
  match_number: string | null;
  round_name: string | null;
  scheduled_time: string | null;
  scheduled_date: string | null;
  team_a: string | null;
  team_b: string | null;
  team_a_seed: string | null;
  team_b_seed: string | null;
  team_a_players: string[] | null;
  team_b_players: string[] | null;
  format: Record<string, unknown> | null;
  source_payload?: Record<string, unknown> | null;
};

type QueueRow = {
  id: string;
  court_id: string;
  event_id: string;
  match_id: string;
  queue_position: number;
  is_active: boolean;
  status: string;
  matches?: Relation<MatchRow>;
};

type ScoreRow = {
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
  source?: "api" | "manual" | "override" | null;
  source_available?: boolean | null;
  source_priority?: "primary" | "fallback" | "override" | null;
  source_pending_scores?: unknown;
  stale?: boolean | null;
  message?: string | null;
  last_api_poll_at?: string | null;
  last_score_change_at?: string | null;
  updated_at?: string | null;
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
  await refreshBracketSourcesForActiveEvents(courts, options.eventId, options.owner);
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

async function refreshBracketSourcesForActiveEvents(courts: CourtRow[], eventId: string | undefined, owner: string) {
  const eventIds = eventId ? [eventId] : [...new Set(courts.map((court) => court.event_id).filter(Boolean))];
  for (const id of eventIds) {
    const lastRefreshAt = lastBracketRefreshAtByEvent.get(id) ?? 0;
    if (Date.now() - lastRefreshAt < BRACKET_REFRESH_INTERVAL_MS) continue;
    lastBracketRefreshAtByEvent.set(id, Date.now());
    try {
      const result = await refreshEventBracketSources(id);
      await recordHeartbeat(owner, "bracket-refresh", id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bracket refresh failed";
      await recordHeartbeat(owner, "bracket-refresh-error", id, { message });
    }
  }
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
  let currentScore = scoreForCurrentMatch(court.score_states, match?.id);
  if (currentScore?.source === "override") return false;
  if (!match?.api_url) return false;

  const releasedScore = await releaseDueDelayedVblScore(court, match, currentScore);
  if (releasedScore) currentScore = releasedScore;

  const bracketFinalScore = await persistVblBracketFinalIfAvailable(court, match, currentScore);
  if (bracketFinalScore) currentScore = bracketFinalScore;

  const bracketProgressScore = await persistVblBracketProgressIfAvailable(court, match, currentScore);
  if (bracketProgressScore) currentScore = bracketProgressScore;

  if (await advanceFinalMatchIfReady(court, match, currentScore)) return true;

  const res = await fetch(match.api_url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Match API HTTP ${res.status}`);
  }
  const payload = await res.json();
  const snapshot = normalizeScorePayload(payload, match);
  const sourceAvailable = isAuthoritativeScorePayload(payload, snapshot);
  const now = new Date().toISOString();

  const updatedMatch = await updateResolvedTeams(match, snapshot.teamAName, snapshot.teamBName, snapshot.teamASeed, snapshot.teamBSeed);
  if (sourceAvailable) {
    await queueLiveVblScore(court, updatedMatch, currentScore, snapshot, now);
    return true;
  }

  const scheduleAdvanceTarget = await nextQueuedMatch(court.id);
  const scheduleAdvanceMatch = firstRelation(scheduleAdvanceTarget?.matches);
  if (scheduleAdvanceTarget && scheduleAdvanceMatch && shouldAdvanceInactiveScheduledMatch(currentScore, snapshot, match, scheduleAdvanceMatch, now)) {
    await activateQueuedMatch(court, scheduleAdvanceTarget);
    return true;
  }

  if (hasFutureDelayedVblScore(currentScore, now)) {
    await touchApiPoll(court.id, now, true, "VolleyballLife live scoring active.");
    return true;
  }

  if (!sourceAvailable && currentScore?.source === "manual") {
    await markApiFallbackActive(court.id, now, "VolleyballLife feed connected; waiting for live score.");
    return true;
  }

  if (currentScore) {
    await markApiFallbackActive(court.id, now, "VolleyballLife feed connected; waiting for live score.");
    return true;
  }

  await persistFallbackSnapshot(court, updatedMatch, snapshot, now);
  return true;
}

async function advanceFinalMatchIfReady(court: CourtRow, match: MatchRow, currentScore: ScoreRow | null) {
  if (!currentScore || currentScore.match_id !== match.id) return false;
  if (!isFinalScore(currentScore)) return false;
  if (!hasScoreClinchedMatch(currentScore, match)) return false;
  if (match.source_type === "vbl" && !isApiConfirmedFinalScore(currentScore)) return false;
  if (hasFutureDelayedVblScore(currentScore, new Date().toISOString())) return false;

  const next = await nextQueuedMatch(court.id);
  if (!next) return false;
  const nextMatch = firstRelation(next.matches);
  const nextLiveScoringStarted = await queuedMatchHasAuthoritativeScore(nextMatch);
  const now = new Date().toISOString();
  if (!shouldAdvanceFinalMatchOverlay({
    finalVisibleAt: currentScore.last_score_change_at ?? currentScore.updated_at ?? null,
    now,
    nextLiveScoringStarted
  })) return false;

  await activateQueuedMatch(court, next);
  return true;
}

export function shouldAdvanceFinalMatchOverlay({
  finalVisibleAt,
  now,
  nextLiveScoringStarted,
  holdMs = POST_FINAL_NEXT_MATCH_HOLD_MS
}: {
  finalVisibleAt: string | null;
  now: string;
  nextLiveScoringStarted: boolean;
  holdMs?: number;
}) {
  if (nextLiveScoringStarted) return true;

  const finalVisibleAtMs = Date.parse(finalVisibleAt ?? "");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(finalVisibleAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - finalVisibleAtMs >= holdMs;
}

export function hasScoreClinchedMatch(
  score: Pick<ScoreRow, "team_a_sets" | "team_b_sets" | "set_scores" | "status">,
  match: Pick<MatchRow, "format">
) {
  const requiredSets = setsToWin(match.format);
  const completedSetCounts = dbSetScores(score.set_scores)
    .filter((set) => set.isComplete)
    .reduce((counts, set) => {
      if (set.teamAScore > set.teamBScore) counts.teamA += 1;
      if (set.teamBScore > set.teamAScore) counts.teamB += 1;
      return counts;
    }, { teamA: 0, teamB: 0 });
  if (Math.max(completedSetCounts.teamA, completedSetCounts.teamB) >= requiredSets) return true;

  return isFinalScore(score) && Math.max(Number(score.team_a_sets ?? 0), Number(score.team_b_sets ?? 0)) >= requiredSets;
}

function isFinalScore(score: Pick<ScoreRow, "status">) {
  return score.status.toLowerCase().includes("final") || score.status.toLowerCase().includes("complete");
}

function isApiConfirmedFinalScore(score: ScoreRow) {
  return score.source === "api"
    && score.source_available !== false
    && score.source_priority !== "fallback"
    && isFinalScore(score);
}

async function persistVblBracketFinalIfAvailable(court: CourtRow, match: MatchRow, currentScore: ScoreRow | null) {
  if (match.source_type !== "vbl") return null;
  const snapshot = normalizeVblBracketPayload(match.source_payload, match);
  if (!snapshot || !snapshot.status.toLowerCase().includes("final")) return null;

  const hasSameConfirmedFinal = currentScore
    && currentScore.match_id === match.id
    && isApiConfirmedFinalScore(currentScore)
    && currentScore.team_a_score === snapshot.teamAScore
    && currentScore.team_b_score === snapshot.teamBScore
    && currentScore.team_a_sets === snapshot.teamASets
    && currentScore.team_b_sets === snapshot.teamBSets
    && JSON.stringify(currentScore.set_scores ?? []) === JSON.stringify(snapshot.setScores);
  if (hasSameConfirmedFinal) return currentScore;

  const now = new Date().toISOString();
  if (shouldDelayBracketFinalConfirmation(currentScore, match, now)) {
    await queueLiveVblScore(court, match, currentScore, snapshot, now);
    return currentScore;
  }

  const finalVisibleAt = vblBracketFinalVisibleAt(match, now);
  const { score } = await persistScoreAndOverlay(court, match, {
    court_id: court.id,
    match_id: match.id,
    team_a_score: snapshot.teamAScore,
    team_b_score: snapshot.teamBScore,
    team_a_sets: snapshot.teamASets,
    team_b_sets: snapshot.teamBSets,
    current_set: snapshot.currentSet,
    set_scores: snapshot.setScores,
    serving_team: snapshot.servingTeam ?? null,
    status: snapshot.status,
    source: "api",
    source_available: true,
    source_priority: "primary",
    source_pending_scores: [],
    stale: false,
    message: "VolleyballLife bracket confirmed final score.",
    last_api_poll_at: now,
    last_score_change_at: finalVisibleAt,
    updated_at: now
  });
  return score as ScoreRow;
}

function shouldDelayBracketFinalConfirmation(currentScore: ScoreRow | null, match: MatchRow, now: string) {
  if (!currentScore || currentScore.match_id !== match.id) return false;
  if (isApiConfirmedFinalScore(currentScore)) return false;
  if (hasFutureDelayedVblScore(currentScore, now)) return true;
  return currentScore.source === "api"
    && currentScore.source_available !== false
    && currentScore.source_priority === "primary";
}

export function vblBracketFinalVisibleAt(match: Pick<MatchRow, "source_payload">, fallback: string) {
  const fallbackMs = Date.parse(fallback);
  const games = Array.isArray(match.source_payload?.games) ? match.source_payload.games : [];
  const modifiedTimes = games
    .map((game) => {
      if (!game || typeof game !== "object" || Array.isArray(game)) return null;
      const record = game as Record<string, unknown>;
      const teamAScore = Number(record.home);
      const teamBScore = Number(record.away);
      if (!Number.isFinite(teamAScore) || !Number.isFinite(teamBScore) || (teamAScore === 0 && teamBScore === 0)) return null;
      const modified = Number(record.dtModified ?? record.updatedAt ?? record.modifiedAt);
      if (!Number.isFinite(modified) || modified <= 0) return null;
      const modifiedMs = modified < 10_000_000_000 ? modified * 1000 : modified;
      if (Number.isFinite(fallbackMs) && modifiedMs > fallbackMs) return null;
      return modifiedMs;
    })
    .filter((value): value is number => value != null);
  const latest = Math.max(...modifiedTimes);
  return Number.isFinite(latest) ? new Date(latest).toISOString() : fallback;
}

async function queuedMatchHasAuthoritativeScore(match: MatchRow | null) {
  if (!match?.api_url) return false;
  try {
    const res = await fetch(match.api_url, { cache: "no-store" });
    if (!res.ok) return false;
    const payload = await res.json();
    const snapshot = normalizeScorePayload(payload, match);
    return hasLivePointScoringStarted(snapshot);
  } catch {
    return false;
  }
}

export function hasLivePointScoringStarted(snapshot: Pick<ReturnType<typeof normalizeScorePayload>, "status" | "teamAScore" | "teamBScore" | "setScores">) {
  const status = snapshot.status.toLowerCase();
  if (status.includes("final") || status.includes("complete")) return false;
  if (snapshot.teamAScore > 0 || snapshot.teamBScore > 0) return true;
  return snapshot.setScores.some((set) => !set.isComplete && (set.teamAScore > 0 || set.teamBScore > 0));
}

async function persistVblBracketProgressIfAvailable(court: CourtRow, match: MatchRow, currentScore: ScoreRow | null) {
  if (match.source_type !== "vbl") return null;
  if (currentScore?.source === "api" && currentScore.source_available !== false && currentScore.source_priority !== "fallback") return null;
  if (hasFutureDelayedVblScore(currentScore, new Date().toISOString())) return null;

  const snapshot = normalizeVblBracketPayload(match.source_payload, match);
  if (!snapshot || snapshot.status.toLowerCase().includes("final")) return null;
  if (!snapshot.setScores.some((set) => set.isComplete)) return null;
  if (!shouldApplyBracketProgress(currentScore, snapshot)) return null;

  const merged = mergeBracketProgress(currentScore, snapshot);
  const now = new Date().toISOString();
  const { score } = await persistScoreAndOverlay(court, match, {
    court_id: court.id,
    match_id: match.id,
    team_a_score: merged.teamAScore,
    team_b_score: merged.teamBScore,
    team_a_sets: merged.teamASets,
    team_b_sets: merged.teamBSets,
    current_set: merged.currentSet,
    set_scores: merged.setScores,
    serving_team: merged.servingTeam ?? null,
    status: merged.status,
    source: "api",
    source_available: false,
    source_priority: "fallback",
    source_pending_scores: [],
    stale: false,
    message: "VolleyballLife bracket confirmed completed set.",
    last_api_poll_at: now,
    last_score_change_at: now,
    updated_at: now
  });
  return score as ScoreRow;
}

function shouldApplyBracketProgress(currentScore: ScoreRow | null, snapshot: ScoreSnapshot) {
  if (!currentScore || currentScore.match_id == null) return true;
  const currentSets = dbSetScores(currentScore.set_scores);
  return snapshot.setScores
    .filter((set) => set.isComplete)
    .some((set) => {
      const currentSet = currentSets.find((item) => item.setNumber === set.setNumber);
      return !currentSet
        || currentSet.teamAScore !== set.teamAScore
        || currentSet.teamBScore !== set.teamBScore
        || currentSet.isComplete !== true;
    });
}

function mergeBracketProgress(currentScore: ScoreRow | null, snapshot: ScoreSnapshot): ScoreSnapshot {
  const completedSets = snapshot.setScores.filter((set) => set.isComplete);
  const liveSet = currentLiveSetAfterBracketConfirmation(currentScore, completedSets);
  if (!liveSet) return snapshot;

  const setScores = [...completedSets, liveSet].sort((a, b) => a.setNumber - b.setNumber);
  return {
    ...snapshot,
    status: "In Progress",
    currentSet: liveSet.setNumber,
    teamAScore: liveSet.teamAScore,
    teamBScore: liveSet.teamBScore,
    setScores
  };
}

function currentLiveSetAfterBracketConfirmation(currentScore: ScoreRow | null, completedSets: SetScore[]) {
  if (!currentScore) return null;
  const maxCompletedSet = Math.max(0, ...completedSets.map((set) => set.setNumber));
  if (currentScore.current_set <= maxCompletedSet) return null;

  const currentSets = dbSetScores(currentScore.set_scores);
  const activeSet = currentSets.find((set) => !set.isComplete && set.setNumber === currentScore.current_set);
  const teamAScore = activeSet?.teamAScore ?? Number(currentScore.team_a_score ?? 0);
  const teamBScore = activeSet?.teamBScore ?? Number(currentScore.team_b_score ?? 0);
  if (teamAScore <= 0 && teamBScore <= 0) return null;

  return {
    setNumber: currentScore.current_set,
    teamAScore,
    teamBScore,
    isComplete: false
  };
}

function dbSetScores(value: unknown): SetScore[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const setNumber = Number(record.setNumber ?? record.set_number);
      const teamAScore = Number(record.teamAScore ?? record.team_a_score);
      const teamBScore = Number(record.teamBScore ?? record.team_b_score);
      if (!Number.isFinite(setNumber) || !Number.isFinite(teamAScore) || !Number.isFinite(teamBScore)) return null;
      return {
        setNumber,
        teamAScore,
        teamBScore,
        isComplete: record.isComplete === true || record.is_complete === true
      };
    })
    .filter((set): set is SetScore => Boolean(set))
    .sort((a, b) => a.setNumber - b.setNumber);
}

function shouldAdvanceInactiveScheduledMatch(
  currentScore: ScoreRow | null,
  snapshot: ReturnType<typeof normalizeScorePayload>,
  currentMatch: MatchRow,
  nextMatch: MatchRow,
  now: string
) {
  if (hasVisibleProgress(currentScore, snapshot)) return false;

  const currentStart = scheduledTimestamp(currentMatch);
  const nextStart = scheduledTimestamp(nextMatch);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || !Number.isFinite(nextStart)) return false;
  if (nowMs < nextStart) return false;

  if (Number.isFinite(currentStart) && nextStart <= currentStart) return false;
  return true;
}

function hasVisibleProgress(currentScore: ScoreRow | null, snapshot: ReturnType<typeof normalizeScorePayload>) {
  const scoreProgress = Boolean(currentScore)
    && (
      currentScore!.team_a_score > 0
      || currentScore!.team_b_score > 0
      || currentScore!.team_a_sets > 0
      || currentScore!.team_b_sets > 0
      || (Array.isArray(currentScore!.set_scores) && currentScore!.set_scores.length > 0)
      || currentScore!.status.toLowerCase().includes("final")
      || currentScore!.status.toLowerCase().includes("complete")
    );
  const snapshotProgress = snapshot.teamAScore > 0
    || snapshot.teamBScore > 0
    || snapshot.teamASets > 0
    || snapshot.teamBSets > 0
    || snapshot.setScores.length > 0
    || snapshot.status.toLowerCase().includes("final")
    || snapshot.status.toLowerCase().includes("complete");
  return scoreProgress || snapshotProgress;
}

function scheduledTimestamp(match: MatchRow | null | undefined) {
  if (!match?.scheduled_time || !match.scheduled_date) return NaN;
  const date = match.scheduled_date.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  const time = match.scheduled_time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!date || !time) return NaN;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return NaN;
  const suffix = time[3].toUpperCase();
  if (suffix === "PM" && hour !== 12) hour += 12;
  if (suffix === "AM" && hour === 12) hour = 0;
  const [year, month, day] = date.split("-").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  return localAsUtc - timeZoneOffsetMs(new Date(localAsUtc), EVENT_TIME_ZONE);
}

function setsToWin(format: Record<string, unknown> | null | undefined) {
  const explicitSetsToWin = Number(format?.setsToWin);
  if (Number.isFinite(explicitSetsToWin) && explicitSetsToWin > 0) {
    return Math.trunc(explicitSetsToWin);
  }

  const bestOf = Number(format?.bestOf);
  const safeBestOf = Number.isFinite(bestOf) && bestOf > 0 ? Math.trunc(bestOf) : 3;
  return Math.max(1, Math.ceil(safeBestOf / 2));
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const value = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  const match = value?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * ((Number(match[2]) * 60 + Number(match[3])) * 60_000);
}

async function nextQueuedMatch(courtId: string) {
  const db = supabaseAdmin();
  const { data: active } = await db
    .from("court_match_queue")
    .select("*, matches:match_id(*)")
    .eq("court_id", courtId)
    .eq("is_active", true)
    .maybeSingle();
  const basePosition = Number(active?.queue_position ?? 0);
  const { data, error } = await db
    .from("court_match_queue")
    .select("*, matches:match_id(*)")
    .eq("court_id", courtId)
    .eq("status", "queued")
    .order("queue_position", { ascending: true })
    .limit(50);
  if (error) throw error;
  const activeSourceUrls = await activeVblSourceUrlsForCourtEvent(db, active?.event_id ?? (data ?? [])[0]?.event_id);
  const queued = (await closeFinalQueuedMatches(db, (data ?? []) as QueueRow[]))
    .filter((queue) => matchBelongsToActiveVblSource(firstRelation(queue.matches), activeSourceUrls));
  const activeMatch = firstRelation((active as QueueRow | null)?.matches);
  const activeStart = scheduledTimestamp(activeMatch);
  const nextBySchedule = Number.isFinite(activeStart)
    ? queued
      .map((queue) => ({ queue, startsAt: scheduledTimestamp(firstRelation(queue.matches)) }))
      .filter((item) => Number.isFinite(item.startsAt) && item.startsAt > activeStart)
      .sort((a, b) => a.startsAt - b.startsAt || a.queue.queue_position - b.queue.queue_position)[0]?.queue
    : null;
  if (nextBySchedule) return nextBySchedule;
  return queued.find((queue) => queue.queue_position > basePosition) ?? queued[0] ?? null;
}

async function activeVblSourceUrlsForCourtEvent(db: ReturnType<typeof supabaseAdmin>, eventId: unknown) {
  if (typeof eventId !== "string" || !eventId) return new Set<string>();
  const { data, error } = await db
    .from("bracket_sources")
    .select("source_url")
    .eq("event_id", eventId);
  if (error) throw error;
  return buildActiveVblSourceSet((data ?? []).map((source) => source.source_url));
}

async function closeFinalQueuedMatches(db: ReturnType<typeof supabaseAdmin>, queued: QueueRow[]) {
  const finalQueued = queued.filter((queue) => {
    const match = firstRelation(queue.matches);
    return Boolean(match && normalizeVblBracketPayload(match.source_payload, match)?.status.toLowerCase().includes("final"));
  });
  if (!finalQueued.length) return queued;

  const now = new Date().toISOString();
  const finalIds = finalQueued.map((queue) => queue.id);
  const { error } = await db
    .from("court_match_queue")
    .update({ is_active: false, status: "finished", updated_at: now })
    .in("id", finalIds);
  if (error) throw error;

  const finalIdSet = new Set(finalIds);
  return queued.filter((queue) => !finalIdSet.has(queue.id));
}

async function activateQueuedMatch(court: CourtRow, next: QueueRow) {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  await db
    .from("court_match_queue")
    .update({ is_active: false, status: "finished", updated_at: now })
    .eq("court_id", court.id)
    .eq("is_active", true);

  const { error: queueError } = await db
    .from("court_match_queue")
    .update({ is_active: true, status: "active", updated_at: now })
    .eq("id", next.id);
  if (queueError) throw queueError;

  const match = firstRelation(next.matches);
  const { data: updatedCourt, error: courtError } = await db
    .from("courts")
    .update({
      current_match_id: next.match_id,
      status: "waiting",
      frozen: false,
      last_update_at: now,
      updated_at: now
    })
    .eq("id", court.id)
    .select("*")
    .single();
  if (courtError) throw courtError;

  const state = defaultManualState();
  await persistScoreAndOverlay(updatedCourt, match ?? null, {
    court_id: updatedCourt.id,
    match_id: next.match_id,
    team_a_score: state.team_a_score,
    team_b_score: state.team_b_score,
    team_a_sets: state.team_a_sets,
    team_b_sets: state.team_b_sets,
    current_set: state.current_set,
    set_scores: state.set_scores,
    serving_team: null,
    timeouts: {},
    status: "Pre-Match",
    source: match?.source_type === "manual" || !match?.api_url ? "manual" : "api",
    source_available: false,
    source_priority: "fallback",
    source_pending_scores: [],
    stale: false,
    message: match?.source_type === "manual" || !match?.api_url ? null : "VolleyballLife match assigned; waiting for live scoring.",
    last_api_poll_at: now,
    last_score_change_at: now,
    updated_at: now
  });
}

async function releaseDueDelayedVblScore(court: CourtRow, match: MatchRow, currentScore: ScoreRow | null) {
  if (!currentScore) return null;
  const now = new Date().toISOString();
  const pendingForCurrentMatch = pendingScoresForMatch(currentScore.source_pending_scores, match.id);
  const { latestDue, remaining } = splitDueDelayedVblScores(pendingForCurrentMatch, now);
  if (!latestDue) return null;
  if (shouldHoldDelayedFinalScore(latestDue, remaining, now)) {
    return currentScore;
  }

  const isSameVisibleScore = delayedScoreMatchesVisibleScore(latestDue.score, currentScore);
  if (!isSameVisibleScore && isDelayedScoreBehindVisible(latestDue.score, currentScore)) {
    await supabaseAdmin().from("score_states").update({
      source_pending_scores: remaining,
      stale: false,
      last_api_poll_at: now,
      updated_at: now
    }).eq("court_id", court.id);
    return currentScore;
  }

  const { score } = await persistScoreAndOverlay(court, match, {
    court_id: court.id,
    match_id: latestDue.score.match_id,
    team_a_score: latestDue.score.team_a_score,
    team_b_score: latestDue.score.team_b_score,
    team_a_sets: latestDue.score.team_a_sets,
    team_b_sets: latestDue.score.team_b_sets,
    current_set: latestDue.score.current_set,
    set_scores: latestDue.score.set_scores,
    serving_team: latestDue.score.serving_team,
    status: latestDue.score.status,
    source: "api",
    source_available: true,
    source_priority: "primary",
    source_pending_scores: remaining,
    stale: false,
    message: remaining.length ? "VolleyballLife live scoring active." : null,
    last_api_poll_at: now,
    last_score_change_at: isSameVisibleScore ? currentScore.last_score_change_at ?? now : now,
    updated_at: now
  });
  return score as ScoreRow;
}

function delayedScoreMatchesVisibleScore(delayed: DelayedVblScorePayload, visible: ScoreRow) {
  return delayed.match_id === visible.match_id
    && delayed.team_a_score === visible.team_a_score
    && delayed.team_b_score === visible.team_b_score
    && delayed.team_a_sets === visible.team_a_sets
    && delayed.team_b_sets === visible.team_b_sets
    && delayed.current_set === visible.current_set
    && delayed.status === visible.status
    && delayed.serving_team === visible.serving_team
    && JSON.stringify(delayed.set_scores) === JSON.stringify(visible.set_scores ?? []);
}

async function queueLiveVblScore(court: CourtRow, match: MatchRow, currentScore: ScoreRow | null, snapshot: ReturnType<typeof normalizeScorePayload>, now: string) {
  if (VBL_OVERLAY_DELAY_MS <= 0) {
    await persistImmediateVblScore(court, match, currentScore, snapshot, now);
    return;
  }

  const pendingScore = delayedScoreFromSnapshot(match.id, snapshot, now);
  const pendingForCurrentMatch = pendingScoresForMatch(currentScore?.source_pending_scores, match.id);
  const pending = queueDelayedVblScore(pendingForCurrentMatch, currentScore, pendingScore)
    .filter((item) => !isDelayedScoreBehindVisible(item.score, currentScore));

  if (!currentScore) {
    await persistScoreAndOverlay(court, match, {
      court_id: court.id,
      match_id: match.id,
      team_a_score: 0,
      team_b_score: 0,
      team_a_sets: 0,
      team_b_sets: 0,
      current_set: snapshot.currentSet,
      set_scores: [],
      serving_team: null,
      status: snapshot.status,
      source: "api",
      source_available: true,
      source_priority: "primary",
      source_pending_scores: pending,
      stale: false,
      message: "VolleyballLife live scoring active.",
      last_api_poll_at: now,
      last_score_change_at: now,
      updated_at: now
    });
    return;
  }

  await supabaseAdmin().from("score_states").update({
    match_id: match.id,
    source: "api",
    source_available: true,
    source_priority: "primary",
    source_pending_scores: pending,
    stale: false,
    message: pending.length ? "VolleyballLife live scoring active." : null,
    last_api_poll_at: now,
    updated_at: now
  }).eq("court_id", court.id);
}

async function persistImmediateVblScore(court: CourtRow, match: MatchRow, currentScore: ScoreRow | null, snapshot: ReturnType<typeof normalizeScorePayload>, now: string) {
  const immediate = delayedScoreFromSnapshot(match.id, snapshot, now, 0).score;
  const isSameVisibleScore = currentScore ? delayedScoreMatchesVisibleScore(immediate, currentScore) : false;
  if (!isSameVisibleScore && currentScore && isDelayedScoreBehindVisible(immediate, currentScore)) {
    await supabaseAdmin().from("score_states").update({
      match_id: match.id,
      source: "api",
      source_available: true,
      source_priority: "primary",
      source_pending_scores: [],
      stale: false,
      message: null,
      last_api_poll_at: now,
      updated_at: now
    }).eq("court_id", court.id);
    return;
  }

  await persistScoreAndOverlay(court, match, {
    court_id: court.id,
    match_id: immediate.match_id,
    team_a_score: immediate.team_a_score,
    team_b_score: immediate.team_b_score,
    team_a_sets: immediate.team_a_sets,
    team_b_sets: immediate.team_b_sets,
    current_set: immediate.current_set,
    set_scores: immediate.set_scores,
    serving_team: immediate.serving_team,
    status: immediate.status,
    source: "api",
    source_available: true,
    source_priority: "primary",
    source_pending_scores: [],
    stale: false,
    message: null,
    last_api_poll_at: now,
    last_score_change_at: isSameVisibleScore ? currentScore?.last_score_change_at ?? now : now,
    updated_at: now
  });
}

async function persistFallbackSnapshot(court: CourtRow, match: MatchRow, snapshot: ReturnType<typeof normalizeScorePayload>, now: string) {
  await persistScoreAndOverlay(court, match, {
    court_id: court.id,
    match_id: match.id,
    team_a_score: snapshot.teamAScore,
    team_b_score: snapshot.teamBScore,
    team_a_sets: snapshot.teamASets,
    team_b_sets: snapshot.teamBSets,
    current_set: snapshot.currentSet,
    set_scores: snapshot.setScores,
    serving_team: snapshot.servingTeam ?? null,
    status: snapshot.status,
    source: snapshot.source,
    source_available: false,
    source_priority: "fallback",
    source_pending_scores: [],
    stale: false,
    message: "VolleyballLife feed connected; waiting for live score.",
    last_api_poll_at: now,
    last_score_change_at: now,
    updated_at: now
  });
}

function hasFutureDelayedVblScore(score: ScoreRow | null, now: string) {
  if (!score) return false;
  const matchId = score.match_id;
  if (!matchId) return false;
  return splitDueDelayedVblScores(pendingScoresForMatch(score.source_pending_scores, matchId), now)
    .remaining
    .some((item) => !delayedScoreMatchesVisibleScore(item.score, score));
}

async function touchApiPoll(courtId: string, now: string, sourceAvailable: boolean, message: string) {
  await supabaseAdmin().from("score_states").update({
    source_available: sourceAvailable,
    source_priority: sourceAvailable ? "primary" : "fallback",
    stale: false,
    message,
    last_api_poll_at: now,
    updated_at: now
  }).eq("court_id", courtId);
}

async function markApiFallbackActive(courtId: string, now: string, message: string) {
  await supabaseAdmin().from("score_states").update({
    source_available: false,
    source_priority: "fallback",
    stale: false,
    message,
    last_api_poll_at: now,
    updated_at: now
  }).eq("court_id", courtId);
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
  const currentScore = scoreForCurrentMatch(court.score_states, match?.id);
  if (currentScore?.source === "manual") {
    await db.from("score_states").update({
      source_available: false,
      source_priority: "fallback",
      stale: false,
      message: "VolleyballLife unavailable; manual score active.",
      last_api_poll_at: now,
      updated_at: now
    }).eq("court_id", court.id);
    await db.from("poller_errors").insert({
      event_id: court.event_id,
      court_id: court.id,
      match_id: match?.id ?? null,
      source_url: match?.api_url ?? null,
      message,
      payload: { courtNumber: court.court_number, fallback: "manual" }
    });
    return;
  }
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
      source_available: false,
      source_priority: "fallback",
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

  const overlay = await buildOverlayStateWithEventSettings(
    updatedCourt ?? { ...court, status: "error", last_update_at: now },
    match ?? null,
    staleScore ?? null
  );
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
