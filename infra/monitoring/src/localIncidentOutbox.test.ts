import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IncidentSnapshot } from "./contracts.js";
import { LocalIncidentOutbox } from "./localIncidentOutbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local incident outbox", () => {
  it("survives restart with incident, notification, and schema-verification state", async () => {
    const filePath = await temporaryOutboxPath();
    const outbox = await LocalIncidentOutbox.open(filePath);
    await outbox.markEpisodeContractVerified();
    await outbox.recordChanges([{ incident: incident(), eventType: "OPENED" }]);
    const claim = await outbox.ensureNotification(incident().id, "pushover", "open", new Date("2026-07-21T12:00:00.000Z"));
    await outbox.updateNotification(claim.notification.id, {
      providerMessageId: "receipt-1",
      status: "accepted",
      acceptedAt: "2026-07-21T12:00:01.000Z"
    });

    const restarted = await LocalIncidentOutbox.open(filePath);
    expect(restarted.hasVerifiedEpisodeContract()).toBe(true);
    expect(restarted.loadActiveIncidents()).toEqual([incident()]);
    expect(restarted.pendingChanges()).toHaveLength(1);
    expect(restarted.latestNotifications()).toMatchObject([{
      incidentId: incident().id,
      providerMessageId: "receipt-1",
      status: "accepted"
    }]);
    expect(restarted.pendingNotifications()).toHaveLength(1);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 1, incidentEpisodeContract: 1 });
  });

  it("deduplicates a notification within one incident episode and separates a later episode", async () => {
    const outbox = await LocalIncidentOutbox.open(await temporaryOutboxPath());
    const first = await outbox.ensureNotification(incident().id, "pushover", "open");
    const duplicate = await outbox.ensureNotification(incident().id, "pushover", "open");
    const recurrence = await outbox.ensureNotification("00000000-0000-4000-8000-000000000202", "pushover", "open");
    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ notification: first.notification, created: false });
    expect(recurrence.created).toBe(true);
    expect(recurrence.notification.id).not.toBe(first.notification.id);
  });

  it("imports remote active-episode notifications before local paging resumes", async () => {
    const outbox = await LocalIncidentOutbox.open(await temporaryOutboxPath());
    const remote = storedNotification();
    await outbox.mergeRemoteNotifications([remote]);

    const claim = await outbox.ensureNotification(remote.incidentId, "pushover", "open");

    expect(claim).toEqual({ notification: remote, created: false });
    expect(outbox.pendingNotifications()).toEqual([]);
  });

  it("fails closed when local and remote dedupe keys disagree on notification identity", async () => {
    const outbox = await LocalIncidentOutbox.open(await temporaryOutboxPath());
    const local = await outbox.ensureNotification(incident().id, "pushover", "open");
    await expect(outbox.mergeRemoteNotifications([{
      ...storedNotification(),
      id: "00000000-0000-4000-8000-000000000299"
    }])).rejects.toThrow("identities conflict");
    expect(await outbox.findNotification(incident().id, "pushover", "open")).toEqual(local.notification);
  });

  it("acknowledges only the exact notification revision replicated remotely", async () => {
    const outbox = await LocalIncidentOutbox.open(await temporaryOutboxPath());
    const claim = await outbox.ensureNotification(incident().id, "pushover", "open");
    const [firstPending] = outbox.pendingNotifications();
    await outbox.updateNotification(claim.notification.id, { status: "failed", providerErrorCode: "submission-failed" });
    await outbox.markNotificationReplicated(claim.notification.id, firstPending!.revision);
    expect(outbox.pendingNotifications()).toHaveLength(1);
    const [current] = outbox.pendingNotifications();
    await outbox.markNotificationReplicated(claim.notification.id, current!.revision);
    expect(outbox.pendingNotifications()).toEqual([]);
  });

  it("fails closed instead of discarding a corrupt durable file", async () => {
    const filePath = await temporaryOutboxPath();
    await writeFile(filePath, "not-json\n", { mode: 0o600 });
    await expect(LocalIncidentOutbox.open(filePath)).rejects.toThrow("Local monitoring outbox is invalid.");
  });
});

async function temporaryOutboxPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scorecheck-outbox-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "incident-outbox.json");
}

function incident(): IncidentSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    fingerprint: "event|mediamtx|RAW_INGEST|court-1|REQUIRED_RAW_PATH_MISSING",
    eventId: "00000000-0000-4000-8000-000000000200",
    rootDependency: "mediamtx",
    status: "open",
    severity: "critical",
    stage: "RAW_INGEST",
    issueCode: "REQUIRED_RAW_PATH_MISSING",
    courtNumber: 1,
    host: "bvm-preview-01",
    summary: "Camera 1 is offline.",
    firstAction: "Restart Camera 1.",
    evidence: {},
    openedAt: "2026-07-21T12:00:00.000Z",
    lastObservedAt: "2026-07-21T12:00:00.000Z",
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null
  };
}

function storedNotification() {
  return {
    id: "00000000-0000-4000-8000-000000000250",
    incidentId: incident().id,
    provider: "pushover" as const,
    kind: "open" as const,
    providerMessageId: "receipt-remote",
    status: "accepted" as const,
    submittedAt: "2026-07-21T12:00:01.000Z",
    acceptedAt: "2026-07-21T12:00:02.000Z",
    deliveredAt: null,
    acknowledgedAt: null,
    expiredAt: null,
    escalatedAt: null,
    providerErrorCode: null
  };
}
