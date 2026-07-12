import { z } from "zod";

export const MONITORING_CONTRACT_VERSION = 1 as const;

export const AGENT_ROLES = [
  "mediamtx",
  "commentary",
  "compositor",
  "worker",
  "venue",
  "observability"
] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export const HEALTH_STATES = [
  "EXPECTED_OFF",
  "STARTING",
  "HEALTHY",
  "DEGRADED",
  "CRITICAL",
  "RECOVERING",
  "UNKNOWN",
  "MAINTENANCE",
  "NOT_APPLICABLE"
] as const;
export type HealthState = typeof HEALTH_STATES[number];

export const STAGES = [
  "VENUE",
  "RAW_INGEST",
  "PREVIEW",
  "PROGRAM_PATH",
  "PROGRAM_BROWSER",
  "COMMENTARY",
  "SCORE_SOURCE",
  "SCORE_RENDER",
  "EGRESS",
  "YOUTUBE",
  "HOST",
  "CONTROL",
  "MONITORING",
  "NOTIFICATION"
] as const;
export type MonitoringStage = typeof STAGES[number];

export const SEVERITIES = ["info", "warning", "critical"] as const;
export type Severity = typeof SEVERITIES[number];

const boundedId = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:-]+$/);
const isoDate = z.string().datetime({ offset: true });

export const serviceSnapshotSchema = z.object({
  name: boundedId,
  running: z.boolean(),
  healthy: z.boolean().nullable(),
  restartCount: z.number().int().nonnegative(),
  oomKilled: z.boolean(),
  memoryUsageBytes: z.number().nonnegative().nullable(),
  memoryLimitBytes: z.number().nonnegative().nullable(),
  cpuRatio: z.number().nonnegative().nullable()
}).strict();
export type ServiceSnapshot = z.infer<typeof serviceSnapshotSchema>;

export const mediaPathSnapshotSchema = z.object({
  name: z.string().regex(/^court[1-8]_(raw|preview|program|calibration|monitor)$/),
  courtNumber: z.number().int().min(1).max(8),
  branch: z.enum(["raw", "preview", "program", "calibration", "monitor"]),
  ready: z.boolean(),
  readySince: isoDate.nullable(),
  bytesReceived: z.number().int().nonnegative(),
  bytesSent: z.number().int().nonnegative(),
  inboundBitrateBps: z.number().nonnegative().nullable(),
  frameErrors: z.number().int().nonnegative(),
  readerCount: z.number().int().nonnegative(),
  videoCodec: boundedId.nullable(),
  audioCodec: boundedId.nullable()
}).strict();
export type MediaPathSnapshot = z.infer<typeof mediaPathSnapshotSchema>;

export const agentSnapshotSchema = z.object({
  version: z.literal(MONITORING_CONTRACT_VERSION),
  agentId: boundedId,
  role: z.enum(AGENT_ROLES),
  generatedAt: isoDate,
  collectionDurationMs: z.number().nonnegative(),
  collectionErrors: z.array(z.enum([
    "MEDIAMTX_API_UNAVAILABLE",
    "MEDIAMTX_METRICS_UNAVAILABLE",
    "LIVEKIT_METRICS_UNAVAILABLE",
    "EGRESS_METRICS_UNAVAILABLE",
    "DOCKER_UNAVAILABLE",
    "HOST_DISK_UNAVAILABLE"
  ])).max(12),
  host: z.object({
    uptimeSeconds: z.number().nonnegative(),
    load1: z.number().nonnegative(),
    memoryTotalBytes: z.number().nonnegative(),
    memoryAvailableBytes: z.number().nonnegative(),
    diskTotalBytes: z.number().nonnegative().nullable(),
    diskFreeBytes: z.number().nonnegative().nullable()
  }).strict(),
  services: z.array(serviceSnapshotSchema).max(40),
  mediaPaths: z.array(mediaPathSnapshotSchema).max(48)
}).strict();
export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;

export type StageHealth = {
  stage: MonitoringStage;
  state: HealthState;
  severity: Severity;
  issueCode: string | null;
  summary: string;
  firstAction: string | null;
  confidence: "low" | "medium" | "high";
  observedAt: string | null;
  ageMs: number | null;
  evidence: Record<string, string | number | boolean | null>;
};

export type CourtMonitorSnapshot = {
  courtNumber: number;
  overallState: HealthState;
  stages: StageHealth[];
  paths: Partial<Record<MediaPathSnapshot["branch"], MediaPathSnapshot>>;
};

export type IncidentSnapshot = {
  id: string;
  fingerprint: string;
  eventId: string | null;
  rootDependency: string;
  status: "open" | "acknowledged" | "resolved";
  severity: Severity;
  stage: MonitoringStage;
  issueCode: string;
  courtNumber: number | null;
  host: string | null;
  summary: string;
  firstAction: string | null;
  openedAt: string;
  lastObservedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
};

export type MonitorSnapshot = {
  version: typeof MONITORING_CONTRACT_VERSION;
  generatedAt: string;
  collector: {
    state: HealthState;
    agentsExpected: number;
    agentsFresh: number;
  };
  courts: CourtMonitorSnapshot[];
  agents: Array<{
    agentId: string;
    role: AgentRole;
    state: HealthState;
    lastSeenAt: string | null;
    ageMs: number | null;
  }>;
  incidents: IncidentSnapshot[];
};

const stateAttentionRank: Record<HealthState, number> = {
  CRITICAL: 8,
  UNKNOWN: 7,
  DEGRADED: 6,
  RECOVERING: 5,
  STARTING: 4,
  HEALTHY: 3,
  MAINTENANCE: 2,
  EXPECTED_OFF: 1,
  NOT_APPLICABLE: 0
};

export function worstHealthState(states: HealthState[]): HealthState {
  return states.reduce<HealthState>((worst, state) =>
    stateAttentionRank[state] > stateAttentionRank[worst] ? state : worst, "NOT_APPLICABLE");
}

export function incidentFingerprint(input: {
  eventId: string | null;
  rootDependency: string;
  stage: MonitoringStage;
  courtOrHost: string;
  issueCode: string;
}): string {
  return [
    input.eventId ?? "no-event",
    input.rootDependency,
    input.stage,
    input.courtOrHost,
    input.issueCode
  ].map(normalizeFingerprintPart).join("|");
}

function normalizeFingerprintPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").slice(0, 100) || "unknown";
}
