import { z } from "zod";

export const MONITORING_CONTRACT_VERSION = 2 as const;

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

export const MEDIA_SOURCE_PROTOCOLS = ["RTMP", "SRT", "RTSP", "WEBRTC", "HLS"] as const;
export const MEDIA_SOURCE_MODES = ["PUSH", "PULL"] as const;

export const mediaTransportSnapshotSchema = z.object({
  rttMs: z.number().nonnegative().max(60_000).nullable(),
  packetsReceived: z.number().int().nonnegative().nullable(),
  packetsLost: z.number().int().nonnegative().nullable(),
  packetsRetransmitted: z.number().int().nonnegative().nullable(),
  packetsDropped: z.number().int().nonnegative().nullable(),
  receiveRateBps: z.number().nonnegative().nullable(),
  receiveBufferMs: z.number().nonnegative().max(60_000).nullable(),
  configuredLatencyMs: z.number().nonnegative().max(60_000).nullable()
}).strict();
export type MediaTransportSnapshot = z.infer<typeof mediaTransportSnapshotSchema>;

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
  sourceProtocol: z.enum(MEDIA_SOURCE_PROTOCOLS).nullable(),
  sourceMode: z.enum(MEDIA_SOURCE_MODES).nullable(),
  videoCodec: boundedId.nullable(),
  audioCodec: boundedId.nullable(),
  videoWidth: z.number().int().positive().max(8192).nullable(),
  videoHeight: z.number().int().positive().max(8192).nullable(),
  videoProfile: boundedId.nullable(),
  audioSampleRateHz: z.number().int().positive().max(384_000).nullable(),
  audioChannelCount: z.number().int().positive().max(32).nullable(),
  transport: mediaTransportSnapshotSchema.nullable()
}).strict();
export type MediaPathSnapshot = z.infer<typeof mediaPathSnapshotSchema>;

export const ffmpegBranchSnapshotSchema = z.object({
  name: z.string().regex(/^court[1-8]_(preview|program|calibration|monitor)$/),
  courtNumber: z.number().int().min(1).max(8),
  branch: z.enum(["preview", "program", "calibration", "monitor"]),
  sampledAt: isoDate,
  frame: z.number().int().nonnegative(),
  framesPerSecond: z.number().nonnegative().max(240).nullable(),
  bitrateBps: z.number().nonnegative().nullable(),
  outputTimeMs: z.number().nonnegative().nullable(),
  duplicatedFrames: z.number().int().nonnegative(),
  droppedFrames: z.number().int().nonnegative(),
  speedRatio: z.number().nonnegative().max(20).nullable()
}).strict();
export type FfmpegBranchSnapshot = z.infer<typeof ffmpegBranchSnapshotSchema>;

export const nativeServiceSnapshotSchema = z.object({
  endpoints: z.array(z.object({
    service: z.enum(["livekit", "egress-metrics", "egress-health"]),
    up: z.boolean()
  }).strict()).max(3),
  livekit: z.object({
    roomCount: z.number().int().nonnegative(),
    participantCount: z.number().int().nonnegative(),
    packetsOut: z.number().nonnegative(),
    packetsDropped: z.number().nonnegative()
  }).strict().nullable(),
  egress: z.object({
    idle: z.boolean(),
    canAcceptRequest: z.boolean(),
    nativeCanAcceptRequest: z.boolean(),
    activeWebRequests: z.number().int().nonnegative(),
    maximumWebRequests: z.number().int().positive(),
    cgroupMemoryBytes: z.number().nonnegative().nullable(),
    cpuLoadRatio: z.number().nonnegative().nullable(),
    memoryLoadRatio: z.number().nonnegative().nullable()
  }).strict().nullable().default(null)
}).strict();
export type NativeServiceSnapshot = z.infer<typeof nativeServiceSnapshotSchema>;

export const browserHeartbeatPayloadSchema = z.object({
  version: z.literal(MONITORING_CONTRACT_VERSION),
  credentialId: z.string().uuid(),
  courtNumber: z.number().int().min(1).max(8),
  heartbeatSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sampledAt: isoDate,
  pageLoadedAt: isoDate,
  pageBuildVersion: boundedId,
  configurationVersion: boundedId,
  video: z.object({
    state: z.enum(["waiting", "stabilizing", "playing", "stalled", "reconnecting", "reloading", "fatal", "unknown"]),
    transport: z.enum(["whep", "hls", "none"]),
    connectionState: z.enum(["new", "connecting", "connected", "disconnected", "failed", "closed", "unknown"]),
    framesRendered: z.number().int().nonnegative(),
    framesPerSecond: z.number().nonnegative().max(240).nullable(),
    width: z.number().int().positive().max(8192).nullable(),
    height: z.number().int().positive().max(8192).nullable(),
    rttMs: z.number().nonnegative().max(60_000).nullable(),
    jitterMs: z.number().nonnegative().max(60_000).nullable().default(null),
    jitterBufferMs: z.number().nonnegative().max(60_000).nullable(),
    packetsLost: z.number().int().nonnegative().nullable(),
    packetsReceived: z.number().int().nonnegative().nullable(),
    framesReceived: z.number().int().nonnegative().nullable().default(null),
    framesDecoded: z.number().int().nonnegative().nullable().default(null),
    keyFramesDecoded: z.number().int().nonnegative().nullable().default(null),
    framesDropped: z.number().int().nonnegative().nullable(),
    bytesReceived: z.number().int().nonnegative().nullable(),
    freezeCount: z.number().int().nonnegative().nullable().default(null),
    totalFreezesDurationMs: z.number().nonnegative().max(86_400_000).nullable().default(null),
    lastPacketAgeMs: z.number().nonnegative().max(86_400_000).nullable().default(null),
    nackCount: z.number().int().nonnegative().nullable().default(null),
    pliCount: z.number().int().nonnegative().nullable().default(null),
    firCount: z.number().int().nonnegative().nullable().default(null),
    reconnectCount: z.number().int().nonnegative(),
    reloadCount: z.number().int().nonnegative()
  }).strict(),
  visual: z.object({
    sampledAt: isoDate.nullable(),
    meanLuma: z.number().min(0).max(255).nullable(),
    lumaVariance: z.number().min(0).max(65_025).nullable(),
    darkPixelRatio: z.number().min(0).max(1).nullable(),
    frameDifference: z.number().min(0).max(255).nullable(),
    frozenDurationMs: z.number().int().nonnegative().max(86_400_000),
    blackDurationMs: z.number().int().nonnegative().max(86_400_000)
  }).strict().default({
    sampledAt: null,
    meanLuma: null,
    lumaVariance: null,
    darkPixelRatio: null,
    frameDifference: null,
    frozenDurationMs: 0,
    blackDurationMs: 0
  }),
  commentary: z.object({
    configured: z.boolean(),
    roomConnected: z.boolean(),
    participantCount: z.number().int().nonnegative().max(32),
    audioTrackCount: z.number().int().nonnegative().max(32),
    mutedAudioTrackCount: z.number().int().nonnegative().max(32).default(0),
    rmsDb: z.number().min(-120).max(12).nullable(),
    peakDb: z.number().min(-120).max(12).nullable(),
    clippedSampleRatio: z.number().min(0).max(1).nullable().default(null),
    secondsSinceAudio: z.number().nonnegative().max(86_400).nullable(),
    packetsLost: z.number().int().nonnegative().nullable().default(null),
    packetsReceived: z.number().int().nonnegative().nullable().default(null),
    jitterBufferMs: z.number().nonnegative().max(60_000).nullable().default(null),
    cameraTrackPresent: z.boolean().default(false),
    cameraRmsDb: z.number().min(-120).max(12).nullable(),
    cameraPeakDb: z.number().min(-120).max(12).nullable().default(null),
    cameraClippedSampleRatio: z.number().min(0).max(1).nullable().default(null),
    secondsSinceCameraAudio: z.number().nonnegative().max(86_400).nullable().default(null),
    syncStatus: z.enum(["fallback", "calibrating", "locked"]),
    configuredDelayMs: z.number().nonnegative().max(10_000).nullable(),
    targetDelayMs: z.number().nonnegative().max(10_000).nullable(),
    appliedDelayMs: z.number().nonnegative().max(10_000).nullable(),
    clockRttMs: z.number().nonnegative().max(60_000).nullable(),
    syncSampleAgeMs: z.number().nonnegative().max(60_000).nullable()
  }).strict(),
  scoreRender: z.object({
    loaded: z.boolean(),
    connected: z.boolean(),
    stale: z.boolean(),
    frozen: z.boolean(),
    matchId: boundedId.nullable(),
    phase: z.enum(["IDLE", "PREMATCH", "LIVE", "POSTMATCH", "STALE", "ERROR", "UNKNOWN"]),
    sourceSignature: z.string().max(240).nullable(),
    renderedSignature: z.string().max(240).nullable(),
    domMismatchReason: z.enum(["shape-mismatch", "team-a-sets-mismatch", "team-b-sets-mismatch", "board-missing"]).nullable(),
    stateUpdatedAt: isoDate.nullable()
  }).strict()
}).strict();
export type BrowserHeartbeatPayload = z.infer<typeof browserHeartbeatPayloadSchema>;

export type BrowserHeartbeatSnapshot = BrowserHeartbeatPayload & {
  receivedAt: string;
};

export const COVERAGE_PHASES = ["OFF", "WARMUP", "LIVE_MATCH", "INTERMISSION", "FINAL_HOLD", "TEARDOWN"] as const;
export const MEDIA_EXPECTATIONS = ["OFF", "WARM", "REQUIRED"] as const;
export const BROADCAST_EXPECTATIONS = ["OFF", "TESTING", "LIVE"] as const;
export const COMMENTARY_EXPECTATIONS = ["NONE", "OPTIONAL", "REQUIRED"] as const;
export const SCORING_EXPECTATIONS = ["NONE", "SCHEDULED", "LIVE", "FINAL_HOLD"] as const;

export type CourtExpectation = {
  coveragePhase: typeof COVERAGE_PHASES[number];
  mediaExpectation: typeof MEDIA_EXPECTATIONS[number];
  broadcastExpectation: typeof BROADCAST_EXPECTATIONS[number];
  commentaryExpectation: typeof COMMENTARY_EXPECTATIONS[number];
  scoringExpectation: typeof SCORING_EXPECTATIONS[number];
  overrideExpiresAt: string | null;
};

export type CompetitionMatchSnapshot = {
  id: string;
  matchNumber: string | null;
  roundName: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  teamA: string | null;
  teamB: string | null;
};

export type CompetitionScoreSnapshot = {
  matchId: string | null;
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  currentSet: number;
  setScores: unknown[];
  status: string;
  source: string;
  sourceAvailable: boolean;
  sourcePriority: string;
  stale: boolean;
  lastApiPollAt: string | null;
  updatedAt: string | null;
};

export type CompetitionCourtSnapshot = {
  courtId: string;
  courtNumber: number;
  displayName: string;
  physicalCourtLabel: string;
  courtStatus: string;
  expectation: CourtExpectation;
  currentMatch: CompetitionMatchSnapshot | null;
  nextMatch: CompetitionMatchSnapshot | null;
  score: CompetitionScoreSnapshot | null;
  overlay: {
    matchId: string | null;
    teamA: string | null;
    teamB: string | null;
    teamAScore: number;
    teamBScore: number;
    teamASets: number;
    teamBSets: number;
    currentSet: number;
    phase: string;
    stale: boolean;
    updatedAt: string | null;
  } | null;
  alignment: {
    state: HealthState;
    issueCodes: string[];
    sourceAgeMs: number | null;
  };
  youtubeVideoId: string | null;
};

export type ControlPlaneSnapshot = {
  observedAt: string;
  event: { id: string; name: string; status: string; eventDate: string | null } | null;
  worker: { state: HealthState; status: string | null; lastSeenAt: string | null; ageMs: number | null };
  courts: CompetitionCourtSnapshot[];
};

export type YouTubeCourtSnapshot = {
  courtNumber: number;
  videoId: string | null;
  state: HealthState;
  broadcastLifecycle: string | null;
  streamStatus: string | null;
  healthStatus: string | null;
  configurationIssues: string[];
  observedAt: string;
};

export type YouTubeMonitorSnapshot = {
  observedAt: string;
  apiState: HealthState;
  courts: YouTubeCourtSnapshot[];
};

export type NotificationHealth = {
  state: "NOT_APPLICABLE" | "UNKNOWN" | "HEALTHY" | "DEGRADED";
  pushover: { configured: boolean; lastSuccessAt: string | null; lastFailureAt: string | null };
  twilioSms: { configured: boolean; lastSuccessAt: string | null; lastFailureAt: string | null };
};

export type DeadManCheckHealth = {
  configured: boolean;
  mode: "NOT_CONFIGURED" | "UNKNOWN" | "RUNNING" | "PAUSED";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
};

export type DeadManPhoneChannelHealth = {
  configured: boolean;
  state: "NOT_APPLICABLE" | "UNKNOWN" | "HEALTHY" | "DEGRADED";
  baselineAttached: boolean | null;
  activeAttached: boolean | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
};

export type DeadManHealth = {
  state: "NOT_APPLICABLE" | "UNKNOWN" | "HEALTHY" | "DEGRADED";
  baseline: DeadManCheckHealth;
  active: DeadManCheckHealth;
  phoneChannel: DeadManPhoneChannelHealth;
};

export type BrowserThumbnailMetadata = {
  courtNumber: number;
  credentialId: string;
  sequence: number;
  sampledAt: string;
  receivedAt: string;
  contentType: "image/jpeg";
  byteLength: number;
};

export const agentSnapshotSchema = z.object({
  version: z.literal(MONITORING_CONTRACT_VERSION),
  agentId: boundedId,
  role: z.enum(AGENT_ROLES),
  assignedCourts: z.array(z.number().int().min(1).max(8)).max(8).default([]),
  generatedAt: isoDate,
  collectionDurationMs: z.number().nonnegative(),
  collectionErrors: z.array(z.enum([
    "MEDIAMTX_API_UNAVAILABLE",
    "MEDIAMTX_PATH_DETAILS_UNAVAILABLE",
    "MEDIAMTX_METRICS_UNAVAILABLE",
    "MEDIAMTX_TRANSPORT_METRICS_UNAVAILABLE",
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
  mediaPaths: z.array(mediaPathSnapshotSchema).max(48),
  ffmpegBranches: z.array(ffmpegBranchSnapshotSchema).max(32).default([]),
  nativeServices: nativeServiceSnapshotSchema.default({ endpoints: [], livekit: null, egress: null })
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
  ffmpeg: Partial<Record<FfmpegBranchSnapshot["branch"], FfmpegBranchSnapshot>>;
  browser: BrowserHeartbeatSnapshot | null;
  competition: CompetitionCourtSnapshot | null;
  expectation: CourtExpectation;
  faultGate: MonitoringFaultGate | null;
  youtube: YouTubeCourtSnapshot | null;
  thumbnail: BrowserThumbnailMetadata | null;
  egressHost: string | null;
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
  evidence: Record<string, string | number | boolean | null>;
  openedAt: string;
  lastObservedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
};

export type MonitoringSilence = {
  id: string;
  eventId: string | null;
  courtNumber: number | null;
  stage: MonitoringStage | null;
  issueCode: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
};

export type MonitoringFaultGate = {
  courtNumber: number;
  profile: "RAW_ONLY" | "PROGRAM_CONTENT";
  actor: string;
  reason: string;
  armedAt: string;
  expiresAt: string;
};

export type MonitorSnapshot = {
  version: typeof MONITORING_CONTRACT_VERSION;
  generatedAt: string;
  collector: {
    state: HealthState;
    agentsExpected: number;
    agentsFresh: number;
  };
  controlPlane: {
    state: HealthState;
    observedAt: string | null;
    ageMs: number | null;
    worker: ControlPlaneSnapshot["worker"];
  };
  event: ControlPlaneSnapshot["event"];
  youtube: { state: HealthState; observedAt: string | null; ageMs: number | null };
  notifications: NotificationHealth;
  deadMan: DeadManHealth;
  courts: CourtMonitorSnapshot[];
  agents: Array<{
    agentId: string;
    role: AgentRole;
    assignedCourts: number[];
    state: HealthState;
    lastSeenAt: string | null;
    ageMs: number | null;
    host: AgentSnapshot["host"] | null;
    services: ServiceSnapshot[];
    nativeServices: NativeServiceSnapshot | null;
  }>;
  incidents: IncidentSnapshot[];
  silences: MonitoringSilence[];
  faultGates: MonitoringFaultGate[];
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
