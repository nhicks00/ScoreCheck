import crypto from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SEVERITIES, STAGES, type IncidentSnapshot } from "./contracts.js";
import type { IncidentChange, IncidentEventType } from "./incidents.js";
import type {
  NotificationKind,
  NotificationProvider,
  NotificationStatus,
  StoredNotification
} from "./incidentStore.js";

const MAX_INCIDENTS = 2_000;
const MAX_PENDING_CHANGES = 10_000;
const MAX_NOTIFICATIONS = 4_000;

type PendingIncidentChange = {
  id: string;
  change: IncidentChange;
};

type OutboxNotification = StoredNotification & {
  revision: number;
  replicatedRevision: number;
};

type OutboxDocument = {
  version: 1;
  incidentEpisodeContract: 0 | 1;
  incidents: IncidentSnapshot[];
  pendingChanges: PendingIncidentChange[];
  notifications: OutboxNotification[];
};

export class LocalIncidentOutbox {
  private writeTail = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private document: OutboxDocument
  ) {}

  static async open(filePath: string): Promise<LocalIncidentOutbox> {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let document: OutboxDocument;
    try {
      document = outboxDocumentSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Local monitoring outbox is invalid.", { cause: error });
      document = emptyDocument();
      await atomicWrite(filePath, document);
    }
    return new LocalIncidentOutbox(filePath, document);
  }

  hasVerifiedEpisodeContract(): boolean {
    return this.document.incidentEpisodeContract === 1;
  }

  async markEpisodeContractVerified(): Promise<void> {
    await this.mutate((document) => {
      document.incidentEpisodeContract = 1;
    });
  }

  loadActiveIncidents(): IncidentSnapshot[] {
    return this.document.incidents.filter((incident) => incident.status !== "resolved");
  }

  async mergeRemoteIncidents(incidents: IncidentSnapshot[]): Promise<void> {
    await this.mutate((document) => {
      const byId = new Map(document.incidents.map((incident) => [incident.id, incident]));
      for (const incident of incidents) {
        const local = byId.get(incident.id);
        if (!local || Date.parse(incident.lastObservedAt) >= Date.parse(local.lastObservedAt)) byId.set(incident.id, incident);
      }
      document.incidents = boundedNewest([...byId.values()], MAX_INCIDENTS, (incident) => incident.lastObservedAt);
    });
  }

  async mergeRemoteNotifications(records: StoredNotification[]): Promise<void> {
    await this.mutate((document) => {
      const remoteKeys = new Set<string>();
      const remoteIds = new Set<string>();
      for (const input of records) {
        const record = storedNotificationSchema.parse(input);
        const key = notificationKey(record);
        if (remoteKeys.has(key) || remoteIds.has(record.id)) throw new Error("Remote notification state contains duplicates.");
        remoteKeys.add(key);
        remoteIds.add(record.id);
        const local = document.notifications.find((entry) => notificationKey(entry) === key);
        if (!local) {
          document.notifications.push({ ...record, revision: 1, replicatedRevision: 1 });
          continue;
        }
        if (local.id !== record.id) throw new Error("Local and remote notification identities conflict.");
        if (local.revision === local.replicatedRevision) {
          Object.assign(local, record);
        }
      }
      if (document.notifications.length > MAX_NOTIFICATIONS) throw new Error("Local monitoring notification outbox is full.");
    });
  }

  async recordChanges(changes: IncidentChange[]): Promise<void> {
    if (changes.length === 0) return;
    await this.mutate((document) => {
      const incidents = new Map(document.incidents.map((incident) => [incident.id, incident]));
      const pendingKeys = new Set(document.pendingChanges.map((entry) => changeKey(entry.change)));
      for (const change of changes) {
        incidents.set(change.incident.id, change.incident);
        const key = changeKey(change);
        if (!pendingKeys.has(key)) {
          document.pendingChanges.push({ id: crypto.randomUUID(), change });
          pendingKeys.add(key);
        }
      }
      document.incidents = boundedNewest([...incidents.values()], MAX_INCIDENTS, (incident) => incident.lastObservedAt);
      if (document.pendingChanges.length > MAX_PENDING_CHANGES) throw new Error("Local monitoring incident outbox is full.");
    });
  }

  pendingChanges(): PendingIncidentChange[] {
    return structuredClone(this.document.pendingChanges);
  }

  async markChangeReplicated(id: string): Promise<void> {
    await this.mutate((document) => {
      document.pendingChanges = document.pendingChanges.filter((entry) => entry.id !== id);
    });
  }

  latestNotifications(): StoredNotification[] {
    return this.document.notifications.map(withoutReplicationState);
  }

  pendingNotifications(): Array<{ notification: StoredNotification; revision: number }> {
    return this.document.notifications
      .filter((notification) => notification.revision > notification.replicatedRevision)
      .map((notification) => ({ notification: withoutReplicationState(notification), revision: notification.revision }));
  }

  async markNotificationReplicated(id: string, revision: number): Promise<void> {
    await this.mutate((document) => {
      const notification = document.notifications.find((entry) => entry.id === id);
      if (notification && notification.revision === revision) notification.replicatedRevision = revision;
    });
  }

  async ensureNotification(
    incidentId: string,
    provider: NotificationProvider,
    kind: NotificationKind,
    now = new Date()
  ): Promise<{ notification: StoredNotification; created: boolean }> {
    return this.mutate((document) => {
      const existing = document.notifications.find((entry) => notificationKey(entry) === `${incidentId}:${provider}:${kind}`);
      if (existing) return { notification: withoutReplicationState(existing), created: false };
      if (document.notifications.length >= MAX_NOTIFICATIONS) throw new Error("Local monitoring notification outbox is full.");
      const notification: OutboxNotification = {
        id: crypto.randomUUID(),
        incidentId,
        provider,
        kind,
        providerMessageId: null,
        status: "pending",
        submittedAt: now.toISOString(),
        acceptedAt: null,
        deliveredAt: null,
        acknowledgedAt: null,
        expiredAt: null,
        escalatedAt: null,
        providerErrorCode: null,
        revision: 1,
        replicatedRevision: 0
      };
      document.notifications.push(notification);
      return { notification: withoutReplicationState(notification), created: true };
    });
  }

  async updateNotification(id: string, patch: Partial<{
    providerMessageId: string | null;
    status: NotificationStatus;
    acceptedAt: string | null;
    deliveredAt: string | null;
    acknowledgedAt: string | null;
    expiredAt: string | null;
    escalatedAt: string | null;
    providerErrorCode: string | null;
  }>): Promise<StoredNotification> {
    return this.mutate((document) => {
      const notification = requiredNotification(document, id);
      Object.assign(notification, patch);
      notification.revision += 1;
      return withoutReplicationState(notification);
    });
  }

  async rearmNotification(id: string, now = new Date()): Promise<StoredNotification> {
    return this.mutate((document) => {
      const notification = requiredNotification(document, id);
      Object.assign(notification, {
        providerMessageId: null,
        status: "pending" as const,
        submittedAt: now.toISOString(),
        acceptedAt: null,
        deliveredAt: null,
        acknowledgedAt: null,
        expiredAt: null,
        escalatedAt: null,
        providerErrorCode: null
      });
      notification.revision += 1;
      return withoutReplicationState(notification);
    });
  }

  async findNotification(
    incidentId: string,
    provider: NotificationProvider,
    kind: NotificationKind
  ): Promise<StoredNotification | null> {
    const notification = this.document.notifications.find((entry) => notificationKey(entry) === `${incidentId}:${provider}:${kind}`);
    return notification ? withoutReplicationState(notification) : null;
  }

  private async mutate<T>(mutation: (document: OutboxDocument) => T): Promise<T> {
    let result!: T;
    const operation = this.writeTail.then(async () => {
      const next = structuredClone(this.document);
      result = mutation(next);
      await atomicWrite(this.filePath, next);
      this.document = next;
    });
    this.writeTail = operation.catch(() => undefined);
    await operation;
    return result;
  }
}

async function atomicWrite(filePath: string, document: OutboxDocument): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const temporaryHandle = await open(temporary, "wx", 0o600);
  try {
    await temporaryHandle.writeFile(`${JSON.stringify(document)}\n`, { encoding: "utf8" });
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
  const directoryHandle = await open(path.dirname(filePath), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function emptyDocument(): OutboxDocument {
  return { version: 1, incidentEpisodeContract: 0, incidents: [], pendingChanges: [], notifications: [] };
}

function changeKey(change: IncidentChange): string {
  return `${change.incident.id}:${change.eventType}:${change.incident.lastObservedAt}`;
}

function notificationKey(notification: StoredNotification): string {
  return `${notification.incidentId}:${notification.provider}:${notification.kind}`;
}

function requiredNotification(document: OutboxDocument, id: string): OutboxNotification {
  const notification = document.notifications.find((entry) => entry.id === id);
  if (!notification) throw new Error("Local notification record is missing.");
  return notification;
}

function withoutReplicationState(notification: OutboxNotification): StoredNotification {
  const { revision: _revision, replicatedRevision: _replicatedRevision, ...record } = notification;
  return structuredClone(record);
}

function boundedNewest<T>(values: T[], maximum: number, timestamp: (value: T) => string): T[] {
  if (values.length <= maximum) return values;
  return values.sort((left, right) => Date.parse(timestamp(right)) - Date.parse(timestamp(left))).slice(0, maximum);
}

const iso = z.string().datetime({ offset: true });
const nullableIso = iso.nullable();
const incidentSchema = z.object({
  id: z.string().uuid(),
  fingerprint: z.string().min(1).max(500),
  eventId: z.string().uuid().nullable(),
  rootDependency: z.string().min(1).max(120),
  status: z.enum(["open", "acknowledged", "resolved"]),
  severity: z.enum(SEVERITIES),
  stage: z.enum(STAGES),
  issueCode: z.string().min(1).max(120),
  courtNumber: z.number().int().min(1).max(8).nullable(),
  host: z.string().max(255).nullable(),
  summary: z.string().max(1_000),
  firstAction: z.string().max(1_000).nullable(),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  openedAt: iso,
  lastObservedAt: iso,
  acknowledgedAt: nullableIso,
  acknowledgedBy: z.string().max(120).nullable(),
  resolvedAt: nullableIso
}).strict();
const incidentEventTypeSchema = z.enum(["OPENED", "SEVERITY_CHANGED", "EVIDENCE_UPDATED", "ACKNOWLEDGED", "RESOLVED"] satisfies [IncidentEventType, ...IncidentEventType[]]);
const incidentChangeSchema = z.object({
  incident: incidentSchema,
  eventType: incidentEventTypeSchema,
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
}).strict();
const storedNotificationSchema = z.object({
  id: z.string().uuid(),
  incidentId: z.string().uuid(),
  provider: z.literal("pushover"),
  kind: z.enum(["open", "recovery", "test"]),
  providerMessageId: z.string().max(80).nullable(),
  status: z.enum(["pending", "accepted", "delivered", "failed", "acknowledged", "expired", "cancelled"]),
  submittedAt: iso,
  acceptedAt: nullableIso,
  deliveredAt: nullableIso,
  acknowledgedAt: nullableIso,
  expiredAt: nullableIso,
  escalatedAt: nullableIso,
  providerErrorCode: z.string().max(120).nullable()
}).strict();
const notificationSchema = storedNotificationSchema.extend({
  revision: z.number().int().positive(),
  replicatedRevision: z.number().int().nonnegative()
}).strict();
const outboxDocumentSchema = z.object({
  version: z.literal(1),
  incidentEpisodeContract: z.union([z.literal(0), z.literal(1)]),
  incidents: z.array(incidentSchema).max(MAX_INCIDENTS),
  pendingChanges: z.array(z.object({ id: z.string().uuid(), change: incidentChangeSchema }).strict()).max(MAX_PENDING_CHANGES),
  notifications: z.array(notificationSchema).max(MAX_NOTIFICATIONS)
}).strict();
