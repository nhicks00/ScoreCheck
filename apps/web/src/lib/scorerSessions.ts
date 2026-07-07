import { NextRequest } from "next/server";
import { fanScoringSettings, getCourtByNumber, getEventBySlug, resolveCourtIdentifier, type CourtRow, type EventRow } from "./eventConfig";
import { getEnv, requestOrigin } from "./env";
import { checkRateLimit } from "./rateLimit";
import {
  defaultBeachFormat,
  emptyScoreState,
  forceCompleteMatch,
  forceCompleteSet,
  formatFromUnknown,
  normalizeScoreState,
  scorePoint,
  validateManualCorrection,
  type ScoreState
} from "./scoringRules";
import { persistScoreAndOverlay, scoreForCurrentMatch } from "./scoreState";
import { hashToken, requestIpHash, safeDisplayName, userAgent } from "./security";
import { apiScoreHasPriority } from "./sourcePriority";
import { supabaseAdmin } from "./supabase";
import { videoConfigured } from "./video";
import crypto from "node:crypto";

export type WatchMode = "website" | "courtside";
export type ScorerRole = "active" | "backup" | "waiting";
export type SessionActionType =
  | "POINT_A"
  | "POINT_B"
  | "UNDO"
  | "SET_COMPLETE"
  | "MATCH_COMPLETE"
  | "MANUAL_CORRECTION"
  | "HANDOFF_USE_OFFICIAL"
  | "HANDOFF_USE_SHADOW"
  | "SCORE_CHECK_KEEP_OFFICIAL"
  | "SCORE_CHECK_USE_BACKUP"
  | "SERVE_A"
  | "SERVE_B"
  | "TIMEOUT_A"
  | "TIMEOUT_B"
  | "RELEASE";

const ACTIVE_SCORING_IDLE_MS = 20_000;
const RECENT_BACKUP_ACTIVITY_MS = 90_000;

type Relation<T> = T | T[] | null | undefined;

export type ClaimRow = {
  id: string;
  event_id: string;
  court_id: string;
  match_id: string | null;
  display_name: string;
  status: "pending" | "verified" | "assigned" | "expired" | "cancelled" | "failed";
  assigned_role: ScorerRole | null;
  assigned_session_id: string | null;
  watch_mode?: WatchMode;
  expires_at: string;
};

export type SessionRow = {
  id: string;
  event_id: string;
  court_id: string;
  match_id: string | null;
  claim_id: string | null;
  role: ScorerRole;
  status: "active" | "stale" | "released" | "revoked" | "promoted" | "ended";
  session_token_hash: string;
  display_name: string;
  priority_score: number;
  last_heartbeat_at: string | null;
  lease_expires_at: string | null;
  last_action_at: string | null;
  watch_mode: WatchMode;
  joined_at: string;
  promoted_at: string | null;
};

type MatchRow = {
  id: string;
  event_id: string;
  source_type?: "vbl" | "manual" | null;
  api_url?: string | null;
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

type ScoreRow = {
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
  stale?: boolean | null;
};

type CourtFlagRow = {
  id: string;
  event_id: string;
  court_id: string;
  match_id: string | null;
  severity: "info" | "warning" | "critical";
  status: "open" | "acknowledged" | "resolved";
  type: string;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
};

type CourtContext = CourtRow & {
  matches?: Relation<MatchRow>;
  score_states?: Relation<ScoreRow>;
};

export async function startClaim(input: {
  req: NextRequest;
  eventSlug: string;
  courtNumber: number;
  displayName: string;
  watchMode: WatchMode;
}) {
  const db = supabaseAdmin();
  const ipHash = requestIpHash(input.req);
  if (!checkRateLimit(`claim-start:${input.courtNumber}:${ipHash}`, 10, 10 * 60_000)) {
    return { ok: false as const, status: 429, error: "Too many claim attempts. Try again in a few minutes." };
  }

  const event = await getEventBySlug(input.eventSlug, db);
  if (!event) return { ok: false as const, status: 404, error: "Event is not ready yet." };
  const court = await getCourtByNumber(event.id, input.courtNumber, db);
  if (!court) return { ok: false as const, status: 404, error: "Court not found." };
  if (court.scoring_open === false) return { ok: false as const, status: 403, error: "Scoring is closed for this court." };

  const displayName = safeDisplayName(input.displayName);
  const settings = fanScoringSettings(event);
  const expiresAt = new Date(Date.now() + settings.claimExpirationMinutes * 60_000).toISOString();
  const { data: claim, error } = await db
    .from("scorer_claims")
    .insert({
      event_id: event.id,
      court_id: court.id,
      match_id: court.current_match_id,
      display_name: displayName,
      status: "verified",
      watch_mode: input.watchMode,
      ip_hash: ipHash,
      user_agent: userAgent(input.req),
      expires_at: expiresAt
    })
    .select("*")
    .single();
  if (error) return { ok: false as const, status: 500, error: error.message };

  await logSessionEvent({
    eventId: event.id,
    courtId: court.id,
    matchId: court.current_match_id,
    type: "claim_started",
    payload: { claimId: claim.id, displayName, watchMode: input.watchMode }
  });

  const assigned = await assignSessionForClaim(claim as ClaimRow, requestUrlOrigin(input.req));
  if (!assigned.ok) return assigned;

  return {
    ok: true as const,
    claimId: claim.id as string,
    role: assigned.role,
    sessionUrl: assigned.sessionUrl,
    message: "Opening scorer page..."
  };
}

function requestUrlOrigin(req: NextRequest): string | undefined {
  try {
    return new URL(req.url).origin;
  } catch {
    return undefined;
  }
}

export async function assignSessionForClaim(claim: ClaimRow, origin?: string) {
  const db = supabaseAdmin();
  const existing = await sessionForClaim(claim);
  if (existing) {
    return {
      ok: true as const,
      session: existing,
      role: existing.role,
      sessionToken: rawSessionTokenForClaim(claim.id),
      sessionUrl: `${requestOrigin(origin)}/score/session/${encodeURIComponent(rawSessionTokenForClaim(claim.id))}`
    };
  }
  const event = await loadEvent(claim.event_id);
  if (!event) return { ok: false as const, status: 404, error: "Event not found." };
  await markStaleSessions(claim.court_id);
  const { data: active } = await db
    .from("scorer_sessions")
    .select("*")
    .eq("court_id", claim.court_id)
    .eq("role", "active")
    .in("status", ["active", "promoted"])
    .limit(1)
    .maybeSingle<SessionRow>();

  let role: ScorerRole = active ? "backup" : "active";
  const rawToken = rawSessionTokenForClaim(claim.id);
  const now = new Date();
  const settings = fanScoringSettings(event);
  if (role === "backup") {
    const { count } = await db
      .from("scorer_sessions")
      .select("id", { count: "exact", head: true })
      .eq("court_id", claim.court_id)
      .eq("role", "backup")
      .eq("status", "active");
    if ((count ?? 0) >= settings.maxBackupScorersPerCourt) role = "waiting";
  }
  const leaseExpiresAt = new Date(now.getTime() + settings.failoverSeconds * 1000).toISOString();
  const { data: session, error } = await db.from("scorer_sessions").insert({
    event_id: claim.event_id,
    court_id: claim.court_id,
    match_id: claim.match_id,
    claim_id: claim.id,
    role,
    status: "active",
    session_token_hash: hashToken(rawToken),
    display_name: claim.display_name,
    priority_score: 0,
    last_heartbeat_at: now.toISOString(),
    lease_expires_at: role === "active" ? leaseExpiresAt : null,
    watch_mode: claim.watch_mode ?? "courtside"
  }).select("*").single<SessionRow>();
  if (error) return { ok: false as const, status: 500, error: error.message };

  await db.from("scorer_claims").update({
    status: "assigned",
    assigned_role: role,
    assigned_session_id: session.id,
    assigned_at: now.toISOString(),
    updated_at: now.toISOString()
  }).eq("id", claim.id);

  await seedShadowState(session);
  await logSessionEvent({
    eventId: claim.event_id,
    courtId: claim.court_id,
    matchId: claim.match_id,
    sessionId: session.id,
    type: "session_assigned",
    payload: { role, claimId: claim.id, displayName: claim.display_name }
  });

  return {
    ok: true as const,
    session,
    role,
    sessionToken: rawToken,
    sessionUrl: `${requestOrigin(origin)}/score/session/${encodeURIComponent(rawToken)}`
  };
}

async function sessionForClaim(claim: ClaimRow): Promise<SessionRow | null> {
  if (!claim.assigned_session_id && !claim.id) return null;
  const query = supabaseAdmin().from("scorer_sessions").select("*");
  const { data } = claim.assigned_session_id
    ? await query.eq("id", claim.assigned_session_id).maybeSingle<SessionRow>()
    : await query.eq("claim_id", claim.id).maybeSingle<SessionRow>();
  return data ?? null;
}

function rawSessionTokenForClaim(claimId: string): string {
  let secret = getEnv().adminSecret;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ADMIN_SECRET must be configured to derive scorer session tokens in production");
    }
    secret = "local-dev-scorecheck";
  }
  return crypto.createHmac("sha256", secret)
    .update(`scorecheck-session:${claimId}`)
    .digest("base64url");
}

export async function getSessionState(rawToken: string) {
  const context = await loadSessionContext(rawToken);
  if (!context.ok) return context;
  await markStaleSessions(context.session.court_id);
  const refreshed = await loadSessionContext(rawToken);
  if (!refreshed.ok) return refreshed;
  return {
    ok: true as const,
    state: publicSessionState(refreshed)
  };
}

export async function heartbeatSession(rawToken: string, input: { connectionStatus?: string; watchMode?: WatchMode }) {
  const context = await loadSessionContext(rawToken);
  if (!context.ok) return context;
  if (!sessionCanAct(context.session)) return { ok: false as const, status: 403, error: "This scoring session is no longer active." };
  const settings = fanScoringSettings(context.event);
  const now = new Date();
  const patch: Record<string, unknown> = {
    last_heartbeat_at: now.toISOString(),
    updated_at: now.toISOString()
  };
  if (input.watchMode) patch.watch_mode = input.watchMode;
  if (context.session.role === "active") {
    patch.lease_expires_at = new Date(now.getTime() + settings.failoverSeconds * 1000).toISOString();
  }
  const { data, error } = await supabaseAdmin()
    .from("scorer_sessions")
    .update(patch)
    .eq("id", context.session.id)
    .select("*")
    .single<SessionRow>();
  if (error) return { ok: false as const, status: 500, error: error.message };
  await logSessionEvent({
    eventId: context.event.id,
    courtId: context.court.id,
    matchId: context.match?.id ?? null,
    sessionId: context.session.id,
    type: "session_heartbeat",
    payload: { connectionStatus: input.connectionStatus ?? "visible", role: data.role }
  });
  return {
    ok: true as const,
    role: data.role,
    leaseExpiresAt: data.lease_expires_at,
    serverTime: now.toISOString()
  };
}

export async function applySessionAction(rawToken: string, input: {
  actionId?: string;
  type: SessionActionType;
  payload?: Record<string, unknown>;
  req?: NextRequest;
}) {
  if (input.type === "RELEASE") return releaseSession(rawToken);
  const context = await loadSessionContext(rawToken);
  if (!context.ok) return context;
  if (!sessionCanAct(context.session)) return { ok: false as const, status: 403, error: "This scoring session is no longer active." };
  if (!context.match) return { ok: false as const, status: 409, error: "No active match on this court." };

  const ipHash = input.req ? requestIpHash(input.req) : "unknown";
  if (!checkRateLimit(`session-action:${context.session.id}:${ipHash}`, 90, 60_000)) {
    return { ok: false as const, status: 429, error: "Too many scoring taps. Pause for a moment and try again." };
  }
  if (context.session.role === "active") {
    if (input.type === "SCORE_CHECK_KEEP_OFFICIAL") return resolveActiveScoreCheck(context);
    if (input.type === "SCORE_CHECK_USE_BACKUP") return resolveActiveScoreCheckWithBackup(context);
    const handoffPending = isPromotionHandoffPending(context.session, scoreStateFromDb(context.score), scoreStateFromDb(context.shadow));
    if (handoffPending) {
      if (input.type === "HANDOFF_USE_OFFICIAL") return resolvePromotionHandoffWithOfficial(context);
      if (input.type === "HANDOFF_USE_SHADOW") return resolvePromotionHandoffWithShadow(context);
      if (input.type !== "MANUAL_CORRECTION") {
        return {
          ok: false as const,
          status: 409,
          error: "Choose which score to continue from before adding more points."
        };
      }
    } else if (input.type === "HANDOFF_USE_OFFICIAL" || input.type === "HANDOFF_USE_SHADOW") {
      return { ok: true as const, official: true, role: context.session.role, score: scoreStateFromDb(context.score), message: "Score handoff is already resolved." };
    }

    if (activeScoreCheckFlag(context) && input.type !== "MANUAL_CORRECTION") {
      return {
        ok: false as const,
        status: 409,
        error: "Please confirm the score check before adding more points."
      };
    }
    return applyOfficialSessionAction(context, input);
  }
  if (context.session.role === "backup") {
    if (input.type === "HANDOFF_USE_OFFICIAL" || input.type === "HANDOFF_USE_SHADOW" || input.type === "SCORE_CHECK_KEEP_OFFICIAL" || input.type === "SCORE_CHECK_USE_BACKUP") {
      return { ok: false as const, status: 403, error: "Only the live scorekeeper can resolve a score handoff." };
    }
    return applyBackupSessionAction(context, input);
  }
  return { ok: false as const, status: 403, error: "Waiting scorers cannot score yet." };
}

export async function releaseSession(rawToken: string) {
  const context = await loadSessionContext(rawToken);
  if (!context.ok) return context;
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin().from("scorer_sessions").update({
    status: "released",
    released_at: now,
    updated_at: now
  }).eq("id", context.session.id);
  if (error) return { ok: false as const, status: 500, error: error.message };
  await logSessionEvent({
    eventId: context.event.id,
    courtId: context.court.id,
    matchId: context.match?.id ?? null,
    sessionId: context.session.id,
    type: "session_released",
    payload: { role: context.session.role }
  });
  const promoted = context.session.role === "active" ? await promoteBestBackup(context.court.id) : null;
  return { ok: true as const, released: true, promotedSessionId: promoted?.session?.id ?? null };
}

export async function promoteBestBackup(courtId: string) {
  const db = supabaseAdmin();
  const { data: backups, error } = await db
    .from("scorer_sessions")
    .select("*")
    .eq("court_id", courtId)
    .eq("role", "backup")
    .eq("status", "active")
    .order("priority_score", { ascending: false })
    .order("joined_at", { ascending: true })
    .limit(20);
  if (error || !backups?.length) return null;
  const event = await loadEvent(backups[0].event_id);
  const settings = fanScoringSettings(event);
  const now = new Date();
  const heartbeatCutoff = now.getTime() - settings.failoverSeconds * 1000;
  const backup = backups
    .filter((session) => session.last_heartbeat_at && new Date(session.last_heartbeat_at).getTime() >= heartbeatCutoff)
    .sort((a, b) => backupPromotionRank(b, now) - backupPromotionRank(a, now) || new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime())[0] as SessionRow | undefined;
  if (!backup) return null;
  return promoteBackupSession(backup, now);
}

async function promoteBackupSession(backup: SessionRow, now = new Date()) {
  const db = supabaseAdmin();
  const event = await loadEvent(backup.event_id);
  const settings = fanScoringSettings(event);
  const leaseExpiresAt = new Date(now.getTime() + settings.failoverSeconds * 1000).toISOString();
  const { data: session, error: updateError } = await db.from("scorer_sessions").update({
    role: "active",
    status: "promoted",
    promoted_at: now.toISOString(),
    lease_expires_at: leaseExpiresAt,
    updated_at: now.toISOString()
  }).eq("id", backup.id).select("*").single<SessionRow>();
  if (updateError) return null;
  await logSessionEvent({
    eventId: backup.event_id,
    courtId: backup.court_id,
    matchId: backup.match_id,
    sessionId: backup.id,
    type: "session_promoted",
    payload: { displayName: backup.display_name, previousRole: "backup", handoffRequired: true }
  });
  return { session };
}

export function backupPromotionRank(session: Pick<SessionRow, "priority_score" | "watch_mode" | "last_action_at" | "last_heartbeat_at">, now = new Date()): number {
  const lastActionAt = session.last_action_at ? new Date(session.last_action_at).getTime() : 0;
  const lastHeartbeatAt = session.last_heartbeat_at ? new Date(session.last_heartbeat_at).getTime() : 0;
  const recentAction = lastActionAt > 0 && now.getTime() - lastActionAt <= RECENT_BACKUP_ACTIVITY_MS;
  const freshestSignalAt = Math.max(lastActionAt, lastHeartbeatAt);
  const recencyScore = freshestSignalAt > 0 ? Math.max(0, 60 - Math.floor((now.getTime() - freshestSignalAt) / 1000)) : 0;
  return session.priority_score
    + (session.watch_mode === "courtside" ? 100 : 0)
    + (recentAction ? 75 : 0)
    + recencyScore;
}

export async function markStaleSessions(courtId?: string) {
  const db = supabaseAdmin();
  const staleHeartbeatCutoff = new Date(Date.now() - fanScoringSettings(null).failoverSeconds * 1000).toISOString();
  let staleBackupQuery = db
    .from("scorer_sessions")
    .select("*")
    .eq("role", "backup")
    .eq("status", "active")
    .lt("last_heartbeat_at", staleHeartbeatCutoff);
  if (courtId) staleBackupQuery = staleBackupQuery.eq("court_id", courtId);
  const { data: staleBackups } = await staleBackupQuery;
  for (const session of (staleBackups ?? []) as SessionRow[]) {
    await db.from("scorer_sessions").update({
      status: "stale",
      updated_at: new Date().toISOString()
    }).eq("id", session.id);
    await logSessionEvent({
      eventId: session.event_id,
      courtId: session.court_id,
      matchId: session.match_id,
      sessionId: session.id,
      type: "backup_session_stale",
      payload: { displayName: session.display_name }
    });
  }

  let query = db
    .from("scorer_sessions")
    .select("*")
    .eq("role", "active")
    .in("status", ["active", "promoted"])
    .lt("lease_expires_at", new Date().toISOString());
  if (courtId) query = query.eq("court_id", courtId);
  const { data } = await query;
  for (const session of (data ?? []) as SessionRow[]) {
    await db.from("scorer_sessions").update({
      status: "stale",
      updated_at: new Date().toISOString()
    }).eq("id", session.id);
    await logSessionEvent({
      eventId: session.event_id,
      courtId: session.court_id,
      matchId: session.match_id,
      sessionId: session.id,
      type: "session_stale",
      payload: { displayName: session.display_name }
    });
    await upsertOpenCourtFlag({
      event_id: session.event_id,
      court_id: session.court_id,
      match_id: session.match_id,
      severity: "warning",
      type: "active_scorer_stale",
      message: `${session.display_name} stopped sending heartbeats.`,
      payload: { sessionId: session.id }
    });
    await promoteBestBackup(session.court_id);
  }
}

export async function computeCourtScorerStatus(courtId: string) {
  await markStaleSessions(courtId);
  const { data } = await supabaseAdmin()
    .from("scorer_sessions")
    .select("*")
    .eq("court_id", courtId)
    .in("status", ["active", "promoted", "stale"])
    .order("joined_at", { ascending: true });
  const sessions = (data ?? []) as SessionRow[];
  const active = sessions.find((session) => session.role === "active" && session.status !== "stale") ?? null;
  const backups = sessions.filter((session) => session.role === "backup" && session.status !== "stale");
  return {
    active,
    backups,
    needsScorer: !active,
    backupRequested: backups.length === 0
  };
}

export function publicSessionState(context: Awaited<ReturnType<typeof loadSessionContext>> & { ok: true }) {
  const officialScore = scoreStateFromDb(context.score);
  const shadowScore = scoreStateFromDb(context.shadow);
  const handoffPending = isPromotionHandoffPending(context.session, officialScore, shadowScore);
  const challengeFlag = activeScoreCheckFlag(context);
  const challengePayload = recordValue(challengeFlag?.payload);
  const challengeShadow = recordValue(challengePayload?.shadow);
  const scorerStatus = {
    role: context.session.role,
    status: context.session.status,
    displayName: context.session.display_name,
    lastHeartbeatAt: context.session.last_heartbeat_at,
    leaseExpiresAt: context.session.lease_expires_at,
    watchMode: context.session.watch_mode
  };
  return {
    session: scorerStatus,
    event: {
      id: context.event.id,
      slug: context.event.slug,
      name: context.event.name,
      settings: context.event.settings
    },
    court: {
      id: context.court.id,
      eventId: context.court.event_id,
      courtNumber: context.court.court_number,
      displayName: context.court.display_name,
      scoringOpen: context.court.scoring_open !== false,
      backupRequested: context.court.backup_requested !== false,
      videoConfigured: videoConfigured()
    },
    match: context.match,
    officialScore,
    shadowScore,
    handoff: {
      pending: handoffPending,
      officialScore,
      shadowScore,
      reason: handoffPending ? "promotion" : null
    },
    scoreCheck: {
      pending: Boolean(challengeFlag),
      message: challengeFlag?.message ?? null,
      backupDisplayName: typeof challengePayload?.backupDisplayName === "string" ? challengePayload.backupDisplayName : null,
      backupScore: challengeShadow ? normalizeScoreState(challengeShadow) : null
    }
  };
}

async function applyOfficialSessionAction(context: SessionContext, input: {
  actionId?: string;
  type: SessionActionType;
  payload?: Record<string, unknown>;
}) {
  if (apiScoreHasPriority(context.score as Record<string, unknown> | null, context.match)) {
    const result = await applyBackupSessionAction(context, input);
    return {
      ...result,
      reason: "api_priority",
      message: "VolleyballLife live scoring is controlling the broadcast. Your taps are saved for review."
    };
  }

  const db = supabaseAdmin();
  if (input.actionId) {
    const { data: existing } = await db.from("score_actions").select("next_state").eq("action_id", input.actionId).maybeSingle();
    if (existing) return { ok: true as const, official: true, role: context.session.role, score: existing.next_state, idempotent: true };
  }
  const previous = scoreStateFromDb(context.score);
  const next = input.type === "UNDO"
    ? await restorePreviousOfficialState(context.court.id, previous)
    : reduceAction(previous, context.match?.format ?? null, input.type, input.payload);
  const saved = await persistScoreAndOverlay(context.court, context.match, dbScorePayload(context.court.id, context.match?.id ?? null, next, "manual"));
  await db.from("score_actions").insert({
    court_id: context.court.id,
    match_id: context.match?.id ?? null,
    action: input.type,
    action_id: input.actionId ?? crypto.randomUUID(),
    payload: input.payload ?? {},
    actor: "scorer",
    actor_type: "scorer",
    actor_label: context.session.display_name,
    previous_state: previous,
    next_state: next
  });
  await db.from("scorer_sessions").update({
    last_action_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("id", context.session.id);
  await syncShadowState(context.session, next);
  await resolveOpenCourtFlags(context.event.id, context.court.id, context.match?.id ?? null, ["score_mismatch", "active_score_check"]);
  await logSessionEvent({
    eventId: context.event.id,
    courtId: context.court.id,
    matchId: context.match?.id ?? null,
    sessionId: context.session.id,
    type: "active_action",
    payload: { actionId: input.actionId, type: input.type, previousState: previous, nextState: next }
  });
  return { ok: true as const, official: true, role: context.session.role, score: saved.score };
}

async function applyBackupSessionAction(context: SessionContext, input: {
  actionId?: string;
  type: SessionActionType;
  payload?: Record<string, unknown>;
}) {
  const db = supabaseAdmin();
  if (input.actionId) {
    const { data: events } = await db
      .from("scorer_session_events")
      .select("payload")
      .eq("session_id", context.session.id)
      .eq("type", "backup_action")
      .order("created_at", { ascending: false })
      .limit(50);
    const existing = (events ?? []).find((event) => (event.payload as Record<string, unknown>)?.actionId === input.actionId);
    if (existing) return { ok: true as const, official: false, role: context.session.role, shadowScore: (existing.payload as Record<string, unknown>).nextState, idempotent: true };
  }
  const previous = scoreStateFromDb(context.shadow ?? context.score);
  const next = input.type === "UNDO"
    ? await restorePreviousBackupState(context.session.id, previous)
    : reduceAction(previous, context.match?.format ?? null, input.type, input.payload);
  const { data: shadow, error } = await db.from("scorer_shadow_states").upsert({
    session_id: context.session.id,
    event_id: context.event.id,
    court_id: context.court.id,
    match_id: context.match?.id ?? null,
    ...dbScorePatch(next),
    updated_at: new Date().toISOString()
  }).select("*").single();
  if (error) return { ok: false as const, status: 500, error: error.message };
  await logSessionEvent({
    eventId: context.event.id,
    courtId: context.court.id,
    matchId: context.match?.id ?? null,
    sessionId: context.session.id,
    type: "backup_action",
    payload: { actionId: input.actionId, type: input.type, previousState: previous, nextState: next }
  });
  await db.from("scorer_sessions").update({
    last_action_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("id", context.session.id);
  await handleBackupScoreComparison(context, next);
  return { ok: true as const, official: false, role: context.session.role, shadowScore: shadow };
}

async function resolvePromotionHandoffWithOfficial(context: SessionContext) {
  const official = scoreStateFromDb(context.score);
  await syncShadowState(context.session, official);
  await resolveOpenCourtFlags(context.event.id, context.court.id, context.match?.id ?? null, ["active_score_check", "score_mismatch"]);
  await logSessionEvent({
    eventId: context.event.id,
    courtId: context.court.id,
    matchId: context.match?.id ?? null,
    sessionId: context.session.id,
    type: "handoff_continue_official",
    payload: { official }
  });
  return {
    ok: true as const,
    official: true,
    role: context.session.role,
    score: official,
    handoffResolved: true,
    message: "Continuing from the broadcast score."
  };
}

async function resolvePromotionHandoffWithShadow(context: SessionContext) {
  const db = supabaseAdmin();
  const previous = scoreStateFromDb(context.score);
  const shadow = validateManualCorrection(scoreStateFromDb(context.shadow), formatFromUnknown(context.match?.format ?? defaultBeachFormat()));
  const saved = await persistScoreAndOverlay(context.court, context.match, dbScorePayload(context.court.id, context.match?.id ?? null, shadow, "manual"));
  await db.from("score_actions").insert({
    court_id: context.court.id,
    match_id: context.match?.id ?? null,
    action: "HANDOFF_ADOPT_SHADOW",
    action_id: crypto.randomUUID(),
    payload: { promotedSessionId: context.session.id },
    actor: "scorer",
    actor_type: "scorer",
    actor_label: context.session.display_name,
    previous_state: previous,
    next_state: shadow
  });
  await db.from("scorer_sessions").update({
    last_action_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("id", context.session.id);
  await syncShadowState(context.session, shadow);
  await resolveOpenCourtFlags(context.event.id, context.court.id, context.match?.id ?? null, ["active_score_check", "score_mismatch"]);
  await logSessionEvent({
    eventId: context.event.id,
    courtId: context.court.id,
    matchId: context.match?.id ?? null,
    sessionId: context.session.id,
    type: "handoff_adopt_shadow",
    payload: { previousOfficial: previous, adoptedShadow: shadow }
  });
  return {
    ok: true as const,
    official: true,
    role: context.session.role,
    score: saved.score,
    handoffResolved: true,
    message: "Your saved score is now the broadcast score."
  };
}

async function resolveActiveScoreCheck(context: SessionContext) {
  const official = scoreStateFromDb(context.score);
  await syncShadowState(context.session, official);
  await resolveOpenCourtFlags(context.event.id, context.court.id, context.match?.id ?? null, ["active_score_check", "score_mismatch"]);
  await logSessionEvent({
    eventId: context.event.id,
    courtId: context.court.id,
    matchId: context.match?.id ?? null,
    sessionId: context.session.id,
    type: "active_score_check_confirmed",
    payload: { official }
  });
  return {
    ok: true as const,
    official: true,
    role: context.session.role,
    score: official,
    scoreCheckResolved: true,
    message: "Broadcast score confirmed."
  };
}

async function resolveActiveScoreCheckWithBackup(context: SessionContext) {
  const flag = activeScoreCheckFlag(context);
  const payload = recordValue(flag?.payload);
  const backupShadow = recordValue(payload?.shadow);
  if (!backupShadow) return { ok: false as const, status: 409, error: "No backup score is available for this score check." };

  const db = supabaseAdmin();
  const previous = scoreStateFromDb(context.score);
  const next = validateManualCorrection(normalizeScoreState(backupShadow), formatFromUnknown(context.match?.format ?? defaultBeachFormat()));
  const saved = await persistScoreAndOverlay(context.court, context.match, dbScorePayload(context.court.id, context.match?.id ?? null, next, "manual"));
  await db.from("score_actions").insert({
    court_id: context.court.id,
    match_id: context.match?.id ?? null,
    action: "SCORE_CHECK_ADOPT_BACKUP",
    action_id: crypto.randomUUID(),
    payload: {
      activeSessionId: context.session.id,
      backupSessionId: payload?.backupSessionId ?? null
    },
    actor: "scorer",
    actor_type: "scorer",
    actor_label: context.session.display_name,
    previous_state: previous,
    next_state: next
  });
  await db.from("scorer_sessions").update({
    last_action_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }).eq("id", context.session.id);
  await syncShadowState(context.session, next);
  await resolveOpenCourtFlags(context.event.id, context.court.id, context.match?.id ?? null, ["active_score_check", "score_mismatch"]);
  await logSessionEvent({
    eventId: context.event.id,
    courtId: context.court.id,
    matchId: context.match?.id ?? null,
    sessionId: context.session.id,
    type: "active_score_check_adopted_backup",
    payload: { previousOfficial: previous, adoptedBackup: next, backupSessionId: payload?.backupSessionId ?? null }
  });
  return {
    ok: true as const,
    official: true,
    role: context.session.role,
    score: saved.score,
    scoreCheckResolved: true,
    message: "Backup score is now the broadcast score."
  };
}

async function handleBackupScoreComparison(context: SessionContext, shadow: ScoreState) {
  const official = scoreStateFromDb(context.score);
  if (scoreSignature(official) === scoreSignature(shadow)) {
    await resolveOpenCourtFlags(context.event.id, context.court.id, context.match?.id ?? null, ["active_score_check", "score_mismatch"]);
    return;
  }

  await upsertOpenCourtFlag({
    event_id: context.event.id,
    court_id: context.court.id,
    match_id: context.match?.id ?? null,
    severity: "warning",
    type: "score_mismatch",
    message: `${context.session.display_name}'s saved score differs from the broadcast score.`,
    payload: {
      sessionId: context.session.id,
      backupDisplayName: context.session.display_name,
      official,
      shadow
    }
  });
  await maybeCreateActiveScoreCheck(context, official, shadow);
}

async function maybeCreateActiveScoreCheck(context: SessionContext, official: ScoreState, shadow: ScoreState) {
  const db = supabaseAdmin();
  const { data: active } = await db
    .from("scorer_sessions")
    .select("*")
    .eq("court_id", context.court.id)
    .eq("role", "active")
    .in("status", ["active", "promoted"])
    .limit(1)
    .maybeSingle<SessionRow>();
  if (!active || active.id === context.session.id) return;

  const now = Date.now();
  const settings = fanScoringSettings(context.event);
  const heartbeatFresh = active.last_heartbeat_at
    ? now - new Date(active.last_heartbeat_at).getTime() <= settings.failoverSeconds * 1000
    : false;
  if (!heartbeatFresh) return;

  const activeIdle = !active.last_action_at || now - new Date(active.last_action_at).getTime() >= ACTIVE_SCORING_IDLE_MS;
  if (!activeIdle) return;

  const since = new Date(now - RECENT_BACKUP_ACTIVITY_MS).toISOString();
  const { data: recentEvents } = await db
    .from("scorer_session_events")
    .select("payload")
    .eq("session_id", context.session.id)
    .eq("type", "backup_action")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);
  const recentScoreActions = (recentEvents ?? [])
    .map((event) => recordValue(event.payload)?.type)
    .filter((type) => typeof type === "string" && ["POINT_A", "POINT_B", "UNDO", "MANUAL_CORRECTION"].includes(type)).length;
  if (recentScoreActions < 2) return;

  await upsertOpenCourtFlag({
    event_id: context.event.id,
    court_id: context.court.id,
    match_id: context.match?.id ?? null,
    severity: "critical",
    type: "active_score_check",
    message: "Backup scoring is moving while the active scorer has not updated the broadcast. Confirm the current score.",
    payload: {
      activeSessionId: active.id,
      activeDisplayName: active.display_name,
      activeLastActionAt: active.last_action_at,
      activeLastHeartbeatAt: active.last_heartbeat_at,
      backupSessionId: context.session.id,
      backupDisplayName: context.session.display_name,
      recentBackupActions: recentScoreActions,
      official,
      shadow
    }
  });
}

async function syncShadowState(session: SessionRow, state: ScoreState) {
  await supabaseAdmin().from("scorer_shadow_states").upsert({
    session_id: session.id,
    event_id: session.event_id,
    court_id: session.court_id,
    match_id: session.match_id,
    ...dbScorePatch(state),
    updated_at: new Date().toISOString()
  });
}

async function upsertOpenCourtFlag(input: {
  event_id: string;
  court_id: string;
  match_id: string | null;
  severity: "info" | "warning" | "critical";
  type: string;
  message: string;
  payload: Record<string, unknown>;
}) {
  const db = supabaseAdmin();
  let query = db
    .from("court_flags")
    .select("id")
    .eq("event_id", input.event_id)
    .eq("court_id", input.court_id)
    .eq("status", "open")
    .eq("type", input.type)
    .order("created_at", { ascending: false })
    .limit(1);
  query = input.match_id ? query.eq("match_id", input.match_id) : query.is("match_id", null);
  const { data: existing } = await query.maybeSingle<{ id: string }>();
  if (existing?.id) {
    await db.from("court_flags").update({
      severity: input.severity,
      message: input.message,
      payload: input.payload
    }).eq("id", existing.id);
    return;
  }
  await db.from("court_flags").insert(input);
}

async function resolveOpenCourtFlags(eventId: string, courtId: string, matchId: string | null, types: string[]) {
  const db = supabaseAdmin();
  let query = db
    .from("court_flags")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("event_id", eventId)
    .eq("court_id", courtId)
    .eq("status", "open")
    .in("type", types);
  query = matchId ? query.eq("match_id", matchId) : query.is("match_id", null);
  await query;
}

export function reduceAction(previous: ScoreState, formatInput: Record<string, unknown> | null, type: SessionActionType, payload?: Record<string, unknown>): ScoreState {
  const format = formatFromUnknown(formatInput ?? defaultBeachFormat());
  if (isFinalScore(previous)) {
    throw new Error("This match is already final.");
  }
  if (type === "POINT_A") return scorePoint(previous, "A", format);
  if (type === "POINT_B") return scorePoint(previous, "B", format);
  if (type === "SET_COMPLETE") return forceCompleteSet(previous, format);
  if (type === "MATCH_COMPLETE") return forceCompleteMatch(previous, format);
  if (type === "SERVE_A") return { ...previous, servingTeam: "A" };
  if (type === "SERVE_B") return { ...previous, servingTeam: "B" };
  if (type === "TIMEOUT_A" || type === "TIMEOUT_B") return { ...previous, status: previous.status === "Prematch" ? "In Progress" : previous.status };
  if (type === "MANUAL_CORRECTION") return validateManualCorrection(recordValue(payload?.score) as Partial<ScoreState>, format);
  return previous;
}

function isFinalScore(score: ScoreState): boolean {
  return score.status.toLowerCase().includes("final");
}

async function restorePreviousOfficialState(courtId: string, fallback: ScoreState) {
  const { data } = await supabaseAdmin()
    .from("score_actions")
    .select("previous_state")
    .eq("court_id", courtId)
    .not("previous_state", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.previous_state ? normalizeScoreState(data.previous_state as Record<string, unknown>) : fallback;
}

async function restorePreviousBackupState(sessionId: string, fallback: ScoreState) {
  const { data } = await supabaseAdmin()
    .from("scorer_session_events")
    .select("payload")
    .eq("session_id", sessionId)
    .eq("type", "backup_action")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const payload = recordValue(data?.payload);
  return payload?.previousState ? normalizeScoreState(payload.previousState as Record<string, unknown>) : fallback;
}

async function loadSessionContext(rawToken: string): Promise<
  | { ok: true; session: SessionRow; event: EventRow; court: CourtContext; match: MatchRow | null; score: ScoreRow | null; shadow: ScoreRow | null; flags: CourtFlagRow[] }
  | { ok: false; status: number; error: string }
> {
  const db = supabaseAdmin();
  const { data: session, error } = await db
    .from("scorer_sessions")
    .select("*")
    .eq("session_token_hash", hashToken(rawToken))
    .maybeSingle<SessionRow>();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!session) return { ok: false, status: 404, error: "Scorer session not found." };
  const event = await loadEvent(session.event_id);
  if (!event) return { ok: false, status: 404, error: "Event not found." };
  const { data: court, error: courtError } = await db
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("id", session.court_id)
    .maybeSingle<CourtContext>();
  if (courtError) return { ok: false, status: 500, error: courtError.message };
  if (!court) return { ok: false, status: 404, error: "Court not found." };
  const { data: shadow } = await db.from("scorer_shadow_states").select("*").eq("session_id", session.id).maybeSingle<ScoreRow>();
  const flagQuery = db
    .from("court_flags")
    .select("*")
    .eq("court_id", session.court_id)
    .eq("status", "open")
    .in("type", ["score_mismatch", "active_score_check"])
    .order("created_at", { ascending: false })
    .limit(20);
  const { data: flags } = session.match_id
    ? await flagQuery.eq("match_id", session.match_id)
    : await flagQuery;
  return {
    ok: true,
    session,
    event,
    court,
    match: firstRelation(court.matches),
    score: scoreForCurrentMatch(court.score_states, firstRelation(court.matches)?.id),
    shadow: shadow ?? null,
    flags: (flags ?? []) as CourtFlagRow[]
  };
}

type SessionContext = Awaited<ReturnType<typeof loadSessionContext>> & { ok: true };

async function loadEvent(eventId: string): Promise<EventRow | null> {
  const { data } = await supabaseAdmin().from("events").select("*").eq("id", eventId).maybeSingle<EventRow>();
  return data ?? null;
}

async function seedShadowState(session: SessionRow) {
  const context = await loadSessionContextBySession(session);
  if (!context) return;
  await supabaseAdmin().from("scorer_shadow_states").upsert({
    session_id: session.id,
    event_id: session.event_id,
    court_id: session.court_id,
    match_id: session.match_id,
    ...dbScorePatch(scoreStateFromDb(context.score)),
    updated_at: new Date().toISOString()
  });
}

async function loadSessionContextBySession(session: SessionRow) {
  const { data: court } = await supabaseAdmin()
    .from("courts")
    .select("*, matches:current_match_id(*), score_states(*)")
    .eq("id", session.court_id)
    .maybeSingle<CourtContext>();
  return court ? { court, score: scoreForCurrentMatch(court.score_states, firstRelation(court.matches)?.id) } : null;
}

function sessionCanAct(session: SessionRow): boolean {
  return session.status === "active" || session.status === "promoted";
}

export function isPromotionHandoffPending(
  session: Pick<SessionRow, "role" | "status">,
  official: ScoreState,
  shadow: ScoreState | null | undefined
): boolean {
  if (!shadow) return false;
  return session.role === "active"
    && session.status === "promoted"
    && scoreSignature(official) !== scoreSignature(shadow);
}

function scoreStateFromDb(row: ScoreRow | null | undefined): ScoreState {
  if (!row) return emptyScoreState();
  return normalizeScoreState(row as unknown as Record<string, unknown>);
}

function dbScorePatch(state: ScoreState) {
  return {
    team_a_score: state.teamAScore,
    team_b_score: state.teamBScore,
    team_a_sets: state.teamASets,
    team_b_sets: state.teamBSets,
    current_set: state.currentSet,
    set_scores: state.setScores,
    serving_team: state.servingTeam,
    status: state.status
  };
}

function dbScorePayload(courtId: string, matchId: string | null, state: ScoreState, source: "manual" | "override") {
  return {
    court_id: courtId,
    match_id: matchId,
    ...dbScorePatch(state),
    source,
    stale: false,
    message: null
  };
}

async function logSessionEvent(input: {
  eventId: string;
  courtId: string;
  matchId?: string | null;
  sessionId?: string | null;
  type: string;
  payload: Record<string, unknown>;
}) {
  await supabaseAdmin().from("scorer_session_events").insert({
    event_id: input.eventId,
    court_id: input.courtId,
    match_id: input.matchId ?? null,
    session_id: input.sessionId ?? null,
    type: input.type,
    payload: input.payload
  });
}

function scoreSignature(state: ScoreState): string {
  return [state.teamAScore, state.teamBScore, state.teamASets, state.teamBSets, state.currentSet, state.status].join(":");
}

function activeScoreCheckFlag(context: SessionContext): CourtFlagRow | null {
  return context.flags.find((flag) => {
    if (flag.type !== "active_score_check") return false;
    const payload = recordValue(flag.payload);
    return payload?.activeSessionId === context.session.id;
  }) ?? null;
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function publicCourtData(eventSlug: string | undefined, courtParam: string) {
  const resolved = await resolveCourtIdentifier({ eventSlug, courtParam });
  if (!resolved) return null;
  const { active, backups, needsScorer, backupRequested } = await computeCourtScorerStatus(resolved.court.id);
  return {
    event: resolved.event,
    court: resolved.court,
    scorerStatus: {
      active,
      backups,
      needsScorer,
      backupRequested
    }
  };
}
