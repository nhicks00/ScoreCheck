import type { ServiceConfig } from "./config.js";
import type { IncidentSnapshot, NotificationHealth } from "./contracts.js";
import type { IncidentChange } from "./incidents.js";
import { IncidentStore, type StoredNotification } from "./incidentStore.js";
import { operatorNotificationCopy } from "./operatorNotificationCopy.js";

type NotificationConfig = Pick<ServiceConfig,
  | "monitorDashboardUrl"
  | "pushoverAppToken"
  | "pushoverUserKey"
  | "notificationStatusIntervalMs"
>;

type ProviderState = {
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
};

export class NotificationDispatcher {
  private readonly lastProviderPollAt = new Map<string, number>();
  private readonly providerHealth: ProviderState;

  constructor(
    private readonly config: NotificationConfig,
    private readonly store: IncidentStore | null,
    private readonly send: typeof fetch = fetch
  ) {
    this.providerHealth = { configured: this.pushoverConfigured(), lastSuccessAt: null, lastFailureAt: null };
  }

  health(): NotificationHealth {
    const state = !this.providerHealth.configured
      ? "NOT_APPLICABLE"
      : this.providerHealth.lastFailureAt
        ? "DEGRADED"
        : this.providerHealth.lastSuccessAt
          ? "HEALTHY"
          : "UNKNOWN";
    return { state, pushover: { ...this.providerHealth } };
  }

  hydrate(records: StoredNotification[]): void {
    for (const record of records) {
      if (record.provider !== "pushover" || !this.providerHealth.configured) continue;
      const successAt = record.deliveredAt ?? record.acknowledgedAt ?? record.acceptedAt;
      if (record.status === "failed") this.providerHealth.lastFailureAt = record.submittedAt;
      else if (successAt) {
        this.providerHealth.lastSuccessAt = successAt;
        this.providerHealth.lastFailureAt = null;
      }
    }
  }

  async handleChanges(changes: IncidentChange[], now = new Date(), isSilenced: (incident: IncidentSnapshot) => boolean = () => false): Promise<void> {
    if (!this.store) return;
    for (const change of changes) {
      if (change.eventType === "ACKNOWLEDGED") {
        await this.cancelEmergency(change.incident, now);
        continue;
      }
      if (change.eventType === "RESOLVED") {
        await this.cancelEmergency(change.incident, now);
        if (change.detail?.resolutionKind === "DEPENDENCY_RECOVERED" && !isSilenced(change.incident)) {
          await this.sendRecovery(change.incident, now);
        }
        continue;
      }
      if (isSilenced(change.incident)) continue;
      if (change.incident.severity === "critical" && ["OPENED", "SEVERITY_CHANGED"].includes(change.eventType)) {
        await this.ensureCriticalPage(change.incident, now);
      }
    }
  }

  async maintain(activeIncidents: IncidentSnapshot[], now = new Date(), isSilenced: (incident: IncidentSnapshot) => boolean = () => false): Promise<Array<{ incidentId: string; actor: string; reason: string }>> {
    if (!this.store) return [];
    const acknowledgements: Array<{ incidentId: string; actor: string; reason: string }> = [];
    for (const incident of activeIncidents) {
      if (incident.severity !== "critical" || incident.status === "acknowledged" || isSilenced(incident)) continue;
      const pushover = await this.ensureCriticalPage(incident, now);
      if (pushover?.providerMessageId && ["accepted", "delivered"].includes(pushover.status)) {
        const acknowledged = await this.pollPushoverReceipt(pushover, now);
        if (acknowledged) acknowledgements.push({ incidentId: incident.id, actor: "pushover", reason: "Acknowledged from the emergency push notification." });
      }
    }
    return acknowledgements;
  }

  async silence(incident: IncidentSnapshot, now = new Date()): Promise<void> {
    await this.cancelEmergency(incident, now);
  }

  private async ensureCriticalPage(incident: IncidentSnapshot, now: Date): Promise<StoredNotification | null> {
    if (!this.store || !this.pushoverConfigured()) return null;
    const claim = await this.store.ensureNotification(incident.id, "pushover", "open", now);
    let notification = claim.notification;
    let shouldSubmit = claim.created;
    if (!claim.created && ["cancelled", "expired"].includes(notification.status)) {
      notification = await this.store.rearmNotification(notification.id, now);
      shouldSubmit = true;
    }
    const ageMs = now.getTime() - Date.parse(notification.submittedAt);
    if (!shouldSubmit && (notification.status !== "pending" || ageMs < 30_000)) return notification;
    try {
      const result = await this.sendPushover(incident, true);
      const accepted = await this.store.updateNotification(notification.id, {
        providerMessageId: result.receipt,
        status: "accepted",
        acceptedAt: now.toISOString(),
        providerErrorCode: null
      });
      this.mark("success", now.toISOString());
      return accepted;
    } catch {
      await this.store.updateNotification(notification.id, { status: "failed", providerErrorCode: "submission-failed" });
      this.mark("failure", now.toISOString());
      return null;
    }
  }

  private async sendRecovery(incident: IncidentSnapshot, now: Date): Promise<void> {
    if (!this.store || !this.pushoverConfigured()) return;
    const opening = await this.store.findNotification(incident.id, "pushover", "open");
    if (!notificationWasSent(opening)) return;
    const claim = await this.store.ensureNotification(incident.id, "pushover", "recovery", now);
    if (!claim.created) return;
    try {
      const result = await this.sendPushover(incident, false);
      await this.store.updateNotification(claim.notification.id, {
        providerMessageId: result.request,
        status: "accepted",
        acceptedAt: now.toISOString(),
        providerErrorCode: null
      });
      this.mark("success", now.toISOString());
    } catch {
      await this.store.updateNotification(claim.notification.id, { status: "failed", providerErrorCode: "submission-failed" });
      this.mark("failure", now.toISOString());
    }
  }

  private async pollPushoverReceipt(notification: StoredNotification, now: Date): Promise<boolean> {
    if (!this.store || !this.config.pushoverAppToken || !notification.providerMessageId) return false;
    const pollKey = `pushover:${notification.providerMessageId}`;
    const previous = this.lastProviderPollAt.get(pollKey) ?? 0;
    if (now.getTime() - previous < this.config.notificationStatusIntervalMs) return false;
    this.lastProviderPollAt.set(pollKey, now.getTime());
    const url = new URL(`https://api.pushover.net/1/receipts/${encodeURIComponent(notification.providerMessageId)}.json`);
    url.searchParams.set("token", this.config.pushoverAppToken);
    try {
      const response = await this.send(url, { signal: AbortSignal.timeout(8_000) });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok || payload.status !== 1) throw new Error("Receipt lookup failed.");
      if (payload.acknowledged === 1) {
        await this.store.updateNotification(notification.id, { status: "acknowledged", acknowledgedAt: unixIso(payload.acknowledged_at) ?? now.toISOString() });
        this.mark("success", now.toISOString());
        return true;
      }
      if (payload.expired === 1) {
        await this.store.updateNotification(notification.id, { status: "expired", expiredAt: unixIso(payload.expires_at) ?? now.toISOString() });
      } else if (Number(payload.last_delivered_at) > 0 && notification.status !== "delivered") {
        await this.store.updateNotification(notification.id, { status: "delivered", deliveredAt: unixIso(payload.last_delivered_at) ?? now.toISOString() });
      }
      this.mark("success", now.toISOString());
    } catch {
      this.mark("failure", now.toISOString());
    }
    return false;
  }

  private async cancelEmergency(incident: IncidentSnapshot, now: Date): Promise<void> {
    if (!this.store || !this.config.pushoverAppToken) return;
    const notification = await this.store.findNotification(incident.id, "pushover", "open");
    if (!notification?.providerMessageId || ["acknowledged", "expired", "cancelled", "failed"].includes(notification.status)) return;
    const body = new URLSearchParams({ token: this.config.pushoverAppToken });
    try {
      const response = await this.send(`https://api.pushover.net/1/receipts/${encodeURIComponent(notification.providerMessageId)}/cancel.json`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error("Cancel failed.");
      await this.store.updateNotification(notification.id, { status: "cancelled", expiredAt: now.toISOString() });
      this.mark("success", now.toISOString());
    } catch {
      this.mark("failure", now.toISOString());
    }
  }

  private async sendPushover(incident: IncidentSnapshot, emergency: boolean): Promise<{ receipt: string | null; request: string | null }> {
    const copy = operatorNotificationCopy(incident);
    const body = new URLSearchParams({
      token: this.config.pushoverAppToken!,
      user: this.config.pushoverUserKey!,
      title: emergency ? copy.title : copy.recoveryTitle,
      message: emergency ? `Problem: ${copy.problem}\nDo this: ${copy.action}` : copy.recovery,
      url: `${this.config.monitorDashboardUrl}?incident=${encodeURIComponent(incident.id)}`,
      url_title: "Open ScoreCheck monitor",
      priority: emergency ? "2" : "0"
    });
    if (emergency) {
      body.set("retry", "60");
      body.set("expire", "900");
      body.set("tags", `incident-${incident.id}`);
    }
    const response = await this.send("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8_000)
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || payload.status !== 1) throw new Error("Pushover submission failed.");
    const receipt = boundedProviderId(payload.receipt);
    if (emergency && !receipt) throw new Error("Pushover receipt missing.");
    return { receipt, request: boundedProviderId(payload.request) };
  }

  private pushoverConfigured(): boolean {
    return Boolean(this.store && this.config.pushoverAppToken && this.config.pushoverUserKey);
  }

  private mark(result: "success" | "failure", timestamp: string) {
    if (result === "success") {
      this.providerHealth.lastSuccessAt = timestamp;
      this.providerHealth.lastFailureAt = null;
    } else {
      this.providerHealth.lastFailureAt = timestamp;
    }
  }
}

function notificationWasSent(notification: StoredNotification | null): boolean {
  if (!notification?.providerMessageId) return false;
  return ["accepted", "delivered", "acknowledged", "expired", "cancelled"].includes(notification.status);
}

function boundedProviderId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
}

function unixIso(value: unknown): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000).toISOString() : null;
}
