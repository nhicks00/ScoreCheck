import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IncidentSnapshot } from "./contracts.js";
import type { IncidentStore, StoredNotification } from "./incidentStore.js";
import { NotificationDispatcher } from "./notifications.js";
import { LocalIncidentOutbox } from "./localIncidentOutbox.js";

describe("Pushover notification delivery", () => {
  it("pages from the local durable claim even when Supabase is unavailable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scorecheck-notification-"));
    try {
      const outbox = await LocalIncidentOutbox.open(path.join(directory, "outbox.json"));
      const send = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
        status: 1,
        receipt: "receipt-local",
        request: "request-local"
      }), { status: 200 }));
      const dispatcher = new NotificationDispatcher(notificationConfig(), outbox, send);
      await dispatcher.handleChanges([{ incident: criticalIncident(), eventType: "OPENED" }]);
      expect(send).toHaveBeenCalledOnce();
      expect(outbox.latestNotifications()).toMatchObject([{
        incidentId: criticalIncident().id,
        status: "accepted",
        providerMessageId: "receipt-local"
      }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hydrates Pushover health from durable provider history", () => {
    const dispatcher = new NotificationDispatcher(notificationConfig(), {} as IncidentStore);
    dispatcher.hydrate([storedNotification({ status: "delivered", deliveredAt: "2026-07-12T18:00:30.000Z" })]);
    expect(dispatcher.health()).toEqual({
      state: "HEALTHY",
      pushover: { configured: true, lastSuccessAt: "2026-07-12T18:00:30.000Z", lastFailureAt: null }
    });
  });

  it("does not page an incident while a matching silence is active", async () => {
    const send = vi.fn<typeof fetch>();
    const dispatcher = new NotificationDispatcher(notificationConfig(), {} as IncidentStore, send);
    await dispatcher.handleChanges([{ incident: criticalIncident(), eventType: "OPENED" }], new Date(), () => true);
    expect(send).not.toHaveBeenCalled();
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
  });

  it("re-arms a cancelled emergency after a silence expires", async () => {
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
    const send = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/messages.json")) return new Response(JSON.stringify({ status: 1, receipt: "receipt-1", request: "request-1" }), { status: 200 });
      return new Response(JSON.stringify({ status: 1, acknowledged: 0, expired: 0, last_delivered_at: 0 }), { status: 200 });
    });
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);
    await dispatcher.maintain([criticalIncident()], now);
    expect(store.rearmNotification).toHaveBeenCalledOnce();
    expect(send.mock.calls.some(([url]) => String(url).includes("api.pushover.net/1/messages.json"))).toBe(true);
  });

  it("does not announce recovery for an incident that never paged", async () => {
    const store = { findNotification: vi.fn(async () => null) } as unknown as IncidentStore;
    const send = vi.fn<typeof fetch>();
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);
    await dispatcher.handleChanges([{
      incident: criticalIncident({ severity: "warning", status: "resolved", resolvedAt: "2026-07-12T18:01:00.000Z" }),
      eventType: "RESOLVED",
      detail: { resolutionKind: "DEPENDENCY_RECOVERED" }
    }], new Date("2026-07-12T18:01:00.000Z"));
    expect(send).not.toHaveBeenCalled();
  });

  it("announces one Pushover recovery when the dependency actually recovers", async () => {
    const opening = storedNotification({ providerMessageId: "receipt-1", status: "delivered", deliveredAt: "2026-07-12T18:00:30.000Z" });
    const recovery = storedNotification({ id: "00000000-0000-4000-8000-000000000004", kind: "recovery" });
    const store = {
      findNotification: vi.fn(async () => opening),
      ensureNotification: vi.fn(async () => ({ notification: recovery, created: true })),
      updateNotification: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...recovery, ...patch }))
    } as unknown as IncidentStore;
    const send = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/cancel.json")) return new Response(JSON.stringify({ status: 1 }), { status: 200 });
      return new Response(JSON.stringify({ status: 1, request: "request-recovery" }), { status: 200 });
    });
    const dispatcher = new NotificationDispatcher(notificationConfig(), store, send);
    await dispatcher.handleChanges([{
      incident: criticalIncident({ status: "resolved", resolvedAt: "2026-07-12T18:01:00.000Z" }),
      eventType: "RESOLVED",
      detail: { resolutionKind: "DEPENDENCY_RECOVERED" }
    }], new Date("2026-07-12T18:01:00.000Z"));
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.ensureNotification).toHaveBeenCalledWith(opening.incidentId, "pushover", "recovery", expect.any(Date));
  });

  it("cancels the emergency without announcing recovery when an expectation ends", async () => {
    const opening = storedNotification({ providerMessageId: "receipt-1", status: "delivered", deliveredAt: "2026-07-12T18:00:30.000Z" });
    const store = {
      findNotification: vi.fn(async () => opening),
      updateNotification: vi.fn(async (_id: string, patch: Record<string, unknown>) => ({ ...opening, ...patch })),
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
