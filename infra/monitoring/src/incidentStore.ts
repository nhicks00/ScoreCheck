import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { IncidentSnapshot, MonitoringSilence, MonitoringStage, MonitorSnapshot } from "./contracts.js";
import type { IncidentChange } from "./incidents.js";

export type NotificationProvider = "pushover";
export type NotificationKind = "open" | "recovery" | "test";
export type NotificationStatus = "pending" | "accepted" | "delivered" | "failed" | "acknowledged" | "expired" | "cancelled";
export type StoredNotification = {
  id: string;
  incidentId: string;
  provider: NotificationProvider;
  kind: NotificationKind;
  providerMessageId: string | null;
  status: NotificationStatus;
  submittedAt: string;
  acceptedAt: string | null;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  expiredAt: string | null;
  escalatedAt: string | null;
  providerErrorCode: string | null;
};

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
  evidence: unknown;
  opened_at: string;
  last_observed_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
};

type SilenceRow = {
  id: string;
  event_id: string | null;
  court_number: number | null;
  stage: MonitoringStage | null;
  issue_code: string | null;
  reason: string;
  created_by: string;
  created_at: string;
  expires_at: string;
};

export class IncidentStore {
  private constructor(private readonly db: SupabaseClient) {}

  static create(url: string | null, serviceRoleKey: string | null): IncidentStore | null {
    if (!url || !serviceRoleKey) return null;
    return new IncidentStore(createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    }));
  }

  async assertEpisodeContract(): Promise<void> {
    const { data, error } = await this.db.rpc("monitoring_incident_episode_contract");
    if (error || data !== 1) {
      throw error ?? Object.assign(new Error("Monitoring incident episode schema is unavailable."), { code: "INCIDENT_EPISODE_SCHEMA_MISSING" });
    }
  }

  async loadActive(): Promise<IncidentSnapshot[]> {
    const { data, error } = await this.db
      .from("monitoring_incidents")
      .select("id,fingerprint,event_id,court_number,host,shared_dependency,stage,issue_code,severity,status,summary,first_action,evidence,opened_at,last_observed_at,acknowledged_at,acknowledged_by,resolved_at")
      .neq("status", "resolved");
    if (error) throw error;
    return (data ?? []).map((row) => fromRow(row as IncidentRow));
  }

  async loadActiveSilences(now = new Date()): Promise<MonitoringSilence[]> {
    const { data, error } = await this.db
      .from("monitoring_silences")
      .select("id,event_id,court_number,stage,issue_code,reason,created_by,created_at,expires_at")
      .is("revoked_at", null)
      .gt("expires_at", now.toISOString())
      .order("expires_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => silenceFromRow(row as SilenceRow));
  }

  async createSilence(input: {
    eventId: string | null;
    courtNumber: number | null;
    stage: MonitoringStage | null;
    issueCode: string | null;
    reason: string;
    createdBy: string;
    expiresAt: string;
  }): Promise<MonitoringSilence> {
    const { data, error } = await this.db.from("monitoring_silences").insert({
      event_id: input.eventId,
      court_number: input.courtNumber,
      stage: input.stage,
      issue_code: input.issueCode,
      reason: input.reason,
      created_by: input.createdBy,
      expires_at: input.expiresAt
    }).select("id,event_id,court_number,stage,issue_code,reason,created_by,created_at,expires_at").single();
    if (error) throw error;
    return silenceFromRow(data as SilenceRow);
  }

  async persist(change: IncidentChange, eventId?: string): Promise<void> {
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
      evidence: incident.evidence,
      opened_at: incident.openedAt,
      last_observed_at: incident.lastObservedAt,
      acknowledged_at: incident.acknowledgedAt,
      acknowledged_by: incident.acknowledgedBy,
      resolved_at: incident.resolvedAt,
      updated_at: new Date().toISOString()
    }, { onConflict: "id" });
    if (error) throw error;

    const event = {
      ...(eventId ? { id: eventId } : {}),
      incident_id: incident.id,
      event_type: change.eventType,
      actor: change.eventType === "ACKNOWLEDGED" ? incident.acknowledgedBy : "monitor-service",
      detail: { severity: incident.severity, status: incident.status, ...(change.detail ?? {}) },
      occurred_at: incident.lastObservedAt
    };
    const { error: eventError } = eventId
      ? await this.db.from("monitoring_incident_events").upsert(event, { onConflict: "id", ignoreDuplicates: true })
      : await this.db.from("monitoring_incident_events").insert(event);
    if (eventError) throw eventError;
  }

  async persistNotification(notification: StoredNotification): Promise<void> {
    const { error } = await this.db.from("incident_notifications").upsert({
      id: notification.id,
      incident_id: notification.incidentId,
      provider: notification.provider,
      notification_kind: notification.kind,
      provider_message_id: notification.providerMessageId,
      status: notification.status,
      submitted_at: notification.submittedAt,
      accepted_at: notification.acceptedAt,
      delivered_at: notification.deliveredAt,
      acknowledged_at: notification.acknowledgedAt,
      expired_at: notification.expiredAt,
      escalated_at: notification.escalatedAt,
      provider_error_code: notification.providerErrorCode,
      updated_at: new Date().toISOString()
    }, { onConflict: "id" });
    if (error) throw error;
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

  async ensureNotification(
    incidentId: string,
    provider: NotificationProvider,
    kind: NotificationKind,
    now = new Date()
  ): Promise<{ notification: StoredNotification; created: boolean }> {
    const existing = await this.notificationByKey(incidentId, provider, kind);
    if (existing) return { notification: existing, created: false };
    const { data, error } = await this.db.from("incident_notifications").insert({
      incident_id: incidentId,
      provider,
      notification_kind: kind,
      status: "pending",
      submitted_at: now.toISOString(),
      updated_at: now.toISOString()
    }).select(NOTIFICATION_COLUMNS).single();
    if (!error && data) return { notification: notificationFromRow(data), created: true };
    if (error?.code === "23505") {
      const raced = await this.notificationByKey(incidentId, provider, kind);
      if (raced) return { notification: raced, created: false };
    }
    throw error ?? new Error("Notification claim failed.");
  }

  async updateNotification(id: string, patch: Partial<{
    providerMessageId: string | null;
    status: NotificationStatus;
    acceptedAt: string | null;
    deliveredAt: string | null;
    acknowledgedAt: string | null;
    expiredAt: string | null;
    escalatedAt: string | null;
    providerErrorCode: string | null;
  }>): Promise<StoredNotification> {
    const now = new Date().toISOString();
    const row: Record<string, unknown> = { updated_at: now };
    if ("providerMessageId" in patch) row.provider_message_id = patch.providerMessageId;
    if ("status" in patch) row.status = patch.status;
    if ("acceptedAt" in patch) row.accepted_at = patch.acceptedAt;
    if ("deliveredAt" in patch) row.delivered_at = patch.deliveredAt;
    if ("acknowledgedAt" in patch) row.acknowledged_at = patch.acknowledgedAt;
    if ("expiredAt" in patch) row.expired_at = patch.expiredAt;
    if ("escalatedAt" in patch) row.escalated_at = patch.escalatedAt;
    if ("providerErrorCode" in patch) row.provider_error_code = patch.providerErrorCode;
    const { data, error } = await this.db.from("incident_notifications").update(row).eq("id", id).select(NOTIFICATION_COLUMNS).single();
    if (error) throw error;
    return notificationFromRow(data);
  }

  async rearmNotification(id: string, now = new Date()): Promise<StoredNotification> {
    const { data, error } = await this.db.from("incident_notifications").update({
      provider_message_id: null,
      status: "pending",
      submitted_at: now.toISOString(),
      accepted_at: null,
      delivered_at: null,
      acknowledged_at: null,
      expired_at: null,
      escalated_at: null,
      provider_error_code: null,
      updated_at: now.toISOString()
    }).eq("id", id).select(NOTIFICATION_COLUMNS).single();
    if (error) throw error;
    return notificationFromRow(data);
  }

  async notificationByProviderId(provider: NotificationProvider, providerMessageId: string): Promise<StoredNotification | null> {
    const { data, error } = await this.db.from("incident_notifications")
      .select(NOTIFICATION_COLUMNS)
      .eq("provider", provider)
      .eq("provider_message_id", providerMessageId)
      .maybeSingle();
    if (error) throw error;
    return data ? notificationFromRow(data) : null;
  }

  async latestProviderNotifications(): Promise<StoredNotification[]> {
    const { data, error } = await this.db.from("incident_notifications")
      .select(NOTIFICATION_COLUMNS)
      .eq("provider", "pushover")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    const latest = new Map<NotificationProvider, StoredNotification>();
    for (const row of data ?? []) {
      const notification = notificationFromRow(row);
      if (!latest.has(notification.provider)) latest.set(notification.provider, notification);
    }
    return [...latest.values()];
  }

  async loadNotificationsForIncidents(incidentIds: string[]): Promise<StoredNotification[]> {
    const ids = [...new Set(incidentIds)];
    if (ids.length === 0) return [];
    const { data, error } = await this.db.from("incident_notifications")
      .select(NOTIFICATION_COLUMNS)
      .in("incident_id", ids)
      .order("submitted_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => notificationFromRow(row));
  }

  async findNotification(incidentId: string, provider: NotificationProvider, kind: NotificationKind): Promise<StoredNotification | null> {
    return this.notificationByKey(incidentId, provider, kind);
  }

  async appendSilencedEvent(incidentId: string, silence: MonitoringSilence): Promise<void> {
    const { error } = await this.db.from("monitoring_incident_events").insert({
      incident_id: incidentId,
      event_type: "SILENCED",
      actor: silence.createdBy,
      detail: { silenceId: silence.id, reason: silence.reason, expiresAt: silence.expiresAt },
      occurred_at: silence.createdAt
    });
    if (error) throw error;
  }

  private async notificationByKey(incidentId: string, provider: NotificationProvider, kind: NotificationKind): Promise<StoredNotification | null> {
    const { data, error } = await this.db.from("incident_notifications")
      .select(NOTIFICATION_COLUMNS)
      .eq("incident_id", incidentId)
      .eq("provider", provider)
      .eq("notification_kind", kind)
      .maybeSingle();
    if (error) throw error;
    return data ? notificationFromRow(data) : null;
  }
}

const NOTIFICATION_COLUMNS = "id,incident_id,provider,notification_kind,provider_message_id,status,submitted_at,accepted_at,delivered_at,acknowledged_at,expired_at,escalated_at,provider_error_code";

function notificationFromRow(row: Record<string, unknown>): StoredNotification {
  return {
    id: String(row.id),
    incidentId: String(row.incident_id),
    provider: row.provider as NotificationProvider,
    kind: row.notification_kind as NotificationKind,
    providerMessageId: typeof row.provider_message_id === "string" ? row.provider_message_id : null,
    status: row.status as NotificationStatus,
    submittedAt: String(row.submitted_at),
    acceptedAt: typeof row.accepted_at === "string" ? row.accepted_at : null,
    deliveredAt: typeof row.delivered_at === "string" ? row.delivered_at : null,
    acknowledgedAt: typeof row.acknowledged_at === "string" ? row.acknowledged_at : null,
    expiredAt: typeof row.expired_at === "string" ? row.expired_at : null,
    escalatedAt: typeof row.escalated_at === "string" ? row.escalated_at : null,
    providerErrorCode: typeof row.provider_error_code === "string" ? row.provider_error_code : null
  };
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
    evidence: flatEvidence(row.evidence),
    openedAt: row.opened_at,
    lastObservedAt: row.last_observed_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    resolvedAt: row.resolved_at
  };
}

function flatEvidence(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string | number | boolean | null] => {
    const item = entry[1];
    return item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean";
  }));
}

function silenceFromRow(row: SilenceRow): MonitoringSilence {
  return {
    id: row.id,
    eventId: row.event_id,
    courtNumber: row.court_number,
    stage: row.stage,
    issueCode: row.issue_code,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function uuidOrNull(value: string | null): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
