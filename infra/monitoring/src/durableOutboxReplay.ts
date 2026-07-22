import type { IncidentStore } from "./incidentStore.js";
import type { LocalIncidentOutbox } from "./localIncidentOutbox.js";

type DurableStore = Pick<IncidentStore, "persist" | "persistNotification">;

export async function replayDurableOutbox(
  outbox: LocalIncidentOutbox,
  store: DurableStore
): Promise<{ incidentChanges: number; notifications: number }> {
  let incidentChanges = 0;
  let notifications = 0;
  for (const pending of outbox.pendingChanges()) {
    await store.persist(pending.change, pending.id);
    await outbox.markChangeReplicated(pending.id);
    incidentChanges += 1;
  }
  for (const pending of outbox.pendingNotifications()) {
    await store.persistNotification(pending.notification);
    await outbox.markNotificationReplicated(pending.notification.id, pending.revision);
    notifications += 1;
  }
  return { incidentChanges, notifications };
}
