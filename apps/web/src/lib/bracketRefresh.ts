import { defaultManualState } from "./manualScoring";
import { persistScoreAndOverlay, scoreForCurrentMatch } from "./scoreState";
import type { CourtRecord, MatchRecord, ScoreRecord } from "./scoreState";
import { supabaseAdmin } from "./supabase";
import { discoverMatchesFromUrl } from "./vbl";

type Relation<T> = T | T[] | null | undefined;

type BracketSourceRow = {
  id: string;
  source_url: string;
};

type MatchRow = {
  id: string;
  event_id: string;
  source_type?: "vbl" | "manual" | null;
  api_url?: string | null;
  court_number?: string | null;
  source_payload?: Record<string, unknown> | null;
};

type CourtRow = CourtRecord & {
  current_match_id: string | null;
  matches?: Relation<MatchRecord>;
  score_states?: Relation<ScoreRow>;
};

type ScoreRow = ScoreRecord;

type QueueRow = {
  id: string;
  event_id?: string;
  court_id: string;
  match_id?: string;
  queue_position?: number | null;
  status: string;
  is_active: boolean;
  matches?: Relation<MatchRow>;
};

export type BracketRefreshResult = {
  discovered: number;
  queued: number;
  activated: number;
  moved: number;
  unmapped: number;
  refreshedActiveOverlays: number;
  unmappedCourts: string[];
  errors: string[];
};

export async function refreshEventBracketSources(eventId: string): Promise<BracketRefreshResult> {
  const db = supabaseAdmin();
  const { data: sources, error: sourceError } = await db
    .from("bracket_sources")
    .select("id,source_url")
    .eq("event_id", eventId);
  if (sourceError) throw sourceError;

  let discovered = 0;
  let queued = 0;
  let activated = 0;
  let moved = 0;
  let unmapped = 0;
  let refreshedActiveOverlays = 0;
  const unmappedCourts = new Set<string>();
  const errors: string[] = [];

  for (const source of (sources ?? []) as BracketSourceRow[]) {
    try {
      const matches = await discoverMatchesFromUrl(source.source_url);
      discovered += matches.length;
      if (matches.length) {
        const now = new Date().toISOString();
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
          updated_at: now
        }));
        const { data: savedMatches, error } = await db
          .from("matches")
          .upsert(rows, { onConflict: "event_id,api_url" })
          .select("*");
        if (error) throw error;

        const saved = (savedMatches ?? []) as Record<string, unknown>[];
        const queueResult = await autoQueueDiscoveredMatches(eventId, saved);
        queued += queueResult.queued;
        activated += queueResult.activated;
        moved += queueResult.moved;
        unmapped += queueResult.unmapped;
        queueResult.unmappedCourts.forEach((court) => unmappedCourts.add(court));
        refreshedActiveOverlays += await refreshActiveOverlaysForMatches(eventId, saved);
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

  return { discovered, queued, activated, moved, unmapped, refreshedActiveOverlays, unmappedCourts: [...unmappedCourts].sort(compareCourtLabels), errors };
}

async function autoQueueDiscoveredMatches(eventId: string, matches: Record<string, unknown>[]) {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  let queued = 0;
  let activated = 0;
  let moved = 0;
  let unmapped = 0;
  const unmappedCourts = new Set<string>();
  for (const match of matches) {
    const vblCourtNumber = cleanText(match.court_number);
    const matchId = typeof match.id === "string" ? match.id : null;
    if (!matchId || !vblCourtNumber) continue;

    const { data: existingQueues, error: existingError } = await db
      .from("court_match_queue")
      .select("id,event_id,court_id,match_id,queue_position,status,is_active")
      .eq("event_id", eventId)
      .eq("match_id", matchId);
    if (existingError) throw existingError;
    const existingQueue = (existingQueues ?? [])[0] as QueueRow | undefined;

    const { data: court } = await db
      .from("courts")
      .select("*")
      .eq("event_id", eventId)
      .eq("vbl_court_number", vblCourtNumber)
      .order("court_number", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!court) {
      if (existingQueue && !isFinishedQueue(existingQueue)) {
        const previousCourtId = existingQueue.court_id;
        const { error: unmapError } = await db
          .from("court_match_queue")
          .update({ is_active: false, status: "unmapped", updated_at: now })
          .eq("id", existingQueue.id);
        if (unmapError) throw unmapError;
        if (existingQueue.is_active) {
          await activateBestMatchForCourt(previousCourtId);
        }
        unmapped += 1;
      }
      unmappedCourts.add(vblCourtNumber);
      continue;
    }

    if (existingQueue) {
      if (!isFinishedQueue(existingQueue) && existingQueue.court_id !== court.id) {
        const previousCourtId = existingQueue.court_id;
        await moveQueueToCourt(existingQueue, court.id, now);
        if (existingQueue.is_active) {
          await activateBestMatchForCourt(previousCourtId);
        }
        await activateBestMatchForCourt(court.id, { preserveValidActive: true });
        moved += 1;
      } else if (existingQueue.status === "unmapped") {
        const { error: remapError } = await db
          .from("court_match_queue")
          .update({ status: "queued", is_active: false, updated_at: now })
          .eq("id", existingQueue.id);
        if (remapError) throw remapError;
        await activateBestMatchForCourt(court.id, { preserveValidActive: true });
      }
      continue;
    }

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
    const activeMatch = firstRelation(active?.matches) as MatchRow | null;
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
  return { queued, activated, moved, unmapped, unmappedCourts: [...unmappedCourts] };
}

async function moveQueueToCourt(queue: QueueRow, targetCourtId: string, now: string) {
  const db = supabaseAdmin();
  const { data: lastTargetQueue, error: lastError } = await db
    .from("court_match_queue")
    .select("queue_position")
    .eq("court_id", targetCourtId)
    .order("queue_position", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;

  const { error: moveError } = await db
    .from("court_match_queue")
    .update({
      court_id: targetCourtId,
      queue_position: Number(lastTargetQueue?.queue_position ?? 0) + 1,
      status: "queued",
      is_active: false,
      updated_at: now
    })
    .eq("id", queue.id);
  if (moveError) throw moveError;
}

async function activateBestMatchForCourt(courtId: string, options: { preserveValidActive?: boolean } = {}) {
  const db = supabaseAdmin();
  const { data: court, error: courtError } = await db
    .from("courts")
    .select("*")
    .eq("id", courtId)
    .maybeSingle();
  if (courtError) throw courtError;
  if (!court) return false;

  const { data: queues, error: queueError } = await db
    .from("court_match_queue")
    .select("id,event_id,court_id,match_id,queue_position,status,is_active,matches:match_id(*)")
    .eq("court_id", courtId)
    .order("queue_position", { ascending: true });
  if (queueError) throw queueError;

  const validQueues = ((queues ?? []) as QueueRow[])
    .filter((queue) => !isFinishedQueue(queue) && queue.status !== "unmapped")
    .filter((queue) => cleanText(firstRelation(queue.matches)?.court_number) === cleanText(court.vbl_court_number));
  const currentActive = validQueues.find((queue) => queue.is_active);
  const chosen = options.preserveValidActive && currentActive ? currentActive : validQueues[0];

  if (!chosen) {
    await db
      .from("court_match_queue")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("court_id", courtId)
      .eq("is_active", true);
    return false;
  }

  const now = new Date().toISOString();
  await db
    .from("court_match_queue")
    .update({ is_active: false, status: "queued", updated_at: now })
    .eq("court_id", courtId)
    .eq("is_active", true);

  const { error: activeError } = await db
    .from("court_match_queue")
    .update({ is_active: true, status: "active", updated_at: now })
    .eq("id", chosen.id);
  if (activeError) throw activeError;

  const match = firstRelation(chosen.matches) as Parameters<typeof persistScoreAndOverlay>[1] | null;
  if (!match) return false;

  const { error: updateCourtError } = await db
    .from("courts")
    .update({
      current_match_id: match.id,
      status: "waiting",
      mode: court.mode === "manual" ? "hybrid" : court.mode,
      updated_at: now
    })
    .eq("id", court.id);
  if (updateCourtError) throw updateCourtError;

  const { data: score } = await db
    .from("score_states")
    .select("*")
    .eq("match_id", match.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const initial = defaultManualState();
  await persistScoreAndOverlay(court, match, score ? {
    court_id: court.id,
    match_id: match.id,
    team_a_score: Number(score.team_a_score ?? 0),
    team_b_score: Number(score.team_b_score ?? 0),
    team_a_sets: Number(score.team_a_sets ?? 0),
    team_b_sets: Number(score.team_b_sets ?? 0),
    current_set: Number(score.current_set ?? 1),
    set_scores: Array.isArray(score.set_scores) ? score.set_scores : [],
    serving_team: score.serving_team ?? null,
    timeouts: score.timeouts ?? {},
    status: cleanText(score.status) ?? "Pre-Match",
    source: score.source === "manual" || score.source === "override" ? score.source : "api",
    source_available: Boolean(score.source_available),
    source_priority: score.source_priority ?? "fallback",
    source_pending_scores: score.source_pending_scores ?? [],
    stale: Boolean(score.stale),
    message: score.message ?? null,
    last_api_poll_at: score.last_api_poll_at ?? null,
    last_score_change_at: score.last_score_change_at ?? null
  } : {
    court_id: court.id,
    match_id: match.id,
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
  return true;
}

async function refreshActiveOverlaysForMatches(eventId: string, matches: Record<string, unknown>[]) {
  const matchIds = matches.map((match) => match.id).filter((id): id is string => typeof id === "string");
  if (!matchIds.length) return 0;

  const db = supabaseAdmin();
  const { data: courts, error } = await db
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("event_id", eventId)
    .in("current_match_id", matchIds);
  if (error) throw error;

  let refreshed = 0;
  for (const court of (courts ?? []) as CourtRow[]) {
    const match = firstRelation(court.matches) as Parameters<typeof persistScoreAndOverlay>[1] | null;
    const score = scoreForCurrentMatch(court.score_states, match?.id) as ScoreRow | null;
    if (!match || !score) continue;
    await persistScoreAndOverlay(court, match, {
      court_id: score.court_id,
      match_id: score.match_id,
      team_a_score: score.team_a_score,
      team_b_score: score.team_b_score,
      team_a_sets: score.team_a_sets,
      team_b_sets: score.team_b_sets,
      current_set: score.current_set,
      set_scores: score.set_scores,
      serving_team: score.serving_team,
      timeouts: score.timeouts,
      status: score.status,
      source: score.source,
      source_available: Boolean(score.source_available),
      source_priority: score.source_priority ?? undefined,
      source_pending_scores: score.source_pending_scores,
      stale: Boolean(score.stale),
      message: score.message ?? null,
      last_api_poll_at: score.last_api_poll_at ?? null,
      last_score_change_at: score.last_score_change_at ?? null,
      updated_at: score.updated_at ?? null
    });
    refreshed += 1;
  }
  return refreshed;
}

function cleanText(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function isFinishedQueue(queue: QueueRow) {
  return queue.status === "finished";
}

function compareCourtLabels(a: string, b: string) {
  return Number(a) - Number(b) || a.localeCompare(b);
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
