import { getActiveEvent, getCourtByNumber } from "./eventConfig";
import { supabaseAdmin } from "./supabase";

const EVENT_DAY_EXPECTATION_TTL_MS = 18 * 60 * 60 * 1_000;

export type MonitoringExpectationValues = {
  coverage_phase: "OFF" | "WARMUP";
  media_expectation: "OFF" | "REQUIRED";
  broadcast_expectation: "OFF" | "LIVE";
  commentary_expectation: "NONE" | "OPTIONAL";
  scoring_expectation: "NONE" | "SCHEDULED";
  override_created_by: string | null;
  override_created_at: string | null;
  override_reason: string | null;
  override_expires_at: string | null;
  updated_at: string;
};

export function monitoringExpectationForBroadcast(
  action: "start" | "stop",
  now = new Date(),
  actor = "scorecheck-admin-production"
): MonitoringExpectationValues {
  const timestamp = now.toISOString();
  if (action === "stop") return offExpectation(timestamp);
  return {
    coverage_phase: "WARMUP",
    media_expectation: "REQUIRED",
    broadcast_expectation: "LIVE",
    commentary_expectation: "OPTIONAL",
    scoring_expectation: "SCHEDULED",
    override_created_by: actor,
    override_created_at: timestamp,
    override_reason: "Court broadcast started from the production console.",
    override_expires_at: new Date(now.getTime() + EVENT_DAY_EXPECTATION_TTL_MS).toISOString(),
    updated_at: timestamp
  };
}

export async function setCourtBroadcastMonitoringExpectation(courtNumber: number, action: "start" | "stop"): Promise<void> {
  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  if (!event) throw new Error("No active event is available for monitoring expectations.");
  const court = await getCourtByNumber(event.id, courtNumber, db);
  if (!court) throw new Error(`Court ${courtNumber} is missing from the active event.`);
  const { error } = await db.from("court_monitoring_expectations").upsert({
    event_id: event.id,
    court_id: court.id,
    ...monitoringExpectationForBroadcast(action)
  }, { onConflict: "event_id,court_id" });
  if (error) throw new Error(error.message || "Could not update court monitoring expectations.");
}

export async function initializeEventMonitoringOff(eventId: string): Promise<void> {
  const db = supabaseAdmin();
  const { data: courts, error: courtsError } = await db.from("courts").select("id").eq("event_id", eventId);
  if (courtsError) throw new Error(courtsError.message || "Could not load event courts for monitoring.");
  if (!courts?.length) return;
  const timestamp = new Date().toISOString();
  const rows = courts.map((court) => ({ event_id: eventId, court_id: court.id, ...offExpectation(timestamp) }));
  const { error } = await db.from("court_monitoring_expectations").upsert(rows, { onConflict: "event_id,court_id" });
  if (error) throw new Error(error.message || "Could not initialize event monitoring expectations.");
}

function offExpectation(timestamp: string): MonitoringExpectationValues {
  return {
    coverage_phase: "OFF",
    media_expectation: "OFF",
    broadcast_expectation: "OFF",
    commentary_expectation: "NONE",
    scoring_expectation: "NONE",
    override_created_by: null,
    override_created_at: null,
    override_reason: null,
    override_expires_at: null,
    updated_at: timestamp
  };
}
