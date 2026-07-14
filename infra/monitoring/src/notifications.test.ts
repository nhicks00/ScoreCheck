import { describe, expect, it, vi } from "vitest";
import type { IncidentSnapshot } from "./contracts.js";
import type { IncidentStore, StoredNotification } from "./incidentStore.js";
import { NotificationDispatcher } from "./notifications.js";

describe("notification provider validation", () => {
  it("does not page an incident while a matching silence is active", async () => {
    const send = vi.fn<typeof fetch>();
    const dispatcher = new NotificationDispatcher(notificationConfig(), {} as IncidentStore, send);
    await dispatcher.handleChanges([{ incident: criticalIncident(), eventType: "OPENED" }], new Date(), () => true);
    expect(send).not.toHaveBeenCalled();
  });

  it("uses the restricted API key pair for Twilio message submission", async () => {
    const notification = storedNotification({ provider: "twilio_sms" });
    const store = {
      ensureNotification: vi.fn(async () => ({ notification, created: true })),
      updateNotification: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...notification, ...patch }))
    } as unknown as IncidentStore;
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      sid: "SM0123456789",
      status: "queued",
      error_code: null
    }), { status: 201 }));
    const config = { ...notificationConfig(), pushoverAppToken: null, pushoverUserKey: null };
    const dispatcher = new NotificationDispatcher(config, store, send);
    await dispatcher.handleChanges([{ incident: criticalIncident(), eventType: "OPENED" }]);

    expect(send).toHaveBeenCalledOnce();
    const init = send.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("SK123:api-secret").toString("base64")}`);
  });

  it("deduplicates within an episode but pages a recurring fingerprint in a new episode", async () => {
    const records = new Map<string, StoredNotification>();
    let sequence = 0;
    const store = {
      ensureNotification: vi.fn(async (incidentId: string, provider: "pushover", kind: "open", now: Date) => {
        const key = `${incidentId}:${provider}:${kind}`;
        const existing = records.get(key);
        if (existing) return { notification: existing, created: false };
        const notification = storedNotification({
          id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
          incidentId,
          provider,
          kind,
          submittedAt: now.toISOString()
        });
        records.set(key, notification);
        return { notification, created: true };
      }),
      updateNotification: vi.fn(async (id: string, patch: Partial<StoredNotification>) => {
        const entry = [...records.entries()].find(([, notification]) => notification.id === id);
        if (!entry) throw new Error("notification not found");
        const updated = { ...entry[1], ...patch };
        records.set(entry[0], updated);
        return updated;
      })
    } as unknown as IncidentStore;
    let sendSequence = 0;
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      status: 1,
      receipt: `receipt-${++sendSequence}`,
      request: `request-${sendSequence}`
    }), { status: 200 }));
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);
    const first = criticalIncident();
    const second = criticalIncident({ id: "00000000-0000-4000-8000-000000000099", openedAt: "2026-07-12T19:00:00.000Z" });

    await dispatcher.handleChanges([{ incident: first, eventType: "OPENED" }], new Date("2026-07-12T18:00:00.000Z"));
    await dispatcher.handleChanges([{ incident: first, eventType: "EVIDENCE_UPDATED" }], new Date("2026-07-12T18:00:10.000Z"));
    await dispatcher.handleChanges([{ incident: second, eventType: "OPENED" }], new Date("2026-07-12T19:00:00.000Z"));

    expect(send).toHaveBeenCalledTimes(2);
    expect(records.size).toBe(2);
    expect([...records.values()].map((notification) => notification.incidentId)).toEqual([first.id, second.id]);
  });

  it("polls a nonterminal Twilio notification to its terminal delivery state", async () => {
    const now = new Date("2026-07-12T18:01:00.000Z");
    const notification = storedNotification({
      provider: "twilio_sms",
      providerMessageId: "SM0123456789",
      status: "accepted",
      acceptedAt: "2026-07-12T18:00:00.000Z"
    });
    const store = {
      pendingProviderNotifications: vi.fn(async () => [notification]),
      updateNotification: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...notification, ...patch }))
    } as unknown as IncidentStore;
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      status: "delivered",
      error_code: null
    }), { status: 200 }));
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);
    await dispatcher.maintain([], now);

    expect(store.pendingProviderNotifications).toHaveBeenCalledWith("twilio_sms", now);
    expect(store.updateNotification).toHaveBeenCalledWith(notification.id, {
      status: "delivered",
      deliveredAt: now.toISOString(),
      providerErrorCode: null
    });
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Basic ${Buffer.from("SK123:api-secret").toString("base64")}`);
  });

  it("re-arms a cancelled emergency after silence expiry before starting SMS escalation", async () => {
    const now = new Date("2026-07-12T18:00:00.000Z");
    let notification = storedNotification({ status: "cancelled", submittedAt: "2026-07-12T17:30:00.000Z", expiredAt: "2026-07-12T17:45:00.000Z" });
    const store = {
      pendingProviderNotifications: vi.fn(async () => []),
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

  it("does not announce recovery for an incident that never paged", async () => {
    const store = {
      findNotification: vi.fn(async () => null)
    } as unknown as IncidentStore;
    const send = vi.fn<typeof fetch>();
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);
    await dispatcher.handleChanges([{
      incident: criticalIncident({ severity: "warning", status: "resolved", resolvedAt: "2026-07-12T18:01:00.000Z" }),
      eventType: "RESOLVED"
    }], new Date("2026-07-12T18:01:00.000Z"));
    expect(send).not.toHaveBeenCalled();
  });

  it("announces one recovery on each provider that sent the incident", async () => {
    const openPushover = storedNotification({ providerMessageId: "receipt-1", status: "delivered", deliveredAt: "2026-07-12T18:00:30.000Z" });
    const recovery = storedNotification({ id: "00000000-0000-4000-8000-000000000004", kind: "recovery" });
    const store = {
      findNotification: vi.fn(async (_incidentId: string, provider: string, kind: string) => provider === "pushover" && kind === "open" ? openPushover : null),
      ensureNotification: vi.fn(async () => ({ notification: recovery, created: true })),
      updateNotification: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...recovery, ...patch }))
    } as unknown as IncidentStore;
    const send = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/cancel.json")) return new Response(JSON.stringify({ status: 1 }), { status: 200 });
      return new Response(JSON.stringify({ status: 1, request: "request-recovery" }), { status: 200 });
    });
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);
    await dispatcher.handleChanges([{
      incident: criticalIncident({ status: "resolved", resolvedAt: "2026-07-12T18:01:00.000Z" }),
      eventType: "RESOLVED",
      detail: { resolutionKind: "DEPENDENCY_RECOVERED" }
    }], new Date("2026-07-12T18:01:00.000Z"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.ensureNotification).toHaveBeenCalledWith(openPushover.incidentId, "pushover", "recovery", expect.any(Date));
  });

  it("cancels the emergency without announcing recovery when an expectation ends", async () => {
    const openPushover = storedNotification({ providerMessageId: "receipt-1", status: "delivered", deliveredAt: "2026-07-12T18:00:30.000Z" });
    const store = {
      findNotification: vi.fn(async () => openPushover),
      updateNotification: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...openPushover, ...patch })),
      ensureNotification: vi.fn()
    } as unknown as IncidentStore;
    const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: 1 }), { status: 200 }));
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);

    await dispatcher.handleChanges([{
      incident: criticalIncident({ status: "resolved", resolvedAt: "2026-07-12T18:01:00.000Z" }),
      eventType: "RESOLVED",
      detail: { resolutionKind: "FAULT_GATE_EXPIRED" }
    }], new Date("2026-07-12T18:01:00.000Z"));

    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0]?.[0])).toContain("/cancel.json");
    expect(store.ensureNotification).not.toHaveBeenCalled();
  });
});

function notificationConfig() {
  return {
    monitorDashboardUrl: "https://score.example.test/admin/monitor",
    pushoverAppToken: "pushover-token",
    pushoverUserKey: "pushover-user",
    twilioAccountSid: "AC123",
    twilioApiKeySid: "SK123",
    twilioApiKeySecret: "api-secret",
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
    evidence: {},
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
