import crypto from "node:crypto";
import type { ServiceConfig } from "./config.js";
import type { IncidentSnapshot, NotificationHealth } from "./contracts.js";
import type { IncidentChange } from "./incidents.js";
import { IncidentStore, type NotificationKind, type NotificationStatus, type StoredNotification } from "./incidentStore.js";

type NotificationConfig = Pick<ServiceConfig,
  | "monitorDashboardUrl"
  | "monitorPublicBaseUrl"
  | "pushoverAppToken"
  | "pushoverUserKey"
  | "twilioAccountSid"
  | "twilioAuthToken"
  | "twilioFromNumber"
  | "twilioToNumber"
  | "notificationSmsEscalationMs"
  | "notificationStatusIntervalMs"
>;

type ProviderState = {
  configured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
};

export class NotificationDispatcher {
  private readonly lastReceiptPollAt = new Map<string, number>();
  private readonly providerHealth: { pushover: ProviderState; twilioSms: ProviderState };

  constructor(
    private readonly config: NotificationConfig,
    private readonly store: IncidentStore | null,
    private readonly send: typeof fetch = fetch
  ) {
    this.providerHealth = {
      pushover: { configured: this.pushoverConfigured(), lastSuccessAt: null, lastFailureAt: null },
      twilioSms: { configured: this.twilioConfigured(), lastSuccessAt: null, lastFailureAt: null }
    };
  }

  health(): NotificationHealth {
    const configured = this.providerHealth.pushover.configured || this.providerHealth.twilioSms.configured;
    const failed = Boolean(this.providerHealth.pushover.lastFailureAt || this.providerHealth.twilioSms.lastFailureAt);
    const unverified = [this.providerHealth.pushover, this.providerHealth.twilioSms]
      .some((provider) => provider.configured && !provider.lastSuccessAt);
    return {
      state: !configured ? "NOT_APPLICABLE" : failed ? "DEGRADED" : unverified ? "UNKNOWN" : "HEALTHY",
      pushover: { ...this.providerHealth.pushover },
      twilioSms: { ...this.providerHealth.twilioSms }
    };
  }

  hydrate(records: StoredNotification[]): void {
    for (const record of records) {
      const provider = record.provider === "pushover" ? "pushover" : "twilioSms";
      const successAt = record.deliveredAt ?? record.acknowledgedAt ?? record.acceptedAt;
      if (record.status === "failed") this.providerHealth[provider].lastFailureAt = record.submittedAt;
      else if (successAt) {
        this.providerHealth[provider].lastSuccessAt = successAt;
        this.providerHealth[provider].lastFailureAt = null;
      }
    }
  }

  async handleChanges(changes: IncidentChange[], now = new Date()): Promise<void> {
    if (!this.store) return;
    for (const change of changes) {
      if (change.eventType === "ACKNOWLEDGED") {
        await this.cancelEmergency(change.incident, now);
        continue;
      }
      if (change.eventType === "RESOLVED") {
        await this.cancelEmergency(change.incident, now);
        await this.sendRecovery(change.incident, now);
        continue;
      }
      if (change.incident.severity === "critical" && ["OPENED", "REOPENED", "SEVERITY_CHANGED"].includes(change.eventType)) {
        await this.ensureCriticalPage(change.incident, now);
      }
    }
  }

  async maintain(activeIncidents: IncidentSnapshot[], now = new Date()): Promise<Array<{ incidentId: string; actor: string; reason: string }>> {
    if (!this.store) return [];
    const acknowledgements: Array<{ incidentId: string; actor: string; reason: string }> = [];
    for (const incident of activeIncidents) {
      if (incident.severity !== "critical" || incident.status === "acknowledged") continue;
      const pushover = await this.ensureCriticalPage(incident, now);
      if (pushover?.providerMessageId && ["accepted", "delivered"].includes(pushover.status)) {
        const acknowledged = await this.pollPushoverReceipt(pushover, now);
        if (acknowledged) acknowledgements.push({ incidentId: incident.id, actor: "pushover", reason: "Acknowledged from the emergency push notification." });
      }
      if (now.getTime() - Date.parse(incident.openedAt) >= this.config.notificationSmsEscalationMs) {
        await this.ensureSms(incident, "escalation", now);
      }
    }
    return acknowledgements;
  }

  async applyTwilioStatus(params: Record<string, string>, signature: string): Promise<boolean> {
    if (!this.store || !this.config.twilioAuthToken) return false;
    const callbackUrl = `${this.config.monitorPublicBaseUrl}/v1/provider/twilio/status`;
    if (!validateTwilioSignature(this.config.twilioAuthToken, callbackUrl, params, signature)) return false;
    const messageId = boundedProviderId(params.MessageSid);
    const status = twilioStatus(params.MessageStatus);
    if (!messageId || !status) return false;
    const existing = await this.store.notificationByProviderId("twilio_sms", messageId);
    if (!existing) return true;
    const timestamp = new Date().toISOString();
    await this.store.updateNotification(existing.id, {
      status,
      deliveredAt: status === "delivered" ? timestamp : existing.deliveredAt,
      providerErrorCode: boundedError(params.ErrorCode)
    });
    this.mark("twilioSms", status === "failed" ? "failure" : "success", timestamp);
    return true;
  }

  private async ensureCriticalPage(incident: IncidentSnapshot, now: Date): Promise<StoredNotification | null> {
    if (!this.store) return null;
    if (!this.pushoverConfigured()) {
      if (this.twilioConfigured()) await this.ensureSms(incident, "open", now);
      return null;
    }
    const claim = await this.store.ensureNotification(incident.id, "pushover", "open", now);
    const ageMs = now.getTime() - Date.parse(claim.notification.submittedAt);
    if (!claim.created && (claim.notification.status !== "pending" || ageMs < 30_000)) return claim.notification;
    try {
      const result = await this.sendPushover(incident, true);
      const accepted = await this.store.updateNotification(claim.notification.id, {
        providerMessageId: result.receipt,
        status: "accepted",
        acceptedAt: now.toISOString(),
        providerErrorCode: null
      });
      this.mark("pushover", "success", now.toISOString());
      return accepted;
    } catch {
      await this.store.updateNotification(claim.notification.id, { status: "failed", providerErrorCode: "submission-failed" });
      this.mark("pushover", "failure", now.toISOString());
      if (this.twilioConfigured()) await this.ensureSms(incident, "open", now);
      return null;
    }
  }

  private async ensureSms(incident: IncidentSnapshot, kind: Extract<NotificationKind, "open" | "escalation" | "recovery">, now: Date): Promise<void> {
    if (!this.store || !this.twilioConfigured()) return;
    const claim = await this.store.ensureNotification(incident.id, "twilio_sms", kind, now);
    const ageMs = now.getTime() - Date.parse(claim.notification.submittedAt);
    if (!claim.created && (claim.notification.status !== "pending" || ageMs < 30_000)) return;
    try {
      const result = await this.sendTwilio(incident, kind);
      await this.store.updateNotification(claim.notification.id, {
        providerMessageId: result.sid,
        status: mapTwilioInitialStatus(result.status),
        acceptedAt: now.toISOString(),
        escalatedAt: kind === "escalation" ? now.toISOString() : null,
        providerErrorCode: boundedError(result.errorCode)
      });
      if (kind === "escalation") await this.store.appendIncidentEvent(incident.id, "ESCALATED", { provider: "twilio_sms" });
      this.mark("twilioSms", "success", now.toISOString());
    } catch {
      await this.store.updateNotification(claim.notification.id, { status: "failed", providerErrorCode: "submission-failed" });
      this.mark("twilioSms", "failure", now.toISOString());
    }
  }

  private async sendRecovery(incident: IncidentSnapshot, now: Date): Promise<void> {
    if (!this.store) return;
    if (this.pushoverConfigured()) {
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
        this.mark("pushover", "success", now.toISOString());
      } catch {
        await this.store.updateNotification(claim.notification.id, { status: "failed", providerErrorCode: "submission-failed" });
        this.mark("pushover", "failure", now.toISOString());
      }
      return;
    }
    await this.ensureSms(incident, "recovery", now);
  }

  private async pollPushoverReceipt(notification: StoredNotification, now: Date): Promise<boolean> {
    if (!this.store || !this.config.pushoverAppToken || !notification.providerMessageId) return false;
    const previous = this.lastReceiptPollAt.get(notification.providerMessageId) ?? 0;
    if (now.getTime() - previous < this.config.notificationStatusIntervalMs) return false;
    this.lastReceiptPollAt.set(notification.providerMessageId, now.getTime());
    const url = new URL(`https://api.pushover.net/1/receipts/${encodeURIComponent(notification.providerMessageId)}.json`);
    url.searchParams.set("token", this.config.pushoverAppToken);
    try {
      const response = await this.send(url, { signal: AbortSignal.timeout(8_000) });
      const payload = await response.json() as Record<string, unknown>;
      if (!response.ok || payload.status !== 1) throw new Error("Receipt lookup failed.");
      if (payload.acknowledged === 1) {
        await this.store.updateNotification(notification.id, { status: "acknowledged", acknowledgedAt: unixIso(payload.acknowledged_at) ?? now.toISOString() });
        this.mark("pushover", "success", now.toISOString());
        return true;
      }
      if (payload.expired === 1) {
        await this.store.updateNotification(notification.id, { status: "expired", expiredAt: unixIso(payload.expires_at) ?? now.toISOString() });
      } else if (Number(payload.last_delivered_at) > 0 && notification.status !== "delivered") {
        await this.store.updateNotification(notification.id, { status: "delivered", deliveredAt: unixIso(payload.last_delivered_at) ?? now.toISOString() });
      }
      this.mark("pushover", "success", now.toISOString());
    } catch {
      this.mark("pushover", "failure", now.toISOString());
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
      this.mark("pushover", "success", now.toISOString());
    } catch {
      this.mark("pushover", "failure", now.toISOString());
    }
  }

  private async sendPushover(incident: IncidentSnapshot, emergency: boolean): Promise<{ receipt: string | null; request: string | null }> {
    const body = new URLSearchParams({
      token: this.config.pushoverAppToken!,
      user: this.config.pushoverUserKey!,
      title: emergency ? incidentTitle(incident) : `ScoreCheck recovered${courtLabel(incident)}`,
      message: emergency ? incidentMessage(incident) : `${incident.stage}: ${incident.summary}`,
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

  private async sendTwilio(incident: IncidentSnapshot, kind: NotificationKind): Promise<{ sid: string; status: string; errorCode: unknown }> {
    const body = new URLSearchParams({
      To: this.config.twilioToNumber!,
      From: this.config.twilioFromNumber!,
      Body: kind === "recovery" ? `ScoreCheck recovered${courtLabel(incident)}: ${incident.stage} - ${incident.summary}` : `${incidentTitle(incident)}: ${incidentMessage(incident)}`,
      StatusCallback: `${this.config.monitorPublicBaseUrl}/v1/provider/twilio/status`
    });
    const response = await this.send(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.twilioAccountSid!)}/Messages.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.twilioAccountSid}:${this.config.twilioAuthToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body,
      signal: AbortSignal.timeout(8_000)
    });
    const payload = await response.json() as Record<string, unknown>;
    const sid = boundedProviderId(payload.sid);
    if (!response.ok || !sid) throw new Error("Twilio submission failed.");
    return { sid, status: typeof payload.status === "string" ? payload.status : "accepted", errorCode: payload.error_code };
  }

  private pushoverConfigured(): boolean {
    return Boolean(this.store && this.config.pushoverAppToken && this.config.pushoverUserKey);
  }

  private twilioConfigured(): boolean {
    return Boolean(this.store && this.config.twilioAccountSid && this.config.twilioAuthToken && this.config.twilioFromNumber && this.config.twilioToNumber);
  }

  private mark(provider: "pushover" | "twilioSms", result: "success" | "failure", timestamp: string) {
    if (result === "success") {
      this.providerHealth[provider].lastSuccessAt = timestamp;
      this.providerHealth[provider].lastFailureAt = null;
    } else {
      this.providerHealth[provider].lastFailureAt = timestamp;
    }
  }
}

export function validateTwilioSignature(authToken: string, url: string, params: Record<string, string>, presented: string): boolean {
  if (!authToken || !presented) return false;
  const material = url + Object.keys(params).sort().map((key) => `${key}${params[key] ?? ""}`).join("");
  const expected = crypto.createHmac("sha1", authToken).update(material).digest();
  let received: Buffer;
  try {
    received = Buffer.from(presented, "base64");
  } catch {
    return false;
  }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function incidentTitle(incident: IncidentSnapshot): string {
  return `ScoreCheck CRITICAL${courtLabel(incident)}`.slice(0, 250);
}

function incidentMessage(incident: IncidentSnapshot): string {
  return `${incident.stage}: ${incident.summary}${incident.firstAction ? ` First: ${incident.firstAction}` : ""}`.slice(0, 1_000);
}

function courtLabel(incident: IncidentSnapshot): string {
  return incident.courtNumber == null ? "" : ` · Court ${incident.courtNumber}`;
}

function boundedProviderId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : null;
}

function boundedError(value: unknown): string | null {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return /^[a-zA-Z0-9_.:-]{1,80}$/.test(text) ? text : null;
}

function unixIso(value: unknown): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1_000).toISOString() : null;
}

function twilioStatus(value: string | undefined): NotificationStatus | null {
  if (["accepted", "queued", "sending", "sent"].includes(value ?? "")) return "accepted";
  if (["delivered", "read"].includes(value ?? "")) return "delivered";
  if (["failed", "undelivered", "canceled"].includes(value ?? "")) return "failed";
  return null;
}

function mapTwilioInitialStatus(value: string): NotificationStatus {
  return twilioStatus(value) ?? "accepted";
}
