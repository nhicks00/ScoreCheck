import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IncidentSnapshot } from "./contracts.js";
import type { IncidentStore, StoredNotification } from "./incidentStore.js";
import { NotificationDispatcher, validateTwilioSignature } from "./notifications.js";

describe("notification provider validation", () => {
  it("accepts only the exact Twilio callback signature", () => {
    const token = "test-auth-token";
    const url = "https://monitor.example.test/v1/provider/twilio/status";
    const params = { MessageStatus: "delivered", MessageSid: "SM0123456789" };
    const material = url + Object.keys(params).sort().map((key) => `${key}${params[key as keyof typeof params]}`).join("");
    const signature = crypto.createHmac("sha1", token).update(material).digest("base64");
    expect(validateTwilioSignature(token, url, params, signature)).toBe(true);
    expect(validateTwilioSignature(token, url, { ...params, MessageStatus: "failed" }, signature)).toBe(false);
    expect(validateTwilioSignature(token, url, params, "invalid")).toBe(false);
  });

  it("does not page an incident while a matching silence is active", async () => {
    const send = vi.fn<typeof fetch>();
    const dispatcher = new NotificationDispatcher(notificationConfig(), {} as IncidentStore, send);
    await dispatcher.handleChanges([{ incident: criticalIncident(), eventType: "OPENED" }], new Date(), () => true);
    expect(send).not.toHaveBeenCalled();
  });

  it("re-arms a cancelled emergency after silence expiry before starting SMS escalation", async () => {
    const now = new Date("2026-07-12T18:00:00.000Z");
    let notification = storedNotification({ status: "cancelled", submittedAt: "2026-07-12T17:30:00.000Z", expiredAt: "2026-07-12T17:45:00.000Z" });
    const store = {
      ensureNotification: vi.fn(async () => ({ notification, created: false })),
      rearmNotification: vi.fn(async () => {
        notification = storedNotification({ status: "pending", submittedAt: now.toISOString() });
        return notification;
      }),
      updateNotification: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        notification = { ...notification, ...patch } as StoredNotification;
        return notification;
      })
    } as unknown as IncidentStore;
    const calls: string[] = [];
    const send = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/messages.json")) return new Response(JSON.stringify({ status: 1, receipt: "receipt-1", request: "request-1" }), { status: 200 });
      return new Response(JSON.stringify({ status: 1, acknowledged: 0, expired: 0, last_delivered_at: 0 }), { status: 200 });
    });
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);
    await dispatcher.maintain([criticalIncident({ openedAt: "2026-07-12T17:00:00.000Z" })], now);
    expect(store.rearmNotification).toHaveBeenCalledOnce();
    expect(calls.some((url) => url.includes("api.pushover.net/1/messages.json"))).toBe(true);
    expect(calls.some((url) => url.includes("api.twilio.com"))).toBe(false);
  });
});

function notificationConfig() {
  return {
    monitorDashboardUrl: "https://score.example.test/admin/monitor",
    monitorPublicBaseUrl: "https://monitor.example.test",
    pushoverAppToken: "pushover-token",
    pushoverUserKey: "pushover-user",
    twilioAccountSid: "AC123",
    twilioAuthToken: "twilio-token",
    twilioFromNumber: "+15555550100",
    twilioToNumber: "+15555550200",
    notificationSmsEscalationMs: 120_000,
    notificationStatusIntervalMs: 30_000
  };
}

function criticalIncident(patch: Partial<IncidentSnapshot> = {}): IncidentSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    fingerprint: "event|mediamtx|RAW_INGEST|court-1|REQUIRED_RAW_PATH_MISSING",
    eventId: "00000000-0000-4000-8000-000000000002",
    rootDependency: "mediamtx",
    status: "open",
    severity: "critical",
    stage: "RAW_INGEST",
    issueCode: "REQUIRED_RAW_PATH_MISSING",
    courtNumber: 1,
    host: "bvm-preview-01",
    summary: "Raw ingest is missing.",
    firstAction: "Check the camera publish path.",
    openedAt: "2026-07-12T17:59:00.000Z",
    lastObservedAt: "2026-07-12T18:00:00.000Z",
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    ...patch
  };
}

function storedNotification(patch: Partial<StoredNotification> = {}): StoredNotification {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    incidentId: "00000000-0000-4000-8000-000000000001",
    provider: "pushover",
    kind: "open",
    providerMessageId: null,
    status: "pending",
    submittedAt: "2026-07-12T18:00:00.000Z",
    acceptedAt: null,
    deliveredAt: null,
    acknowledgedAt: null,
    expiredAt: null,
    escalatedAt: null,
    providerErrorCode: null,
    ...patch
  };
}
