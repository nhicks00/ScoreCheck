import { describe, expect, it, vi } from "vitest";
import type { IncidentSnapshot } from "./contracts.js";
import { IncidentStore } from "./incidentStore.js";

describe("incident episode persistence", () => {
  it("fails closed when the episode schema contract is absent", async () => {
    const store = storeWith({
      rpc: vi.fn(async () => ({ data: null, error: { code: "PGRST202" } }))
    });
    await expect(store.assertEpisodeContract()).rejects.toMatchObject({ code: "PGRST202" });
  });

  it("accepts only the installed episode schema contract", async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    const store = storeWith({ rpc });
    await expect(store.assertEpisodeContract()).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("monitoring_incident_episode_contract");
  });

  it("persists each episode by primary-key id rather than fingerprint", async () => {
    const writes: Array<{ table: string; operation: string; row: unknown; options?: unknown }> = [];
    const store = storeWith({
      from: (table: string) => ({
        upsert: async (row: unknown, options: unknown) => {
          writes.push({ table, operation: "upsert", row, options });
          return { error: null };
        },
        insert: async (row: unknown) => {
          writes.push({ table, operation: "insert", row });
          return { error: null };
        }
      })
    });

    await store.persist({ incident: incident(), eventType: "OPENED" });

    expect(writes[0]).toMatchObject({
      table: "monitoring_incidents",
      operation: "upsert",
      options: { onConflict: "id" }
    });
    expect(writes[1]).toMatchObject({
      table: "monitoring_incident_events",
      operation: "insert",
      row: { incident_id: "00000000-0000-4000-8000-000000000101", event_type: "OPENED" }
    });
  });

  it("replays incident events idempotently with the durable outbox event id", async () => {
    const writes: Array<{ table: string; operation: string; row: unknown; options?: unknown }> = [];
    const store = storeWith({
      from: (table: string) => ({
        upsert: async (row: unknown, options: unknown) => {
          writes.push({ table, operation: "upsert", row, options });
          return { error: null };
        }
      })
    });
    const eventId = "00000000-0000-4000-8000-000000000102";
    await store.persist({ incident: incident(), eventType: "OPENED" }, eventId);
    expect(writes[1]).toMatchObject({
      table: "monitoring_incident_events",
      operation: "upsert",
      row: { id: eventId },
      options: { onConflict: "id", ignoreDuplicates: true }
    });
  });
});

function storeWith(db: object): IncidentStore {
  const store = Object.create(IncidentStore.prototype) as IncidentStore;
  Reflect.set(store, "db", db);
  return store;
}

function incident(): IncidentSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    fingerprint: "no-event|mediamtx|raw_ingest|court-1|required_raw_path_missing",
    eventId: null,
    rootDependency: "MEDIAMTX",
    status: "open",
    severity: "critical",
    stage: "RAW_INGEST",
    issueCode: "REQUIRED_RAW_PATH_MISSING",
    courtNumber: 1,
    host: null,
    summary: "Camera 1 is offline.",
    firstAction: "Restart Camera 1.",
    evidence: { expectationSource: "fault_gate" },
    openedAt: "2026-07-14T15:26:15.709Z",
    lastObservedAt: "2026-07-14T15:26:20.709Z",
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null
  };
}
