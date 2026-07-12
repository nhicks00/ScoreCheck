import crypto from "node:crypto";
import { z } from "zod";
import { incidentFingerprint, SEVERITIES, STAGES, type IncidentSnapshot, type MonitoringStage, type Severity } from "./contracts.js";

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

export class IncidentManager {
  private readonly incidents = new Map<string, IncidentSnapshot>();

  applyWebhook(input: unknown, now = new Date()): IncidentSnapshot[] {
    const payload = alertmanagerWebhookSchema.parse(input);
    const changed: IncidentSnapshot[] = [];
    for (const alert of payload.alerts) {
      const normalized = normalizeAlert(alert);
      const existing = this.incidents.get(normalized.fingerprint);
      if (alert.status === "resolved") {
        if (!existing) continue;
        const resolved: IncidentSnapshot = {
          ...existing,
          status: "resolved",
          lastObservedAt: now.toISOString(),
          resolvedAt: validIso(alert.endsAt) ?? now.toISOString()
        };
        this.incidents.set(resolved.fingerprint, resolved);
        changed.push(resolved);
        continue;
      }

      const next: IncidentSnapshot = {
        id: existing?.id ?? crypto.randomUUID(),
        fingerprint: normalized.fingerprint,
        status: existing?.status === "acknowledged" ? "acknowledged" : "open",
        severity: normalized.severity,
        stage: normalized.stage,
        issueCode: normalized.issueCode,
        courtNumber: normalized.courtNumber,
        host: normalized.host,
        summary: normalized.summary,
        firstAction: normalized.firstAction,
        openedAt: existing?.openedAt ?? validIso(alert.startsAt) ?? now.toISOString(),
        lastObservedAt: now.toISOString(),
        resolvedAt: null
      };
      this.incidents.set(next.fingerprint, next);
      changed.push(next);
    }
    return changed;
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
}

function normalizeAlert(alert: z.infer<typeof alertSchema>) {
  const labels = alert.labels;
  const severity = SEVERITIES.includes(labels.severity as Severity) ? labels.severity as Severity : "warning";
  const stage = STAGES.includes(labels.stage as MonitoringStage) ? labels.stage as MonitoringStage : "MONITORING";
  const issueCode = boundedCode(labels.issue_code ?? labels.alertname ?? "UNKNOWN_ALERT");
  const courtNumber = court(labels.court);
  const host = boundedOptional(labels.host);
  const rootDependency = boundedCode(labels.root_dependency ?? labels.job ?? labels.alertname ?? "monitoring");
  const summary = sanitizedText(alert.annotations.summary ?? alert.annotations.description ?? `${issueCode} detected.`, 240);
  const firstAction = optionalSanitizedText(alert.annotations.first_action, 300);
  return {
    severity,
    stage,
    issueCode,
    courtNumber,
    host,
    summary,
    firstAction,
    fingerprint: incidentFingerprint({
      eventId: boundedOptional(labels.event_id),
      rootDependency,
      stage,
      courtOrHost: courtNumber != null ? `court-${courtNumber}` : host ?? "shared",
      issueCode
    })
  };
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
