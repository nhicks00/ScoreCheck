/**
 * Client-safe runtime logic for the program page (/program/court/{n}):
 * the video watchdog state machine and the heartbeat payload builder.
 * Pure functions only — no node/browser imports — so ProgramClient can bundle
 * this and vitest can exercise every decision (src/test/programPage.test.ts).
 */

import type { ProgramVisualHealth } from "./visualHealth";
import { MONITORING_CONTRACT_VERSION } from "./monitoringContract";

/** The stage is authored at 720p logical size and scaled to the viewport. */
export const PROGRAM_STAGE_WIDTH = 1280;
export const PROGRAM_STAGE_HEIGHT = 720;
/** The scorebug overlay is designed against a 1080p canvas (OVERLAY_VISUAL_QA_PLAN). */
export const PROGRAM_OVERLAY_CANVAS_WIDTH = 1920;
export const PROGRAM_OVERLAY_CANVAS_HEIGHT = 1080;

export const PROGRAM_WATCHDOG_TICK_MS = 1000;
/** Foreground presentation must stall for strictly more than this before acting. */
export const PROGRAM_WATCHDOG_STALL_MS = 5000;
export const PROGRAM_HEARTBEAT_INTERVAL_MS = 5000;
/** How long START_RECORDING waits for the commentary iframe before proceeding. */
export const PROGRAM_COMMENTARY_WAIT_MS = 10_000;

export type ProgramWatchdogAction = "none" | "reconnect";

export type ProgramWatchdogState = {
  lastPresentedFrames: number | null;
  lastInboundFrames: number | null;
  /** Set only while a foreground connected browser presents no frames. */
  renderStallStartedAtMs: number | null;
};

export type ProgramWatchdogSample = {
  nowMs: number;
  /** Whether the page has any playback source at all (WHEP or HLS URL). */
  hasSources: boolean;
  /** False for hidden/background diagnostic tabs and non-connected transports. */
  renderWatchdogEligible: boolean;
  /** requestVideoFrameCallback's monotone presented-frame count. */
  presentedFrames: number;
  /** Browser inbound RTP frame count. Null until transport stats are available. */
  inboundFrames: number | null;
};

export type ProgramWatchdogStep = {
  state: ProgramWatchdogState;
  action: ProgramWatchdogAction;
  /** True only on real observed progress — never on baseline samples. */
  progressed: boolean;
};

export function initialProgramWatchdog(nowMs: number): ProgramWatchdogState {
  void nowMs;
  return { lastPresentedFrames: null, lastInboundFrames: null, renderStallStartedAtMs: null };
}

/**
 * One watchdog tick: given the previous state and a fresh sample, decide
 * whether to leave the player alone or remount it. A reconnect is justified
 * only when a foreground, connected viewer presents no frames. This also
 * unsticks a peer connection that remains nominally connected after inbound
 * media stops. Recovery must never become a full-page reload.
 */
export function programWatchdogStep(
  state: ProgramWatchdogState,
  sample: ProgramWatchdogSample
): ProgramWatchdogStep {
  if (!sample.hasSources || !sample.renderWatchdogEligible || sample.inboundFrames == null) {
    return {
      state: initialProgramWatchdog(sample.nowMs),
      action: "none",
      progressed: false
    };
  }

  if (state.lastPresentedFrames === null || state.lastInboundFrames === null
    || sample.presentedFrames < state.lastPresentedFrames
    || sample.inboundFrames < state.lastInboundFrames) {
    return {
      state: {
        lastPresentedFrames: sample.presentedFrames,
        lastInboundFrames: sample.inboundFrames,
        renderStallStartedAtMs: null
      },
      action: "none",
      progressed: false
    };
  }

  if (sample.presentedFrames > state.lastPresentedFrames) {
    return {
      state: {
        lastPresentedFrames: sample.presentedFrames,
        lastInboundFrames: sample.inboundFrames,
        renderStallStartedAtMs: null
      },
      action: "none",
      progressed: true
    };
  }

  const renderStallStartedAtMs = state.renderStallStartedAtMs ?? sample.nowMs;
  if (sample.nowMs - renderStallStartedAtMs <= PROGRAM_WATCHDOG_STALL_MS) {
    return {
      state: {
        lastPresentedFrames: sample.presentedFrames,
        lastInboundFrames: sample.inboundFrames,
        renderStallStartedAtMs
      },
      action: "none",
      progressed: false
    };
  }

  return {
    state: initialProgramWatchdog(sample.nowMs),
    action: "reconnect",
    progressed: false
  };
}

export type ProgramMonitorHeartbeatBody = {
  version: typeof MONITORING_CONTRACT_VERSION;
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
  visual: ProgramVisualHealth;
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
  } | null;
  visualHealth: ProgramVisualHealth;
  reconnectCount: number;
  reloadCount: number;
  commentaryConfigured: boolean;
  commentaryRoomConnected: boolean;
  commentaryParticipantCount: number | null | undefined;
  commentaryAudioTrackCount: number | null | undefined;
  commentaryMutedAudioTrackCount: number | null | undefined;
  commentaryRmsDb: number | null | undefined;
  commentaryPeakDb: number | null | undefined;
  commentaryClippedSampleRatio: number | null | undefined;
  secondsSinceCommentaryAudio: number | null | undefined;
  commentaryPacketsLost: number | null | undefined;
  commentaryPacketsReceived: number | null | undefined;
  commentaryJitterBufferMs: number | null | undefined;
  cameraAudioTrackPresent: boolean;
  cameraAudioRmsDb: number | null | undefined;
  cameraAudioPeakDb: number | null | undefined;
  cameraAudioClippedSampleRatio: number | null | undefined;
  secondsSinceCameraAudio: number | null | undefined;
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
    version: MONITORING_CONTRACT_VERSION,
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
      jitterMs: clampOptionalRange(stream?.jitterMs, 0, 60_000),
      jitterBufferMs: clampOptionalRange(stream?.jitterBufferMs, 0, 60_000),
      packetsLost: clampOptionalInteger(stream?.packetsLost, 0, Number.MAX_SAFE_INTEGER),
      packetsReceived: clampOptionalInteger(stream?.packetsReceived, 0, Number.MAX_SAFE_INTEGER),
      framesReceived: clampOptionalInteger(stream?.framesReceived, 0, Number.MAX_SAFE_INTEGER),
      framesDecoded: clampOptionalInteger(stream?.framesDecoded, 0, Number.MAX_SAFE_INTEGER),
      keyFramesDecoded: clampOptionalInteger(stream?.keyFramesDecoded, 0, Number.MAX_SAFE_INTEGER),
      framesDropped: clampOptionalInteger(stream?.framesDropped, 0, Number.MAX_SAFE_INTEGER),
      bytesReceived: clampOptionalInteger(stream?.bytesReceived, 0, Number.MAX_SAFE_INTEGER),
      freezeCount: clampOptionalInteger(stream?.freezeCount, 0, Number.MAX_SAFE_INTEGER),
      totalFreezesDurationMs: clampOptionalRange(stream?.totalFreezesDurationMs, 0, 86_400_000),
      lastPacketAgeMs: clampOptionalRange(stream?.lastPacketAgeMs, 0, 86_400_000),
      nackCount: clampOptionalInteger(stream?.nackCount, 0, Number.MAX_SAFE_INTEGER),
      pliCount: clampOptionalInteger(stream?.pliCount, 0, Number.MAX_SAFE_INTEGER),
      firCount: clampOptionalInteger(stream?.firCount, 0, Number.MAX_SAFE_INTEGER),
      reconnectCount: clampCount(input.reconnectCount),
      reloadCount: clampCount(input.reloadCount)
    },
    visual: {
      sampledAt: input.visualHealth.sampledAt,
      meanLuma: clampOptionalRange(input.visualHealth.meanLuma, 0, 255),
      lumaVariance: clampOptionalRange(input.visualHealth.lumaVariance, 0, 65_025),
      darkPixelRatio: clampOptionalRange(input.visualHealth.darkPixelRatio, 0, 1),
      frameDifference: clampOptionalRange(input.visualHealth.frameDifference, 0, 255),
      frozenDurationMs: clampCount(input.visualHealth.frozenDurationMs),
      blackDurationMs: clampCount(input.visualHealth.blackDurationMs)
    },
    commentary: {
      configured: Boolean(input.commentaryConfigured),
      roomConnected: Boolean(input.commentaryRoomConnected),
      participantCount: Math.min(32, clampCount(input.commentaryParticipantCount)),
      audioTrackCount: Math.min(32, clampCount(input.commentaryAudioTrackCount)),
      mutedAudioTrackCount: Math.min(32, clampCount(input.commentaryMutedAudioTrackCount)),
      rmsDb: clampDb(input.commentaryRmsDb),
      peakDb: clampDb(input.commentaryPeakDb),
      clippedSampleRatio: clampOptionalRange(input.commentaryClippedSampleRatio, 0, 1),
      secondsSinceAudio: clampOptionalRange(input.secondsSinceCommentaryAudio, 0, 86_400),
      packetsLost: clampOptionalInteger(input.commentaryPacketsLost, 0, Number.MAX_SAFE_INTEGER),
      packetsReceived: clampOptionalInteger(input.commentaryPacketsReceived, 0, Number.MAX_SAFE_INTEGER),
      jitterBufferMs: clampOptionalMs(input.commentaryJitterBufferMs, 60_000),
      cameraTrackPresent: Boolean(input.cameraAudioTrackPresent),
      cameraRmsDb: clampDb(input.cameraAudioRmsDb),
      cameraPeakDb: clampDb(input.cameraAudioPeakDb),
      cameraClippedSampleRatio: clampOptionalRange(input.cameraAudioClippedSampleRatio, 0, 1),
      secondsSinceCameraAudio: clampOptionalRange(input.secondsSinceCameraAudio, 0, 86_400),
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
