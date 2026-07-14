import crypto from "node:crypto";
import { z } from "zod";
import { incidentFingerprint, SEVERITIES, STAGES, type IncidentSnapshot, type MonitorSnapshot, type MonitoringStage, type Severity } from "./contracts.js";
import { enrichIncidentChange } from "./incidentResolution.js";

const alertSchema = z.object({
  status: z.enum(["firing", "resolved"]),
  labels: z.record(z.string(), z.string()).default({}),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string().optional(),
  endsAt: z.string().optional()
}).passthrough();

export const alertmanagerWebhookSchema = z.object({
  status: z.enum(["firing", "resolved"]),
  alerts: z.array(alertSchema).max(200)
}).passthrough();

const alertmanagerApiAlertsSchema = z.array(z.object({
  labels: z.record(z.string(), z.string()).default({}),
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string().optional(),
  endsAt: z.string().optional()
}).passthrough()).max(500);

export type IncidentEventType = "OPENED" | "SEVERITY_CHANGED" | "EVIDENCE_UPDATED" | "ACKNOWLEDGED" | "RESOLVED";
export type IncidentChange = { incident: IncidentSnapshot; eventType: IncidentEventType; detail?: Record<string, string | number | boolean | null> };

export class IncidentManager {
  private readonly incidents = new Map<string, IncidentSnapshot>();

  applyWebhook(input: unknown, now = new Date()): IncidentChange[] {
    const payload = alertmanagerWebhookSchema.parse(input);
    const changed: IncidentChange[] = [];
    for (const alert of payload.alerts) {
      const normalized = normalizeAlert(alert);
      const existing = this.incidents.get(normalized.fingerprint);
      if (alert.status === "resolved") {
        if (!existing || existing.status === "resolved") continue;
        const resolved: IncidentSnapshot = {
          ...existing,
          status: "resolved",
          lastObservedAt: now.toISOString(),
          resolvedAt: validIso(alert.endsAt) ?? now.toISOString()
        };
        this.incidents.set(resolved.fingerprint, resolved);
        changed.push({ incident: resolved, eventType: "RESOLVED" });
        continue;
      }

      const newEpisode = !existing || existing.status === "resolved";
      const next: IncidentSnapshot = {
        id: newEpisode ? crypto.randomUUID() : existing.id,
        fingerprint: normalized.fingerprint,
        eventId: normalized.eventId,
        rootDependency: normalized.rootDependency,
        status: !newEpisode && existing.status === "acknowledged" ? "acknowledged" : "open",
        severity: normalized.severity,
        stage: normalized.stage,
        issueCode: normalized.issueCode,
        courtNumber: normalized.courtNumber,
        host: normalized.host,
        summary: normalized.summary,
        firstAction: normalized.firstAction,
        evidence: newEpisode ? normalized.evidence : { ...existing.evidence, ...normalized.evidence },
        openedAt: newEpisode ? validIso(alert.startsAt) ?? now.toISOString() : existing.openedAt,
        lastObservedAt: now.toISOString(),
        acknowledgedAt: newEpisode ? null : existing.acknowledgedAt,
        acknowledgedBy: newEpisode ? null : existing.acknowledgedBy,
        resolvedAt: null
      };
      this.incidents.set(next.fingerprint, next);
      changed.push({
        incident: next,
        eventType: newEpisode ? "OPENED" : existing.severity !== next.severity ? "SEVERITY_CHANGED" : "EVIDENCE_UPDATED"
      });
    }
    return changed;
  }

  reconcileActiveAlerts(input: unknown, now = new Date()): IncidentChange[] {
    const alerts = alertmanagerApiAlertsSchema.parse(input);
    const payload = {
      status: "firing" as const,
      alerts: alerts.map((alert) => ({ ...alert, status: "firing" as const }))
    };
    const observed = this.applyWebhook(payload, now);
    const activeFingerprints = new Set(alerts.map((alert) => normalizeAlert({ ...alert, status: "firing" }).fingerprint));
    const transitions = observed.filter((change) => change.eventType !== "EVIDENCE_UPDATED");
    for (const existing of this.active()) {
      if (activeFingerprints.has(existing.fingerprint)) continue;
      const resolved: IncidentSnapshot = {
        ...existing,
        status: "resolved",
        lastObservedAt: now.toISOString(),
        resolvedAt: now.toISOString()
      };
      this.incidents.set(resolved.fingerprint, resolved);
      transitions.push({ incident: resolved, eventType: "RESOLVED" });
    }
    return transitions;
  }

  active(): IncidentSnapshot[] {
    return [...this.incidents.values()]
      .filter((incident) => incident.status !== "resolved")
      .sort((left, right) => severityRank(right.severity) - severityRank(left.severity)
        || Date.parse(left.openedAt) - Date.parse(right.openedAt));
  }

  all(): IncidentSnapshot[] {
    return [...this.incidents.values()];
  }

  enrichChanges(changes: IncidentChange[], snapshot: MonitorSnapshot): IncidentChange[] {
    return changes.map((change) => {
      const enriched = enrichIncidentChange(change, snapshot);
      this.incidents.set(enriched.incident.fingerprint, enriched.incident);
      return enriched;
    });
  }

  hydrate(rows: IncidentSnapshot[]) {
    for (const row of rows) this.incidents.set(row.fingerprint, row);
  }

  acknowledge(id: string, actor: string, reason: string, now = new Date()): IncidentChange | null {
    const existing = [...this.incidents.values()].find((incident) => incident.id === id);
    if (!existing || existing.status === "resolved") return null;
    const next: IncidentSnapshot = {
      ...existing,
      status: "acknowledged",
      acknowledgedAt: now.toISOString(),
      acknowledgedBy: boundedOptional(actor) ?? "admin",
      lastObservedAt: now.toISOString()
    };
    this.incidents.set(next.fingerprint, next);
    return { incident: next, eventType: "ACKNOWLEDGED", detail: { reason: sanitizedText(reason, 300) } };
  }
}

function normalizeAlert(alert: z.infer<typeof alertSchema>) {
  const labels = alert.labels;
  const severity = SEVERITIES.includes(labels.severity as Severity) ? labels.severity as Severity : "warning";
  const stage = STAGES.includes(labels.stage as MonitoringStage) ? labels.stage as MonitoringStage : "MONITORING";
  const issueCode = boundedCode(labels.issue_code ?? labels.alertname ?? "UNKNOWN_ALERT");
  const courtNumber = court(labels.court);
  const host = boundedOptional(labels.host);
  const rootDependency = boundedCode(labels.root_dependency ?? labels.job ?? labels.alertname ?? "monitoring");
  const eventId = boundedOptional(labels.event_id);
  const summary = sanitizedText(alert.annotations.summary ?? alert.annotations.description ?? `${issueCode} detected.`, 240);
  const firstAction = optionalSanitizedText(alert.annotations.first_action, 300);
  const expectationSource = boundedExpectationSource(labels.expectation_source);
  return {
    severity,
    stage,
    issueCode,
    courtNumber,
    host,
    eventId,
    rootDependency,
    summary,
    firstAction,
    evidence: {
      expectationSource,
      alertName: boundedOptional(labels.alertname)
    },
    fingerprint: incidentFingerprint({
      eventId,
      rootDependency,
      stage,
      courtOrHost: courtNumber != null ? `court-${courtNumber}` : host ?? "shared",
      issueCode
    })
  };
}

function boundedExpectationSource(value: string | undefined): "fault_gate" | "control_plane" | null {
  return value === "fault_gate" || value === "control_plane" ? value : null;
}

function sanitizedText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
      } catch {
        return "[url removed]";
      }
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || "Monitoring condition detected.";
}

function optionalSanitizedText(value: string | undefined, maxLength: number): string | null {
  return value?.trim() ? sanitizedText(value, maxLength) : null;
}

function boundedCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9_.:-]+/g, "_").slice(0, 80) || "UNKNOWN";
}

function boundedOptional(value: string | undefined): string | null {
  if (!value) return null;
  const clean = value.replace(/[^a-zA-Z0-9_.:-]+/g, "-").slice(0, 80);
  return clean || null;
}

function court(value: string | undefined): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 8 ? number : null;
}

function validIso(value: string | undefined): string | null {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function severityRank(severity: Severity): number {
  return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
}
