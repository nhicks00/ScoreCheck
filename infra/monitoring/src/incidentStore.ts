import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { IncidentSnapshot, MonitorSnapshot } from "./contracts.js";
import type { IncidentChange } from "./incidents.js";

type IncidentRow = {
  id: string;
  fingerprint: string;
  event_id: string | null;
  court_number: number | null;
  host: string | null;
  shared_dependency: string | null;
  stage: IncidentSnapshot["stage"];
  issue_code: string;
  severity: IncidentSnapshot["severity"];
  status: IncidentSnapshot["status"];
  summary: string;
  first_action: string | null;
  opened_at: string;
  last_observed_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
};

export class IncidentStore {
  private constructor(private readonly db: SupabaseClient) {}

  static create(url: string | null, serviceRoleKey: string | null): IncidentStore | null {
    if (!url || !serviceRoleKey) return null;
    return new IncidentStore(createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    }));
  }

  async loadActive(): Promise<IncidentSnapshot[]> {
    const { data, error } = await this.db
      .from("monitoring_incidents")
      .select("id,fingerprint,event_id,court_number,host,shared_dependency,stage,issue_code,severity,status,summary,first_action,opened_at,last_observed_at,acknowledged_at,acknowledged_by,resolved_at")
      .neq("status", "resolved");
    if (error) throw error;
    return (data ?? []).map((row) => fromRow(row as IncidentRow));
  }

  async persist(change: IncidentChange): Promise<void> {
    const incident = change.incident;
    const { error } = await this.db.from("monitoring_incidents").upsert({
      id: incident.id,
      fingerprint: incident.fingerprint,
      event_id: uuidOrNull(incident.eventId),
      court_number: incident.courtNumber,
      host: incident.host,
      shared_dependency: incident.rootDependency,
      stage: incident.stage,
      issue_code: incident.issueCode,
      severity: incident.severity,
      status: incident.status,
      confidence: "high",
      summary: incident.summary,
      first_action: incident.firstAction,
      evidence: {},
      opened_at: incident.openedAt,
      last_observed_at: incident.lastObservedAt,
      acknowledged_at: incident.acknowledgedAt,
      acknowledged_by: incident.acknowledgedBy,
      resolved_at: incident.resolvedAt,
      updated_at: new Date().toISOString()
    }, { onConflict: "fingerprint" });
    if (error) throw error;

    const { error: eventError } = await this.db.from("monitoring_incident_events").insert({
      incident_id: incident.id,
      event_type: change.eventType,
      actor: change.eventType === "ACKNOWLEDGED" ? incident.acknowledgedBy : "monitor-service",
      detail: { severity: incident.severity, status: incident.status },
      occurred_at: incident.lastObservedAt
    });
    if (eventError) throw eventError;
  }

  async checkpoint(snapshot: MonitorSnapshot): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.db.from("monitoring_checkpoints").upsert({
      scope: "global",
      event_id: null,
      payload: snapshot,
      observed_at: snapshot.generatedAt,
      updated_at: now
    }, { onConflict: "scope" });
    if (error) throw error;
  }
}

function fromRow(row: IncidentRow): IncidentSnapshot {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    eventId: row.event_id,
    rootDependency: row.shared_dependency ?? "monitoring",
    status: row.status,
    severity: row.severity,
    stage: row.stage,
    issueCode: row.issue_code,
    courtNumber: row.court_number,
    host: row.host,
    summary: row.summary,
    firstAction: row.first_action,
    openedAt: row.opened_at,
    lastObservedAt: row.last_observed_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    resolvedAt: row.resolved_at
  };
}

function uuidOrNull(value: string | null): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
