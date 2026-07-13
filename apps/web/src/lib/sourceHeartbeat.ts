import { supabaseAdmin } from "./supabase";

export const SOURCE_HEARTBEAT_WRITE_INTERVAL_MS = 10_000;
const SOURCE_HEARTBEAT_CACHE_LIMIT = 500;

export type SourcePollObservation = {
  courtId: string;
  eventId: string;
  matchId: string | null;
  sourceAvailable: boolean;
  successful: boolean;
  errorMessage?: string | null;
  observedAt: string;
};

export type SourceHeartbeatCacheEntry = {
  signature: string;
  persistedAtMs: number;
};

const heartbeatCache = new Map<string, SourceHeartbeatCacheEntry>();

export function sourceHeartbeatSignature(observation: SourcePollObservation) {
  const outcome = observation.successful ? "success" : "error";
  const availability = observation.sourceAvailable ? "available" : "unavailable";
  const error = observation.successful ? "" : cleanError(observation.errorMessage);
  return [observation.matchId ?? "no-match", outcome, availability, error].join(":");
}

export function shouldPersistSourceHeartbeat(
  previous: SourceHeartbeatCacheEntry | undefined,
  observation: SourcePollObservation,
  intervalMs = SOURCE_HEARTBEAT_WRITE_INTERVAL_MS
) {
  const observedAtMs = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAtMs)) return true;
  if (!previous) return true;
  if (previous.signature !== sourceHeartbeatSignature(observation)) return true;
  return observedAtMs - previous.persistedAtMs >= intervalMs;
}

export async function recordSourceHeartbeat(observation: SourcePollObservation) {
  const previous = heartbeatCache.get(observation.courtId);
  if (!shouldPersistSourceHeartbeat(previous, observation)) return false;

  const { error } = await supabaseAdmin().rpc("record_score_source_heartbeat", {
    p_court_id: observation.courtId,
    p_event_id: observation.eventId,
    p_match_id: observation.matchId,
    p_source_available: observation.sourceAvailable,
    p_successful: observation.successful,
    p_observed_at: observation.observedAt,
    p_error_message: observation.successful ? null : cleanError(observation.errorMessage)
  });
  if (error) throw error;

  heartbeatCache.set(observation.courtId, {
    signature: sourceHeartbeatSignature(observation),
    persistedAtMs: finiteTimestamp(observation.observedAt)
  });
  pruneHeartbeatCache();
  return true;
}

export function resetSourceHeartbeatCacheForTests() {
  heartbeatCache.clear();
}

function cleanError(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function finiteTimestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function pruneHeartbeatCache() {
  if (heartbeatCache.size <= SOURCE_HEARTBEAT_CACHE_LIMIT) return;
  const oldest = [...heartbeatCache.entries()]
    .sort((a, b) => a[1].persistedAtMs - b[1].persistedAtMs)
    .slice(0, heartbeatCache.size - SOURCE_HEARTBEAT_CACHE_LIMIT);
  for (const [courtId] of oldest) heartbeatCache.delete(courtId);
}
