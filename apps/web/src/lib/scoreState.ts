import { createHash } from "node:crypto";
import {
  claimCanonicalScoreOutbox,
  commitTrustedCanonicalScore,
  markCanonicalOutboxResult,
  publishCanonicalOutboxProjection
} from "./communityWitness";
import { buildOverlayState } from "./overlay";
import type { OverlayState } from "./types";
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
  current_match_id?: string | null;
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
  match_id: string;
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
  source_available?: boolean | null;
  source_priority?: "primary" | "fallback" | "override" | null;
  source_pending_scores?: unknown;
  stale: boolean;
  message: string | null;
  last_api_poll_at: string | null;
  last_score_change_at: string | null;
  updated_at: string | null;
  revision?: number | null;
  authority_epoch?: number | null;
  authority_mode?: AuthorityMode | null;
  state_hash?: string | null;
  current_rally_number?: number | null;
};

export type AuthorityMode =
  | "ADMIN_LOCKED"
  | "PROVIDER_PRIMARY"
  | "DESIGNATED_PRIMARY"
  | "VERIFIED_CONSENSUS"
  | "PAUSED_DISPUTE";

export type TrustedScoreWrite = {
  actionId?: string;
  actorType: "ADMIN" | "PROVIDER" | "SYSTEM";
  actorLabel?: string;
  authorityMode: AuthorityMode;
  commandType?: "ADD_POINT" | "REMOVE_POINT" | "CORRECT_SCORE" | "COMPLETE_SET" | "COMPLETE_MATCH" | "SET_SERVE" | "SET_CURRENT_SET";
  teamSide?: "A" | "B" | null;
  expectedRevision?: number;
  expectedAuthorityEpoch?: number;
  currentRallyNumber?: number;
  scoreChangeObservedAt?: string;
  metadata?: Record<string, unknown>;
};

type ScoreWriteInput = Partial<ScoreRecord> & {
  court_id: string;
  match_id: string;
  team_a_score: number;
  team_b_score: number;
  team_a_sets: number;
  team_b_sets: number;
  current_set: number;
  set_scores: unknown;
  serving_team?: string | null;
  status: string;
  source: "api" | "manual" | "override";
  source_available?: boolean;
  source_priority?: "primary" | "fallback" | "override";
  source_pending_scores?: unknown;
  stale?: boolean;
  message?: string | null;
};

/**
 * The only application-level path that changes canonical score values.
 *
 * The database RPC locks the match projection, validates the optimistic
 * revision/authority epoch, appends the immutable event, and creates the
 * outbox row in one transaction. The overlay is then projected from the
 * committed row. Projection failures leave a FAILED outbox item so the
 * canonical score can be replayed without mutating the score a second time.
 */
export async function persistScoreAndOverlay(
  court: CourtRecord,
  match: MatchRecord,
  score: ScoreWriteInput,
  write: TrustedScoreWrite
) {
  if (!match?.id || !score.match_id || score.match_id !== match.id) {
    throw new Error("Canonical score writes require the active match identity");
  }
  if (court.event_id !== match.event_id) {
    throw new Error("Court and match must belong to the same event");
  }

  const current = await loadCanonicalScore(match.id);
  if (!current) {
    throw new Error("Canonical score projection is missing; transition the match before writing a score");
  }

  const expectedRevision = write.expectedRevision ?? numberValue(current.revision) ?? 0;
  const expectedAuthorityEpoch = write.expectedAuthorityEpoch ?? numberValue(current.authority_epoch) ?? 1;
  const inferredCommand = inferCanonicalCommand(current, score, write);
  const now = new Date().toISOString();
  const nextState = canonicalStateFromWrite(current, score, inferredCommand, write.currentRallyNumber);
  const visibleStateChanged = canonicalVisibleStateChanged(current, nextState);
  const command = normalizeCanonicalCommand(inferredCommand, visibleStateChanged);
  const projectionMetadata = {
    source: score.source,
    sourceAvailable: score.source_available ?? score.source === "api",
    sourcePriority: score.source_priority ?? (score.source === "override" ? "override" : score.source === "api" ? "primary" : "fallback"),
    sourcePendingScores: Array.isArray(score.source_pending_scores) ? score.source_pending_scores : [],
    stale: score.stale ?? false,
    message: score.message ?? null,
    // Freshness-only observations live in score_source_heartbeats. These
    // timestamps accompany a semantic commit but never cause one on their own.
    lastApiPollAt: score.last_api_poll_at ?? current.last_api_poll_at ?? null,
    lastScoreChangeAt: nextTrustedScoreChangeAt({
      current: current.last_score_change_at ?? null,
      visibleStateChanged,
      observedAt: write.scoreChangeObservedAt,
      now
    })
  } as const;

  if (canonicalWriteMatches(current, nextState, projectionMetadata, write.authorityMode)) {
    const overlay = await loadExistingOverlay(court, match, current);
    return { score: current, overlay, duplicate: true, eventId: null, outboxId: null };
  }

  const actionId = write.actionId ?? trustedScoreActionId({
    eventId: court.event_id,
    courtId: court.id,
    matchId: match.id,
    actorType: write.actorType,
    authorityMode: write.authorityMode,
    commandType: command.commandType,
    teamSide: command.teamSide,
    expectedRevision,
    expectedAuthorityEpoch,
    state: nextState,
    projection: semanticProjectionMetadata(projectionMetadata)
  });

  const committed = await commitTrustedCanonicalScore({
    eventId: court.event_id,
    courtId: court.id,
    matchId: match.id,
    actionId,
    actorType: write.actorType,
    actorLabel: write.actorLabel,
    authorityMode: write.authorityMode,
    expectedRevision,
    expectedAuthorityEpoch,
    commandType: command.commandType,
    teamSide: command.teamSide,
    state: nextState,
    projectionMetadata,
    metadata: write.metadata
  });

  const savedScore = await loadCanonicalScore(match.id);
  if (!savedScore) throw new Error("Canonical score commit succeeded without a readable projection");

  const resultRecord = recordValue(committed);
  const outboxId = stringValue(resultRecord?.outboxId);
  const eventId = stringValue(resultRecord?.eventId);
  const published = outboxId
    ? await publishCanonicalScoreOutbox({ outboxId })
    : { score: savedScore, overlay: await projectScoreOverlay(court, match, savedScore) };
  return {
    score: published.score ?? savedScore,
    overlay: published.overlay,
    duplicate: resultRecord?.duplicate === true,
    eventId,
    outboxId
  };
}

/**
 * Projects one committed outbox item and closes it. This is shared by trusted
 * writers, community scorer routes, and the bounded retry drain. Historical
 * match events are publishable without touching the current court overlay.
 */
export async function publishCanonicalScoreOutbox(input: { outboxId: string }) {
  const db = supabaseAdmin();
  const { data: outbox, error: outboxError } = await db
    .from("canonical_score_outbox")
    .select("id,court_id,match_id,revision")
    .eq("id", input.outboxId)
    .maybeSingle();
  if (outboxError) throw outboxError;
  if (!outbox) throw new Error("Canonical score outbox item was not found");

  const revision = numberValue(outbox.revision) ?? 0;
  try {
    const publication = await finalizeCanonicalOutboxWithRetry({
      maxAttempts: 4,
      prepare: async () => prepareCanonicalOutboxProjection({
        id: outbox.id,
        courtId: outbox.court_id,
        matchId: outbox.match_id,
        revision
      }),
      finalize: (prepared) => publishCanonicalOutboxProjection({
        outboxId: outbox.id,
        projectionRevision: prepared.projectionRevision,
        overlayPayload: prepared.overlayPayload,
        courtStatus: prepared.courtStatus,
        stale: prepared.stale
      })
    });
    if (publication.result.status === "HISTORICAL" || !publication.prepared.score) {
      return { score: null, overlay: null, historical: true };
    }
    return {
      score: publication.prepared.score,
      overlay: publication.prepared.overlay,
      historical: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Overlay projection failed";
    await markCanonicalOutboxResult({
      outboxId: outbox.id,
      revision,
      outcome: "FAILED",
      error: message.slice(0, 1_000)
    }).catch(() => undefined);
    throw error;
  }
}

type OutboxPublicationStatus = "PUBLISHED" | "HISTORICAL" | "RETRY";

/**
 * Rebuilds a projection when the database reports that the canonical revision
 * changed between preparation and the atomic publish call. A match transition
 * is observed on the next preparation and finalized as HISTORICAL without an
 * overlay write.
 */
export async function finalizeCanonicalOutboxWithRetry<
  Prepared,
  Result extends { status: OutboxPublicationStatus }
>(input: {
  prepare: (attempt: number) => Promise<Prepared>;
  finalize: (prepared: Prepared, attempt: number) => Promise<Result>;
  maxAttempts?: number;
}) {
  const maxAttempts = input.maxAttempts ?? 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prepared = await input.prepare(attempt);
    const result = await input.finalize(prepared, attempt);
    if (result.status !== "RETRY") return { prepared, result, attempts: attempt };
  }
  throw new Error("Canonical score changed repeatedly during atomic overlay publication");
}

async function prepareCanonicalOutboxProjection(input: {
  id: string;
  courtId: string;
  matchId: string;
  revision: number;
}) {
  const db = supabaseAdmin();
  const { data: court, error: courtError } = await db
    .from("courts")
    .select("*")
    .eq("id", input.courtId)
    .single();
  if (courtError) throw courtError;

  if (court.current_match_id !== input.matchId) {
    return {
      score: null as ScoreRecord | null,
      overlay: null as OverlayState | null,
      projectionRevision: input.revision,
      overlayPayload: {} as Record<string, unknown>,
      courtStatus: typeof court.status === "string" && court.status ? court.status : "idle",
      stale: false
    };
  }

  const [{ data: match, error: matchError }, score] = await Promise.all([
    db.from("matches").select("*").eq("id", input.matchId).single(),
    loadCanonicalScore(input.matchId)
  ]);
  if (matchError) throw matchError;
  if (!score) throw new Error("Canonical score projection is missing during outbox publish");
  const overlay = await buildOverlayStateWithEventSettings(court as CourtRecord, match as MatchRecord, score);
  return {
    score,
    overlay,
    projectionRevision: numberValue(score.revision) ?? input.revision,
    overlayPayload: overlay as unknown as Record<string, unknown>,
    courtStatus: resolveCourtStatus(score.status, score.set_scores),
    stale: score.stale
  };
}

export async function drainCanonicalScoreOutbox(input: { workerId: string; limit?: number }) {
  const claimed = await claimCanonicalScoreOutbox({
    workerId: input.workerId,
    limit: input.limit ?? 12,
    leaseSeconds: 30
  });
  return drainClaimedCanonicalOutbox(claimed, (item) => publishCanonicalScoreOutbox({ outboxId: item.id }));
}

export async function drainClaimedCanonicalOutbox<T extends { id: string }>(
  claimed: T[],
  publish: (item: T) => Promise<unknown>
) {
  const failedIds: string[] = [];
  let published = 0;
  for (const item of claimed) {
    try {
      await publish(item);
      published += 1;
    } catch {
      // The single-item publisher marks the row FAILED with backoff. Continue
      // draining the bounded batch so one broken overlay cannot block others.
      failedIds.push(item.id);
    }
  }
  return { claimed: claimed.length, published, failed: failedIds.length, failedIds };
}

export async function projectScoreOverlay(court: CourtRecord, match: MatchRecord, score: ScoreRecord): Promise<OverlayState> {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const status = resolveCourtStatus(score.status, score.set_scores);
  const { data: updatedCourt, error: courtError } = await db
    .from("courts")
    .update({ status, last_update_at: now, updated_at: now })
    .eq("id", court.id)
    .select("*")
    .single();
  if (courtError) throw courtError;
  const projectedCourt = updatedCourt as CourtRecord;

  const overlay = await buildOverlayStateWithEventSettings(projectedCourt, match, score);
  const { error: overlayError } = await db.from("overlay_states").upsert({
    court_id: court.id,
    event_id: court.event_id,
    court_number: court.court_number,
    payload: overlay,
    stale: score.stale,
    updated_at: now
  });
  if (overlayError) throw overlayError;
  return overlay;
}

export async function refreshCourtOverlay(courtId: string) {
  const db = supabaseAdmin();
  const { data: court, error: courtError } = await db
    .from("courts")
    .select("*")
    .eq("id", courtId)
    .single();
  if (courtError) throw courtError;

  const matchId = stringValue(court.current_match_id);
  if (!matchId) {
    const overlay = await buildOverlayStateWithEventSettings(court as CourtRecord, null, null);
    const { error: overlayError } = await db.from("overlay_states").upsert({
      court_id: court.id,
      event_id: court.event_id,
      court_number: court.court_number,
      payload: overlay,
      stale: false,
      updated_at: new Date().toISOString()
    });
    if (overlayError) throw overlayError;
    return { score: null, overlay };
  }

  const [{ data: match, error: matchError }, score] = await Promise.all([
    db.from("matches").select("*").eq("id", matchId).single(),
    loadCanonicalScore(matchId)
  ]);
  if (matchError) throw matchError;
  if (!score) throw new Error("Current match does not have a canonical score projection");
  const overlay = await projectScoreOverlay(court as CourtRecord, match as MatchRecord, score);
  return { score, overlay };
}

export async function buildOverlayStateWithEventSettings(
  court: CourtRecord,
  match: MatchRecord | null,
  score: ScoreRecord | null
): Promise<OverlayState> {
  return buildOverlayState({
    event: { id: court.event_id, settings: await loadEventSettings(court.event_id) },
    court,
    match,
    score
  });
}

export function scoreForCurrentMatch<T>(
  scoreStates: T | T[] | null | undefined,
  matchId: string | null | undefined
): T | null {
  if (!matchId) return null;
  const rows = (Array.isArray(scoreStates) ? scoreStates : scoreStates ? [scoreStates] : [])
    .filter((row): row is T => Boolean(row));
  return rows.find((row) => scoreMatchId(row) === matchId) ?? null;
}

export function trustedScoreActionId(input: Record<string, unknown>) {
  const digest = createHash("sha256").update(stableSerialize(input)).digest("hex");
  const variant = ["8", "9", "a", "b"][Number.parseInt(digest[16], 16) % 4];
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function structuredValueEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left == null || right == null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => structuredValueEqual(value, right[index]));
  }
  if (typeof left === "object" || typeof right === "object") {
    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(rightRecord, key) && structuredValueEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

export function nextTrustedRallyNumber(input: {
  current: number;
  commandType: TrustedScoreWrite["commandType"];
  visibleScoreChanged: boolean;
  explicit?: number;
}) {
  if (input.explicit != null) return input.explicit;
  return input.visibleScoreChanged && (input.commandType === "ADD_POINT" || input.commandType === "CORRECT_SCORE")
    ? input.current + 1
    : input.current;
}

export function nextTrustedScoreChangeAt(input: {
  current: string | null;
  visibleStateChanged: boolean;
  observedAt?: string;
  now: string;
}) {
  if (!input.visibleStateChanged) return input.current;
  return input.observedAt ?? input.now;
}

function inferCanonicalCommand(current: ScoreRecord, next: ScoreWriteInput, write: TrustedScoreWrite) {
  if (write.commandType) return { commandType: write.commandType, teamSide: write.teamSide ?? null };
  const aDelta = next.team_a_score - current.team_a_score;
  const bDelta = next.team_b_score - current.team_b_score;
  const sameSetContext = next.current_set === current.current_set
    && next.team_a_sets === current.team_a_sets
    && next.team_b_sets === current.team_b_sets;
  if (sameSetContext && aDelta === 1 && bDelta === 0) return { commandType: "ADD_POINT" as const, teamSide: "A" as const };
  if (sameSetContext && aDelta === 0 && bDelta === 1) return { commandType: "ADD_POINT" as const, teamSide: "B" as const };
  if (sameSetContext && aDelta === -1 && bDelta === 0) return { commandType: "REMOVE_POINT" as const, teamSide: "A" as const };
  if (sameSetContext && aDelta === 0 && bDelta === -1) return { commandType: "REMOVE_POINT" as const, teamSide: "B" as const };
  return { commandType: "CORRECT_SCORE" as const, teamSide: null };
}

function normalizeCanonicalCommand(
  command: ReturnType<typeof inferCanonicalCommand>,
  visibleStateChanged: boolean
): ReturnType<typeof inferCanonicalCommand> {
  // ADD/REMOVE events drive rally resolutions. Never emit one when the
  // supplied trusted state did not actually change the visible score.
  if (!visibleStateChanged && (command.commandType === "ADD_POINT" || command.commandType === "REMOVE_POINT")) {
    return { commandType: "CORRECT_SCORE", teamSide: null };
  }
  return command;
}

function canonicalStateFromWrite(
  current: ScoreRecord,
  score: ScoreWriteInput,
  command: { commandType: TrustedScoreWrite["commandType"]; teamSide: "A" | "B" | null },
  explicitRallyNumber?: number
) {
  const currentRally = numberValue(current.current_rally_number) ?? 0;
  const visibleScoreChanged = score.team_a_score !== current.team_a_score
    || score.team_b_score !== current.team_b_score
    || score.team_a_sets !== current.team_a_sets
    || score.team_b_sets !== current.team_b_sets
    || score.current_set !== current.current_set
    || !structuredValueEqual(score.set_scores, current.set_scores);
  const inferredRally = nextTrustedRallyNumber({
    current: currentRally,
    commandType: command.commandType,
    visibleScoreChanged,
    explicit: explicitRallyNumber
  });
  return {
    teamAScore: score.team_a_score,
    teamBScore: score.team_b_score,
    teamASets: score.team_a_sets,
    teamBSets: score.team_b_sets,
    currentSet: score.current_set,
    setScores: Array.isArray(score.set_scores) ? score.set_scores : [],
    servingTeam: score.serving_team === "A" || score.serving_team === "B" ? score.serving_team : null,
    timeouts: recordValue(score.timeouts) ?? {},
    status: canonicalStatus(score.status),
    currentRallyNumber: inferredRally
  };
}

function canonicalVisibleStateChanged(current: ScoreRecord, next: ReturnType<typeof canonicalStateFromWrite>) {
  return current.team_a_score !== next.teamAScore
    || current.team_b_score !== next.teamBScore
    || current.team_a_sets !== next.teamASets
    || current.team_b_sets !== next.teamBSets
    || current.current_set !== next.currentSet
    || !structuredValueEqual(current.set_scores, next.setScores);
}

function canonicalWriteMatches(
  current: ScoreRecord,
  state: ReturnType<typeof canonicalStateFromWrite>,
  projection: {
    source: ScoreRecord["source"];
    sourceAvailable: boolean;
    sourcePriority: NonNullable<ScoreRecord["source_priority"]>;
    sourcePendingScores: unknown[];
    stale: boolean;
    message: string | null;
    lastApiPollAt: string | null;
    lastScoreChangeAt: string | null;
  },
  authorityMode: AuthorityMode
) {
  const currentState = {
    teamAScore: current.team_a_score,
    teamBScore: current.team_b_score,
    teamASets: current.team_a_sets,
    teamBSets: current.team_b_sets,
    currentSet: current.current_set,
    setScores: Array.isArray(current.set_scores) ? current.set_scores : [],
    servingTeam: current.serving_team === "A" || current.serving_team === "B" ? current.serving_team : null,
    timeouts: recordValue(current.timeouts) ?? {},
    status: canonicalStatus(current.status),
    currentRallyNumber: numberValue(current.current_rally_number) ?? 0
  };
  const semanticCurrentProjection = {
    source: current.source,
    sourceAvailable: current.source_available ?? current.source === "api",
    sourcePriority: current.source_priority ?? (current.source === "override" ? "override" : current.source === "api" ? "primary" : "fallback"),
    sourcePendingScores: Array.isArray(current.source_pending_scores) ? current.source_pending_scores : [],
    stale: current.stale ?? false,
    message: current.message ?? null,
    lastScoreChangeAt: current.last_score_change_at ?? null
  };
  return structuredValueEqual(currentState, state)
    && structuredValueEqual(semanticCurrentProjection, semanticProjectionMetadata(projection))
    && current.authority_mode === authorityMode;
}

export function semanticProjectionMetadata(projection: {
  source: ScoreRecord["source"];
  sourceAvailable: boolean;
  sourcePriority: NonNullable<ScoreRecord["source_priority"]>;
  sourcePendingScores: unknown[];
  stale: boolean;
  message: string | null;
  lastApiPollAt: string | null;
  lastScoreChangeAt: string | null;
}) {
  return {
    source: projection.source,
    sourceAvailable: projection.sourceAvailable,
    sourcePriority: projection.sourcePriority,
    sourcePendingScores: projection.sourcePendingScores,
    stale: projection.stale,
    message: projection.message,
    lastScoreChangeAt: projection.lastScoreChangeAt
  };
}

function canonicalStatus(value: string) {
  const status = value.trim().toLowerCase();
  if (status.includes("final") || status.includes("finished") || (status.includes("complete") && !status.includes("set complete"))) return "Final";
  if (status.includes("set complete")) return "Set Complete";
  if (status.includes("pre-match") || status.includes("prematch") || status.includes("waiting") || status.includes("scheduled")) return "Pre-Match";
  return "In Progress";
}

async function loadCanonicalScore(matchId: string): Promise<ScoreRecord | null> {
  const { data, error } = await supabaseAdmin()
    .from("score_states")
    .select("*")
    .eq("match_id", matchId)
    .maybeSingle();
  if (error) throw error;
  return data as ScoreRecord | null;
}

async function loadExistingOverlay(court: CourtRecord, match: MatchRecord, score: ScoreRecord): Promise<OverlayState> {
  const { data, error } = await supabaseAdmin()
    .from("overlay_states")
    .select("payload")
    .eq("court_id", court.id)
    .maybeSingle();
  if (error) throw error;
  if (data?.payload && typeof data.payload === "object" && !Array.isArray(data.payload)) {
    return data.payload as OverlayState;
  }
  return buildOverlayStateWithEventSettings(court, match, score);
}

function scoreMatchId(row: unknown): string {
  if (!row || typeof row !== "object" || !("match_id" in row)) return "";
  const value = (row as { match_id?: unknown }).match_id;
  return typeof value === "string" ? value : "";
}

function stableSerialize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function numberValue(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function loadEventSettings(eventId: string) {
  const { data } = await supabaseAdmin().from("events").select("settings").eq("id", eventId).maybeSingle();
  const settings = data?.settings;
  return settings && typeof settings === "object" && !Array.isArray(settings) ? settings as Record<string, unknown> : null;
}

export function resolveCourtStatus(status: string, setScores: unknown): string {
  const lower = status.toLowerCase();
  if (lower.includes("set complete")) return "live";
  if (lower.includes("final") || lower.includes("finished") || lower.includes("complete")) return "finished";
  if (Array.isArray(setScores) && setScores.length > 0) return "live";
  return "waiting";
}
