import type { MONITORING_CONTRACT_VERSION } from "./monitoringContract";

export type MonitorHealthState = "EXPECTED_OFF" | "STARTING" | "HEALTHY" | "DEGRADED" | "CRITICAL" | "RECOVERING" | "UNKNOWN" | "MAINTENANCE" | "NOT_APPLICABLE";
export type MonitorStageName = "VENUE" | "RAW_INGEST" | "PREVIEW" | "PROGRAM_PATH" | "PROGRAM_BROWSER" | "COMMENTARY" | "SCORE_SOURCE" | "SCORE_RENDER" | "EGRESS" | "YOUTUBE" | "HOST" | "CONTROL" | "MONITORING" | "NOTIFICATION";

export type MonitorStage = {
  stage: MonitorStageName;
  state: MonitorHealthState;
  severity: "info" | "warning" | "critical";
  issueCode: string | null;
  summary: string;
  firstAction: string | null;
  observedAt: string | null;
  ageMs: number | null;
  evidence: Record<string, string | number | boolean | null>;
};

export type MonitorMediaPath = {
  name: string;
  courtNumber: number;
  branch: "raw" | "preview" | "program" | "calibration" | "monitor";
  ready: boolean;
  readySince: string | null;
  bytesReceived: number;
  bytesSent: number;
  inboundBitrateBps: number | null;
  frameErrors: number;
  readerCount: number;
  sourceProtocol: "RTMP" | "SRT" | "RTSP" | "WEBRTC" | "HLS" | null;
  sourceMode: "PUSH" | "PULL" | null;
  videoCodec: string | null;
  audioCodec: string | null;
  videoWidth: number | null;
  videoHeight: number | null;
  videoProfile: string | null;
  audioSampleRateHz: number | null;
  audioChannelCount: number | null;
  transport: {
    rttMs: number | null;
    packetsReceived: number | null;
    packetsLost: number | null;
    packetsRetransmitted: number | null;
    packetsDropped: number | null;
    receiveRateBps: number | null;
    receiveBufferMs: number | null;
    configuredLatencyMs: number | null;
  } | null;
};

export type MonitorFfmpegBranch = {
  name: string;
  courtNumber: number;
  branch: "preview" | "program" | "calibration";
  sampledAt: string;
  frame: number;
  framesPerSecond: number | null;
  bitrateBps: number | null;
  outputTimeMs: number | null;
  duplicatedFrames: number;
  droppedFrames: number;
  speedRatio: number | null;
};

export type MonitorBrowser = {
  receivedAt: string;
  sampledAt: string;
  pageLoadedAt: string;
  pageBuildVersion: string;
  video: {
    state: string;
    transport: string;
    connectionState: string;
    framesRendered: number;
    framesPerSecond: number | null;
    width: number | null;
    height: number | null;
    rttMs: number | null;
    jitterMs: number | null;
    jitterBufferMs: number | null;
    packetsLost: number | null;
    packetsReceived: number | null;
    framesReceived: number | null;
    framesDecoded: number | null;
    keyFramesDecoded: number | null;
    framesDropped: number | null;
    bytesReceived: number | null;
    freezeCount: number | null;
    totalFreezesDurationMs: number | null;
    lastPacketAgeMs: number | null;
    nackCount: number | null;
    pliCount: number | null;
    firCount: number | null;
    reconnectCount: number;
    reloadCount: number;
  };
  visual: {
    sampledAt: string | null;
    meanLuma: number | null;
    lumaVariance: number | null;
    darkPixelRatio: number | null;
    frameDifference: number | null;
    frozenDurationMs: number;
    blackDurationMs: number;
  };
  commentary: {
    configured: boolean;
    roomConnected: boolean;
    participantCount: number;
    audioTrackCount: number;
    mutedAudioTrackCount: number;
    rmsDb: number | null;
    peakDb: number | null;
    clippedSampleRatio: number | null;
    secondsSinceAudio: number | null;
    packetsLost: number | null;
    packetsReceived: number | null;
    jitterBufferMs: number | null;
    cameraTrackPresent: boolean;
    cameraRmsDb: number | null;
    cameraPeakDb: number | null;
    cameraClippedSampleRatio: number | null;
    secondsSinceCameraAudio: number | null;
    syncStatus: "fallback" | "calibrating" | "locked";
    configuredDelayMs: number | null;
    targetDelayMs: number | null;
    appliedDelayMs: number | null;
    clockRttMs: number | null;
    syncSampleAgeMs: number | null;
  };
  scoreRender: {
    loaded: boolean;
    connected: boolean;
    stale: boolean;
    frozen: boolean;
    matchId: string | null;
    phase: string;
    sourceSignature: string | null;
    renderedSignature: string | null;
    domMismatchReason: string | null;
    stateUpdatedAt: string | null;
  };
};

export type MonitorExpectation = {
  coveragePhase: "OFF" | "WARMUP" | "LIVE_MATCH" | "INTERMISSION" | "FINAL_HOLD" | "TEARDOWN";
  mediaExpectation: "OFF" | "WARM" | "REQUIRED";
  broadcastExpectation: "OFF" | "TESTING" | "LIVE";
  commentaryExpectation: "NONE" | "OPTIONAL" | "REQUIRED";
  scoringExpectation: "NONE" | "SCHEDULED" | "LIVE" | "FINAL_HOLD";
  overrideExpiresAt: string | null;
};

export type MonitorMatch = { id: string; matchNumber: string | null; roundName: string | null; scheduledDate: string | null; scheduledTime: string | null; teamA: string | null; teamB: string | null };

export type MonitorCompetition = {
  courtId: string;
  displayName: string;
  physicalCourtLabel: string;
  courtStatus: string;
  currentMatch: MonitorMatch | null;
  nextMatch: MonitorMatch | null;
  score: { matchId: string | null; teamAScore: number; teamBScore: number; teamASets: number; teamBSets: number; currentSet: number; setScores: unknown[]; status: string; source: string; sourceAvailable: boolean; sourcePriority: string; stale: boolean; lastApiPollAt: string | null; updatedAt: string | null } | null;
  overlay: { matchId: string | null; teamA: string | null; teamB: string | null; teamAScore: number; teamBScore: number; teamASets: number; teamBSets: number; currentSet: number; phase: string; stale: boolean; updatedAt: string | null } | null;
  alignment: { state: MonitorHealthState; issueCodes: string[]; sourceAgeMs: number | null };
  youtubeVideoId: string | null;
};

export type MonitorCourt = {
  courtNumber: number;
  overallState: MonitorHealthState;
  stages: MonitorStage[];
  paths: Partial<Record<MonitorMediaPath["branch"], MonitorMediaPath>>;
  ffmpeg: Partial<Record<MonitorFfmpegBranch["branch"], MonitorFfmpegBranch>>;
  browser: MonitorBrowser | null;
  competition: MonitorCompetition | null;
  expectation: MonitorExpectation;
  faultGate: MonitorFaultGate | null;
  youtube: { state: MonitorHealthState; broadcastLifecycle: string | null; streamStatus: string | null; healthStatus: string | null; configurationIssues: string[]; observedAt: string } | null;
  thumbnail: { sampledAt: string; receivedAt: string; byteLength: number } | null;
  egressHost: string | null;
};

export type MonitorFaultGate = {
  courtNumber: number;
  actor: string;
  reason: string;
  armedAt: string;
  expiresAt: string;
};

export type MonitorIncident = {
  id: string;
  eventId: string | null;
  status: "open" | "acknowledged" | "resolved";
  severity: "info" | "warning" | "critical";
  stage: MonitorStageName;
  issueCode: string;
  courtNumber: number | null;
  host: string | null;
  rootDependency: string;
  summary: string;
  firstAction: string | null;
  openedAt: string;
  lastObservedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
};

export type MonitorSilence = {
  id: string;
  eventId: string | null;
  courtNumber: number | null;
  stage: MonitorStageName | null;
  issueCode: string | null;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
};

export type MonitorAgent = {
  agentId: string;
  role: string;
  assignedCourts: number[];
  state: MonitorHealthState;
  lastSeenAt: string | null;
  ageMs: number | null;
  host: { uptimeSeconds: number; load1: number; memoryTotalBytes: number; memoryAvailableBytes: number; diskTotalBytes: number | null; diskFreeBytes: number | null } | null;
  services: Array<{ name: string; running: boolean; healthy: boolean | null; restartCount: number; oomKilled: boolean; memoryUsageBytes: number | null; memoryLimitBytes: number | null; cpuRatio: number | null }>;
  nativeServices: {
    endpoints: Array<{ service: string; up: boolean }>;
    livekit: { roomCount: number; participantCount: number; packetsOut: number; packetsDropped: number } | null;
    egress: { idle: boolean; canAcceptRequest: boolean; cgroupMemoryBytes: number | null; cpuLoadRatio: number | null; memoryLoadRatio: number | null } | null;
  } | null;
};

export type MonitorSnapshot = {
  version: typeof MONITORING_CONTRACT_VERSION;
  generatedAt: string;
  collector: { state: MonitorHealthState; agentsExpected: number; agentsFresh: number };
  controlPlane: { state: MonitorHealthState; observedAt: string | null; ageMs: number | null; worker: { state: MonitorHealthState; status: string | null; lastSeenAt: string | null; ageMs: number | null } };
  event: { id: string; name: string; status: string; eventDate: string | null } | null;
  youtube: { state: MonitorHealthState; observedAt: string | null; ageMs: number | null };
  notifications: { state: "NOT_APPLICABLE" | "UNKNOWN" | "HEALTHY" | "DEGRADED"; pushover: { configured: boolean; lastSuccessAt: string | null; lastFailureAt: string | null }; twilioSms: { configured: boolean; lastSuccessAt: string | null; lastFailureAt: string | null } };
  deadMan: {
    state: "NOT_APPLICABLE" | "UNKNOWN" | "HEALTHY" | "DEGRADED";
    baseline: { configured: boolean; mode: "NOT_CONFIGURED" | "UNKNOWN" | "RUNNING" | "PAUSED"; lastSuccessAt: string | null; lastFailureAt: string | null };
    active: { configured: boolean; mode: "NOT_CONFIGURED" | "UNKNOWN" | "RUNNING" | "PAUSED"; lastSuccessAt: string | null; lastFailureAt: string | null };
  };
  courts: MonitorCourt[];
  agents: MonitorAgent[];
  incidents: MonitorIncident[];
  silences: MonitorSilence[];
  faultGates: MonitorFaultGate[];
};

export type MonitorSnapshotEnvelope = {
  snapshot: MonitorSnapshot;
  source: "live" | "checkpoint";
  fetchedAt: string;
  monitorError: string | null;
};

export type MonitorCourtPipelineRange = {
  generatedAt: string;
  windowSec: number;
  stepSec: number;
  courts: Array<{
    courtNumber: number;
    rawBitrate: Array<[number, number]>;
    previewFps: Array<[number, number]>;
    programFps: Array<[number, number]>;
  }>;
};
