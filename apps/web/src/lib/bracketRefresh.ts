import { defaultManualState } from "./manualScoring";
import { getEnv } from "./env";
import { persistVblBracketProgressIfAvailable } from "./poller";
import { eventTimeZone, scheduledTimestamp } from "./scheduleTime";
import { buildOverlayStateWithEventSettings, persistScoreAndOverlay, scoreForCurrentMatch } from "./scoreState";
import type { CourtRecord, MatchRecord, ScoreRecord } from "./scoreState";
import { supabaseAdmin } from "./supabase";
import { discoverMatchesFromUrl } from "./vbl";
import { buildActiveVblSourceSet, matchBelongsToActiveVblSource } from "./vblSources";

type BracketProgressCourt = Parameters<typeof persistVblBracketProgressIfAvailable>[0];
type BracketProgressMatch = Parameters<typeof persistVblBracketProgressIfAvailable>[1];
type BracketProgressScore = Parameters<typeof persistVblBracketProgressIfAvailable>[2];

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
  bracket_url?: string | null;
  court_number?: string | null;
  scheduled_date?: string | null;
  scheduled_time?: string | null;
  source_payload?: Record<string, unknown> | null;
};

type CourtRow = CourtRecord & {
  current_match_id: string | null;
  vbl_court_number?: string | null;
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

type ExistingMatchTeams = {
  api_url: string | null;
  team_a?: string | null;
  team_b?: string | null;
  team_a_seed?: string | null;
  team_b_seed?: string | null;
};

export type BracketRefreshResult = {
  discovered: number;
  queued: number;
  activated: number;
  moved: number;
  unmapped: number;
  retiredInactiveSources: number;
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
  let retiredInactiveSources = 0;
  let refreshedActiveOverlays = 0;
  const unmappedCourts = new Set<string>();
  const errors: string[] = [];
  const activeSourceUrls = buildActiveVblSourceSet(((sources ?? []) as BracketSourceRow[]).map((source) => source.source_url));

  retiredInactiveSources += await retireInactiveVblSourceQueues(eventId, activeSourceUrls);

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
        const { data: existingMatches, error: existingMatchError } = await db
          .from("matches")
          .select("*")
          .eq("event_id", eventId)
          .in("api_url", rows.map((row) => row.api_url));
        if (existingMatchError) throw existingMatchError;
        const existingByApiUrl = new Map(((existingMatches ?? []) as Array<ExistingMatchTeams & Record<string, unknown>>).map((row) => [row.api_url, row]));
        const mergedRows = rows.map((row) => mergeDiscoveredTeamFields(row, existingByApiUrl.get(row.api_url)));
        const changedRows = mergedRows.filter((row) => matchDiscoveryChanged(row, existingByApiUrl.get(row.api_url)));
        const saved = changedRows.length
          ? await upsertDiscoveredMatches(db, changedRows)
          : [];
        const savedByApiUrl = new Map(saved.map((row) => [cleanText(row.api_url), row]));
        const effectiveMatches = mergedRows.map((row) => savedByApiUrl.get(cleanText(row.api_url)) ?? {
          ...existingByApiUrl.get(row.api_url),
          ...row
        });
        const queueResult = await autoQueueDiscoveredMatches(eventId, effectiveMatches);
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

  await normalizeEventQueueOrder(eventId, activeSourceUrls);
  return { discovered, queued, activated, moved, unmapped, retiredInactiveSources, refreshedActiveOverlays, unmappedCourts: [...unmappedCourts].sort(compareCourtLabels), errors };
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
        const vacatesCurrentMatch = await courtShowsMatch(previousCourtId, matchId);
        const { error: unmapError } = await db
          .from("court_match_queue")
          .update({ is_active: false, status: "unmapped", updated_at: now })
          .eq("id", existingQueue.id);
        if (unmapError) throw unmapError;
        if (existingQueue.is_active || vacatesCurrentMatch) {
          const activated = await activateBestMatchForCourt(previousCourtId);
          if (!activated) await idleVacatedCourt(previousCourtId, [matchId]);
        }
        unmapped += 1;
      }
      unmappedCourts.add(vblCourtNumber);
      continue;
    }

    if (existingQueue) {
      if (!isFinishedQueue(existingQueue) && existingQueue.court_id !== court.id) {
        const previousCourtId = existingQueue.court_id;
        const vacatesCurrentMatch = await courtShowsMatch(previousCourtId, matchId);
        await moveQueueToCourt(existingQueue, court.id, now);
        await activateBestMatchForCourt(court.id, { preserveValidActive: true });
        if (existingQueue.is_active || vacatesCurrentMatch) {
          const activated = await activateBestMatchForCourt(previousCourtId);
          if (!activated) await idleVacatedCourt(previousCourtId, [matchId]);
        }
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
        const { score: savedScore } = await persistScoreAndOverlay(updatedCourt, match as Parameters<typeof persistScoreAndOverlay>[1], {
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
        await persistVblBracketProgressIfAvailable(
          updatedCourt as BracketProgressCourt,
          match as BracketProgressMatch,
          savedScore as BracketProgressScore
        );
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

async function activateBestMatchForCourt(courtId: string, options: { preserveValidActive?: boolean; activeSourceUrls?: Set<string> } = {}) {
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
    .filter((queue) => matchBelongsToActiveVblSource(firstRelation(queue.matches), options.activeSourceUrls ?? new Set()))
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
  const { score: savedScore } = await persistScoreAndOverlay(court, match, score ? {
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
  await persistVblBracketProgressIfAvailable(
    court as BracketProgressCourt,
    match as BracketProgressMatch,
    savedScore as BracketProgressScore
  );
  return true;
}

async function normalizeEventQueueOrder(eventId: string, activeSourceUrls: Set<string> = new Set()) {
  const db = supabaseAdmin();
  const { data: event, error: eventError } = await db
    .from("events")
    .select("settings")
    .eq("id", eventId)
    .maybeSingle();
  if (eventError) throw eventError;
  const timeZone = eventTimeZone(recordValue(event?.settings), getEnv().timezone);

  const { data: courts, error: courtError } = await db
    .from("courts")
    .select("*")
    .eq("event_id", eventId)
    .order("court_number", { ascending: true });
  if (courtError) throw courtError;

  for (const court of (courts ?? []) as CourtRow[]) {
    const { data: queues, error: queueError } = await db
      .from("court_match_queue")
      .select("id,event_id,court_id,match_id,queue_position,status,is_active,matches:match_id(*)")
      .eq("court_id", court.id)
      .neq("status", "finished")
      .order("queue_position", { ascending: true });
    if (queueError) throw queueError;

    const validQueues = ((queues ?? []) as QueueRow[])
      .filter((queue) => queue.status !== "unmapped")
      .filter((queue) => matchBelongsToActiveVblSource(firstRelation(queue.matches), activeSourceUrls))
      .filter((queue) => cleanText(firstRelation(queue.matches)?.court_number) === cleanText(court.vbl_court_number))
      .sort((a, b) => scheduleSortTimestamp(firstRelation(a.matches), timeZone) - scheduleSortTimestamp(firstRelation(b.matches), timeZone)
        || Number(a.queue_position ?? 0) - Number(b.queue_position ?? 0));

    if (!validQueues.length) continue;

    const active = validQueues.find((queue) => queue.is_active);
    const desired = validQueues[0];
    if (active?.id === desired.id) continue;
    if (active && await queueHasVisibleScore(active)) continue;
    await activateQueueForCourt(court, desired);
  }
}

async function retireInactiveVblSourceQueues(eventId: string, activeSourceUrls: Set<string>) {
  if (!activeSourceUrls.size) return 0;

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("court_match_queue")
    .select("id,event_id,court_id,match_id,queue_position,status,is_active,matches:match_id(*)")
    .eq("event_id", eventId)
    .neq("status", "finished");
  if (error) throw error;

  const inactiveQueues = ((data ?? []) as QueueRow[])
    .filter((queue) => !matchBelongsToActiveVblSource(firstRelation(queue.matches), activeSourceUrls));
  if (!inactiveQueues.length) return 0;

  const now = new Date().toISOString();
  const queueIds = inactiveQueues.map((queue) => queue.id);
  const retiredMatchIds = inactiveQueues
    .map((queue) => cleanText(queue.match_id))
    .filter((value): value is string => Boolean(value));
  const activeCourtIds = [...new Set(inactiveQueues.filter((queue) => queue.is_active).map((queue) => queue.court_id))];

  const { error: retireError } = await db
    .from("court_match_queue")
    .update({ is_active: false, status: "finished", updated_at: now })
    .in("id", queueIds);
  if (retireError) throw retireError;

  for (const courtId of activeCourtIds) {
    const activated = await activateBestMatchForCourt(courtId, { preserveValidActive: true, activeSourceUrls });
    if (!activated) {
      await idleVacatedCourt(courtId, retiredMatchIds);
    }
  }

  return inactiveQueues.length;
}

async function courtShowsMatch(courtId: string, matchId: string) {
  const { data, error } = await supabaseAdmin()
    .from("courts")
    .select("current_match_id")
    .eq("id", courtId)
    .maybeSingle();
  if (error) throw error;
  return data?.current_match_id === matchId;
}

async function idleVacatedCourt(courtId: string, vacatedMatchIds: string[]) {
  if (!vacatedMatchIds.length) return false;
  const db = supabaseAdmin();
  const { data: court, error } = await db
    .from("courts")
    .select("*")
    .eq("id", courtId)
    .maybeSingle();
  if (error) throw error;
  if (!court?.current_match_id || !vacatedMatchIds.includes(String(court.current_match_id))) return false;

  const now = new Date().toISOString();
  const { data: clearedCourt, error: clearError } = await db
    .from("courts")
    .update({ current_match_id: null, status: "waiting", last_update_at: now, updated_at: now })
    .eq("id", courtId)
    .select("*")
    .single();
  if (clearError) throw clearError;

  const { error: scoreError } = await db.from("score_states").update({
    match_id: null,
    team_a_score: 0,
    team_b_score: 0,
    team_a_sets: 0,
    team_b_sets: 0,
    current_set: 1,
    set_scores: [],
    serving_team: null,
    status: "Pre-Match",
    source: "api",
    source_available: false,
    source_priority: "fallback",
    source_pending_scores: [],
    stale: false,
    message: "Match reassigned to another court.",
    last_api_poll_at: now,
    last_score_change_at: now,
    updated_at: now
  }).eq("court_id", courtId);
  if (scoreError) throw scoreError;

  const overlay = await buildOverlayStateWithEventSettings(clearedCourt, null, null);
  const { error: overlayError } = await db.from("overlay_states").upsert({
    court_id: courtId,
    event_id: clearedCourt.event_id,
    court_number: clearedCourt.court_number,
    payload: overlay,
    stale: false,
    updated_at: now
  });
  if (overlayError) throw overlayError;
  return true;
}

async function activateQueueForCourt(court: CourtRow, queue: QueueRow) {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  await db
    .from("court_match_queue")
    .update({ is_active: false, status: "queued", updated_at: now })
    .eq("court_id", court.id)
    .eq("is_active", true);

  const { error: activeError } = await db
    .from("court_match_queue")
    .update({ is_active: true, status: "active", updated_at: now })
    .eq("id", queue.id);
  if (activeError) throw activeError;

  const match = firstRelation(queue.matches) as (Parameters<typeof persistScoreAndOverlay>[1] & { source_type?: "vbl" | "manual" | null; api_url?: string | null }) | null;
  const { data: updatedCourt, error: courtError } = await db
    .from("courts")
    .update({
      current_match_id: queue.match_id,
      status: "waiting",
      mode: court.mode === "manual" ? "hybrid" : court.mode,
      updated_at: now
    })
    .eq("id", court.id)
    .select("*")
    .single();
  if (courtError) throw courtError;

  if (!match) return;
  const { data: score } = await db
    .from("score_states")
    .select("*")
    .eq("match_id", match.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const initial = defaultManualState();
  const { score: savedScore } = await persistScoreAndOverlay(updatedCourt, match, score ? {
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
    source: match.source_type === "manual" || !match.api_url ? "manual" : "api",
    source_available: false,
    source_priority: "fallback",
    stale: false,
    message: match.source_type === "manual" || !match.api_url ? null : "VolleyballLife match assigned; waiting for live scoring."
  });
  await persistVblBracketProgressIfAvailable(
    updatedCourt as BracketProgressCourt,
    match as BracketProgressMatch,
    savedScore as BracketProgressScore
  );
}

async function queueHasVisibleScore(queue: QueueRow) {
  const matchId = cleanText(queue.match_id);
  if (!matchId) return false;
  const { data, error } = await supabaseAdmin()
    .from("score_states")
    .select("team_a_score,team_b_score,team_a_sets,team_b_sets,current_set,set_scores,status")
    .eq("match_id", matchId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  return Number(data.team_a_score ?? 0) > 0
    || Number(data.team_b_score ?? 0) > 0
    || Number(data.team_a_sets ?? 0) > 0
    || Number(data.team_b_sets ?? 0) > 0
    || (Array.isArray(data.set_scores) && data.set_scores.length > 0)
    || cleanText(data.status)?.toLowerCase().includes("final") === true
    || cleanText(data.status)?.toLowerCase().includes("complete") === true;
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
    const overlay = await buildOverlayStateWithEventSettings(court, match, score);
    const { error: overlayError } = await db.from("overlay_states").upsert({
      court_id: court.id,
      event_id: court.event_id,
      court_number: court.court_number,
      payload: overlay,
      stale: Boolean(score.stale),
      updated_at: new Date().toISOString()
    });
    if (overlayError) throw overlayError;
    refreshed += 1;
  }
  return refreshed;
}

async function upsertDiscoveredMatches(db: ReturnType<typeof supabaseAdmin>, rows: Record<string, unknown>[]) {
  const { data, error } = await db
    .from("matches")
    .upsert(rows, { onConflict: "event_id,api_url" })
    .select("*");
  if (error) throw error;
  return (data ?? []) as Record<string, unknown>[];
}

export function matchDiscoveryChanged(discovered: Record<string, unknown>, existing: Record<string, unknown> | null | undefined) {
  if (!existing) return true;
  return Object.entries(discovered)
    .filter(([key]) => key !== "updated_at")
    .some(([key, value]) => !discoveryValuesEqual(existing[key], value));
}

function discoveryValuesEqual(left: unknown, right: unknown) {
  if (left === right) return true;
  if ((left == null || right == null) && left !== right) return false;
  if (typeof left === "object" || typeof right === "object") return JSON.stringify(left) === JSON.stringify(right);
  return false;
}

export function mergeDiscoveredTeamFields<T extends { team_a: string | null; team_b: string | null; team_a_seed: string | null; team_b_seed: string | null }>(
  discovered: T,
  existing: Omit<ExistingMatchTeams, "api_url"> | null | undefined
): T {
  if (!existing) return discovered;
  return {
    ...discovered,
    team_a: preferResolvedTeamName(discovered.team_a, existing.team_a),
    team_b: preferResolvedTeamName(discovered.team_b, existing.team_b),
    team_a_seed: discovered.team_a_seed ?? existing.team_a_seed ?? null,
    team_b_seed: discovered.team_b_seed ?? existing.team_b_seed ?? null
  };
}

function preferResolvedTeamName(discovered: string | null, existing: string | null | undefined) {
  const incoming = cleanText(discovered);
  const current = cleanText(existing);
  if (!current || isPlaceholderTeamName(current)) return discovered;
  if (!incoming || isPlaceholderTeamName(incoming)) return current;
  return discovered;
}

function isPlaceholderTeamName(value: string) {
  return /^(TBD|Team A|Team B|Winner|Loser)/i.test(value);
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

function scheduleSortTimestamp(match: MatchRow | null | undefined, timeZone: string) {
  const parsed = scheduledTimestamp(match, timeZone);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
