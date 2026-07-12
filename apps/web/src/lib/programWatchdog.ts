/**
 * Client-safe runtime logic for the program page (/program/court/{n}):
 * the video watchdog state machine and the heartbeat payload builder.
 * Pure functions only — no node/browser imports — so ProgramClient can bundle
 * this and vitest can exercise every decision (src/test/programPage.test.ts).
 */

/** The stage is authored at 720p logical size and scaled to the viewport. */
export const PROGRAM_STAGE_WIDTH = 1280;
export const PROGRAM_STAGE_HEIGHT = 720;
/** The scorebug overlay is designed against a 1080p canvas (OVERLAY_VISUAL_QA_PLAN). */
export const PROGRAM_OVERLAY_CANVAS_WIDTH = 1920;
export const PROGRAM_OVERLAY_CANVAS_HEIGHT = 1080;

export const PROGRAM_WATCHDOG_TICK_MS = 1000;
/** Frame progress must stall for strictly more than this before acting. */
export const PROGRAM_WATCHDOG_STALL_MS = 5000;
/** Reconnects (player remounts) attempted before escalating to a full reload. */
export const PROGRAM_RECONNECTS_BEFORE_RELOAD = 3;
export const PROGRAM_HEARTBEAT_INTERVAL_MS = 5000;
/** How long START_RECORDING waits for the commentary iframe before proceeding. */
export const PROGRAM_COMMENTARY_WAIT_MS = 10_000;

export type ProgramWatchdogAction = "none" | "reconnect" | "reload";

export type ProgramWatchdogState = {
  /**
   * Last progress metric observed. Null right after init/reconnect/source
   * loss, so the next sample only records a baseline — a metric reset after a
   * player remount must never read as playback progress.
   */
  lastProgress: number | null;
  lastProgressAtMs: number;
  /** Reconnects issued since real progress was last observed. */
  consecutiveReconnects: number;
};

export type ProgramWatchdogSample = {
  nowMs: number;
  /** Whether the page has any playback source at all (WHEP or HLS URL). */
  hasSources: boolean;
  /** Monotone-while-playing progress metric, e.g. decoded frames + currentTime. */
  progress: number;
};

export type ProgramWatchdogStep = {
  state: ProgramWatchdogState;
  action: ProgramWatchdogAction;
  /** True only on real observed progress — never on baseline samples. */
  progressed: boolean;
};

export function initialProgramWatchdog(nowMs: number): ProgramWatchdogState {
  return { lastProgress: null, lastProgressAtMs: nowMs, consecutiveReconnects: 0 };
}

/**
 * One watchdog tick: given the previous state and a fresh sample, decide
 * whether to leave the player alone, remount it ("reconnect"), or reload the
 * whole page ("reload", after PROGRAM_RECONNECTS_BEFORE_RELOAD consecutive
 * reconnects failed to restart frame progress).
 */
export function programWatchdogStep(
  state: ProgramWatchdogState,
  sample: ProgramWatchdogSample
): ProgramWatchdogStep {
  if (!sample.hasSources) {
    // Nothing to reconnect to; keep the stall clock fresh so a source
    // appearing later gets a full grace window.
    return {
      state: { ...state, lastProgress: null, lastProgressAtMs: sample.nowMs },
      action: "none",
      progressed: false
    };
  }
  if (state.lastProgress === null) {
    // Baseline after init/reconnect: record the metric, keep the reconnect
    // count — a remounted player that stays frozen must still escalate.
    return {
      state: { ...state, lastProgress: sample.progress, lastProgressAtMs: sample.nowMs },
      action: "none",
      progressed: false
    };
  }
  if (sample.progress !== state.lastProgress) {
    return {
      state: { lastProgress: sample.progress, lastProgressAtMs: sample.nowMs, consecutiveReconnects: 0 },
      action: "none",
      progressed: true
    };
  }
  if (sample.nowMs - state.lastProgressAtMs <= PROGRAM_WATCHDOG_STALL_MS) {
    return { state, action: "none", progressed: false };
  }
  if (state.consecutiveReconnects >= PROGRAM_RECONNECTS_BEFORE_RELOAD) {
    return { state: initialProgramWatchdog(sample.nowMs), action: "reload", progressed: false };
  }
  return {
    state: {
      lastProgress: null,
      lastProgressAtMs: sample.nowMs,
      consecutiveReconnects: state.consecutiveReconnects + 1
    },
    action: "reconnect",
    progressed: false
  };
}

export type ProgramMonitorHeartbeatBody = {
  version: 1;
  credentialId: string;
  courtNumber: number;
  heartbeatSeq: number;
  sampledAt: string;
  pageLoadedAt: string;
  pageBuildVersion: string;
  configurationVersion: string;
  video: {
    state: ProgramVideoState;
    transport: ProgramTransport;
    connectionState: ProgramConnectionState;
    framesRendered: number;
    framesPerSecond: number | null;
    width: number | null;
    height: number | null;
    rttMs: number | null;
    jitterBufferMs: number | null;
    packetsLost: number | null;
    packetsReceived: number | null;
    framesDropped: number | null;
    bytesReceived: number | null;
    reconnectCount: number;
    reloadCount: number;
  };
  commentary: {
    configured: boolean;
    roomConnected: boolean;
    participantCount: number;
    audioTrackCount: number;
    rmsDb: number | null;
    peakDb: number | null;
    secondsSinceAudio: number | null;
    cameraRmsDb: number | null;
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
    phase: ProgramScorePhase;
    sourceSignature: string | null;
    renderedSignature: string | null;
    domMismatchReason: "shape-mismatch" | "team-a-sets-mismatch" | "team-b-sets-mismatch" | "board-missing" | null;
    stateUpdatedAt: string | null;
  };
};

type ProgramVideoState = "waiting" | "stabilizing" | "playing" | "stalled" | "reconnecting" | "reloading" | "fatal" | "unknown";
type ProgramTransport = "whep" | "hls" | "none";
type ProgramConnectionState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed" | "unknown";
type ProgramScorePhase = "IDLE" | "PREMATCH" | "LIVE" | "POSTMATCH" | "STALE" | "ERROR" | "UNKNOWN";

const MAX_HEARTBEAT_TEXT = 64;

/**
 * Normalizes the 5s heartbeat POST body for /api/program/heartbeat. Values
 * come straight off media elements, so everything defensive lives here:
 * counts become non-negative integers, free-text fields are trimmed and
 * capped, and blanks fall back to explicit placeholders.
 */
export function buildProgramMonitorHeartbeat(input: {
  credentialId: string;
  courtNumber: number;
  heartbeatSeq: number;
  sampledAt: string;
  pageLoadedAt: string;
  pageBuildVersion: string | null | undefined;
  configurationVersion: string | null | undefined;
  videoState: string | null | undefined;
  framesRendered: number | null | undefined;
  streamHealth: {
    transport: string;
    connectionState: string;
    framesPerSecond: number | null;
    width: number | null;
    height: number | null;
    rttMs: number | null;
    jitterBufferMs: number | null;
    packetsLost: number | null;
    packetsReceived: number | null;
    framesDropped: number | null;
    bytesReceived: number | null;
  } | null;
  reconnectCount: number;
  reloadCount: number;
  commentaryConfigured: boolean;
  commentaryRoomConnected: boolean;
  commentaryParticipantCount: number | null | undefined;
  commentaryAudioTrackCount: number | null | undefined;
  commentaryRmsDb: number | null | undefined;
  commentaryPeakDb: number | null | undefined;
  secondsSinceCommentaryAudio: number | null | undefined;
  cameraAudioRmsDb: number | null | undefined;
  commentarySyncStatus: string | null | undefined;
  commentaryDelayConfiguredMs: number | null | undefined;
  commentaryDelayTargetMs: number | null | undefined;
  commentaryDelayAppliedMs: number | null | undefined;
  commentarySyncRttMs: number | null | undefined;
  commentarySyncSampleAgeMs: number | null | undefined;
  scoreRender: {
    loaded: boolean;
    connected: boolean;
    stale: boolean;
    frozen: boolean;
    matchId: string | null;
    phase: string;
    sourceSignature: string | null;
    renderedSignature: string | null;
    domMismatchReason: ProgramMonitorHeartbeatBody["scoreRender"]["domMismatchReason"];
    stateUpdatedAt: string | null;
  };
}): ProgramMonitorHeartbeatBody {
  const stream = input.streamHealth;
  return {
    version: 1,
    credentialId: input.credentialId,
    courtNumber: Math.trunc(input.courtNumber),
    heartbeatSeq: Math.max(1, Math.trunc(input.heartbeatSeq)),
    sampledAt: input.sampledAt,
    pageLoadedAt: input.pageLoadedAt,
    pageBuildVersion: clampIdentifier(input.pageBuildVersion, "local"),
    configurationVersion: clampIdentifier(input.configurationVersion, "unknown"),
    video: {
      state: clampVideoState(input.videoState),
      transport: clampTransport(stream?.transport),
      connectionState: clampConnectionState(stream?.connectionState),
      framesRendered: clampCount(input.framesRendered),
      framesPerSecond: clampOptionalRange(stream?.framesPerSecond, 0, 240),
      width: clampOptionalInteger(stream?.width, 1, 8192),
      height: clampOptionalInteger(stream?.height, 1, 8192),
      rttMs: clampOptionalRange(stream?.rttMs, 0, 60_000),
      jitterBufferMs: clampOptionalRange(stream?.jitterBufferMs, 0, 60_000),
      packetsLost: clampOptionalInteger(stream?.packetsLost, 0, Number.MAX_SAFE_INTEGER),
      packetsReceived: clampOptionalInteger(stream?.packetsReceived, 0, Number.MAX_SAFE_INTEGER),
      framesDropped: clampOptionalInteger(stream?.framesDropped, 0, Number.MAX_SAFE_INTEGER),
      bytesReceived: clampOptionalInteger(stream?.bytesReceived, 0, Number.MAX_SAFE_INTEGER),
      reconnectCount: clampCount(input.reconnectCount),
      reloadCount: clampCount(input.reloadCount)
    },
    commentary: {
      configured: Boolean(input.commentaryConfigured),
      roomConnected: Boolean(input.commentaryRoomConnected),
      participantCount: Math.min(32, clampCount(input.commentaryParticipantCount)),
      audioTrackCount: Math.min(32, clampCount(input.commentaryAudioTrackCount)),
      rmsDb: clampDb(input.commentaryRmsDb),
      peakDb: clampDb(input.commentaryPeakDb),
      secondsSinceAudio: clampOptionalRange(input.secondsSinceCommentaryAudio, 0, 86_400),
      cameraRmsDb: clampDb(input.cameraAudioRmsDb),
      syncStatus: clampSyncStatus(input.commentarySyncStatus),
      configuredDelayMs: clampOptionalMs(input.commentaryDelayConfiguredMs, 10_000),
      targetDelayMs: clampOptionalMs(input.commentaryDelayTargetMs, 10_000),
      appliedDelayMs: clampOptionalMs(input.commentaryDelayAppliedMs, 10_000),
      clockRttMs: clampOptionalMs(input.commentarySyncRttMs, 60_000),
      syncSampleAgeMs: clampOptionalMs(input.commentarySyncSampleAgeMs, 60_000)
    },
    scoreRender: {
      loaded: Boolean(input.scoreRender.loaded),
      connected: Boolean(input.scoreRender.connected),
      stale: Boolean(input.scoreRender.stale),
      frozen: Boolean(input.scoreRender.frozen),
      matchId: clampOptionalText(input.scoreRender.matchId, 80),
      phase: clampScorePhase(input.scoreRender.phase),
      sourceSignature: clampOptionalText(input.scoreRender.sourceSignature, 240),
      renderedSignature: clampOptionalText(input.scoreRender.renderedSignature, 240),
      domMismatchReason: input.scoreRender.domMismatchReason,
      stateUpdatedAt: input.scoreRender.stateUpdatedAt
    }
  };
}

function clampIdentifier(value: string | null | undefined, fallback: string): string {
  const cleaned = (value ?? "").trim().replace(/[^a-zA-Z0-9_.:-]+/g, "-").slice(0, MAX_HEARTBEAT_TEXT);
  return cleaned || fallback;
}

function clampOptionalText(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function clampVideoState(value: string | null | undefined): ProgramVideoState {
  return ["waiting", "stabilizing", "playing", "stalled", "reconnecting", "reloading", "fatal"].includes(value ?? "")
    ? value as ProgramVideoState
    : "unknown";
}

function clampTransport(value: string | null | undefined): ProgramTransport {
  return value === "whep" || value === "hls" ? value : "none";
}

function clampConnectionState(value: string | null | undefined): ProgramConnectionState {
  return ["new", "connecting", "connected", "disconnected", "failed", "closed"].includes(value ?? "")
    ? value as ProgramConnectionState
    : "unknown";
}

function clampScorePhase(value: string | null | undefined): ProgramScorePhase {
  return ["IDLE", "PREMATCH", "LIVE", "POSTMATCH", "STALE", "ERROR"].includes(value ?? "")
    ? value as ProgramScorePhase
    : "UNKNOWN";
}

function clampText(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, MAX_HEARTBEAT_TEXT) : fallback;
}

function clampCount(value: number | null | undefined): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.floor(numeric);
}

function clampDb(value: number | null | undefined): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(12, Math.max(-120, Math.round(numeric * 10) / 10));
}

function clampOptionalNonNegative(value: number | null | undefined): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.round(numeric * 10) / 10);
}

function clampOptionalRange(value: number | null | undefined, min: number, max: number): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(min, Math.round(numeric * 10) / 10));
}

function clampOptionalInteger(value: number | null | undefined, min: number, max: number): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function clampSyncStatus(value: string | null | undefined): "fallback" | "calibrating" | "locked" {
  return value === "calibrating" || value === "locked" ? value : "fallback";
}

function clampOptionalMs(value: number | null | undefined, max: number): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(max, Math.max(0, Math.round(numeric)));
}
