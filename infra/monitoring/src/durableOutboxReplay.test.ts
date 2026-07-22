import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IncidentChange } from "./incidents.js";
import { IncidentManager } from "./incidents.js";
import type { IncidentStore, StoredNotification } from "./incidentStore.js";
import { LocalIncidentOutbox } from "./localIncidentOutbox.js";
import { NotificationDispatcher } from "./notifications.js";
import { replayDurableOutbox } from "./durableOutboxReplay.js";

describe("durable Supabase outage replay", () => {
  it("retains one complete page and recovery episode through outage, restart, and idempotent replay", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scorecheck-outbox-replay-"));
    try {
      const filePath = path.join(directory, "incident-outbox.json");
      const manager = new IncidentManager();
      const opened = manager.applyWebhook(alert("firing"), new Date("2026-07-22T12:00:00.000Z"));
      const outbox = await LocalIncidentOutbox.open(filePath);
      await outbox.markEpisodeContractVerified();
      await outbox.recordChanges(opened);
      const send = pushoverTransport();
      await new NotificationDispatcher(notificationConfig(), outbox, send).handleChanges(opened, new Date("2026-07-22T12:00:00.000Z"));

      const restarted = await LocalIncidentOutbox.open(filePath);
      expect(restarted.hasVerifiedEpisodeContract()).toBe(true);
      expect(restarted.loadActiveIncidents()).toHaveLength(1);
      const restartedManager = new IncidentManager();
      restartedManager.hydrate(restarted.loadActiveIncidents());
      const resolved = restartedManager.applyWebhook(alert("resolved"), new Date("2026-07-22T12:05:00.000Z"))
        .map((change): IncidentChange => ({ ...change, detail: { resolutionKind: "DEPENDENCY_RECOVERED" } }));
      await restarted.recordChanges(resolved);
      const restartedDispatcher = new NotificationDispatcher(notificationConfig(), restarted, send);
      restartedDispatcher.hydrate(restarted.latestNotifications());
      await restartedDispatcher.handleChanges(resolved, new Date("2026-07-22T12:05:00.000Z"));

      await expect(replayDurableOutbox(restarted, unavailableStore())).rejects.toThrow("Supabase unavailable");
      expect(restarted.pendingChanges()).toHaveLength(2);
      expect(restarted.pendingNotifications()).toHaveLength(2);

      const persistedChanges: IncidentChange[] = [];
      const persistedNotifications: StoredNotification[] = [];
      const recoveredStore = {
        persist: vi.fn(async (change: IncidentChange) => { persistedChanges.push(change); }),
        persistNotification: vi.fn(async (notification: StoredNotification) => { persistedNotifications.push(notification); })
      } as unknown as Pick<IncidentStore, "persist" | "persistNotification">;
      expect(await replayDurableOutbox(restarted, recoveredStore)).toEqual({ incidentChanges: 2, notifications: 2 });
      expect(persistedChanges.map((change) => change.eventType)).toEqual(["OPENED", "RESOLVED"]);
      expect(persistedChanges[0]?.incident.id).toBe(persistedChanges[1]?.incident.id);
      expect(persistedNotifications.map((notification) => [notification.kind, notification.status])).toEqual([
        ["open", "cancelled"],
        ["recovery", "accepted"]
      ]);
      expect(restarted.pendingChanges()).toEqual([]);
      expect(restarted.pendingNotifications()).toEqual([]);
      expect(await replayDurableOutbox(restarted, recoveredStore)).toEqual({ incidentChanges: 0, notifications: 0 });
      expect(recoveredStore.persist).toHaveBeenCalledTimes(2);
      expect(recoveredStore.persistNotification).toHaveBeenCalledTimes(2);
      expect(send.mock.calls.filter(([url]) => String(url).includes("/messages.json"))).toHaveLength(2);
      expect(send.mock.calls.filter(([url]) => String(url).includes("/cancel.json"))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function alert(status: "firing" | "resolved") {
  return {
    status,
    alerts: [{
      status,
      labels: {
        alertname: "ScoreCheckSupabaseUnavailable",
        severity: "critical",
        stage: "SCORING",
        issue_code: "SUPABASE_UNAVAILABLE",
        root_dependency: "supabase",
        event_id: "00000000-0000-4000-8000-000000000777",
        court: "1"
      },
      annotations: { summary: "Score data is unavailable.", first_action: "Keep the stream running and inspect Supabase." },
      startsAt: "2026-07-22T12:00:00.000Z",
      ...(status === "resolved" ? { endsAt: "2026-07-22T12:05:00.000Z" } : {})
    }]
  };
}

function unavailableStore() {
  return {
    persist: vi.fn(async () => { throw new Error("Supabase unavailable"); }),
    persistNotification: vi.fn(async () => { throw new Error("Supabase unavailable"); })
  } as unknown as Pick<IncidentStore, "persist" | "persistNotification">;
}

function notificationConfig() {
  return {
    monitorDashboardUrl: "https://monitor.example.com",
    pushoverAppToken: "app-token",
    pushoverUserKey: "user-key",
    notificationStatusIntervalMs: 30_000
  };
}

function pushoverTransport() {
  let message = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/cancel.json")) return new Response(JSON.stringify({ status: 1 }), { status: 200 });
    message += 1;
    return new Response(JSON.stringify(message === 1
      ? { status: 1, receipt: "receipt-outage", request: "request-outage" }
      : { status: 1, request: "request-recovery" }), { status: 200 });
  });
}
