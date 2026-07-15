import { monotonicEpochMs } from "./rtcTiming";

export const AUTHORITATIVE_FRAME_MAX_AGE_MS = 1_500;
const BROKERED_SCORING_SESSION_ID_PATTERN = /^whep-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROKERED_SCORING_RESOURCE_PATH_PATTERN = /^\/api\/community\/session\/media\/whep\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export type PlaybackTransport = "whep" | "hls" | "none";

export type PlaybackConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed"
  | "unknown";

export type PlaybackMode = "preview" | "program" | "scoring";

export type PlaybackFrameObservation = {
  source: "video-frame-callback";
  sessionId: string;
  presentedFrames: number;
  mediaTimeSeconds: number;
  observedAtMs: number;
};

export type PlaybackEvidenceState = {
  transport: PlaybackTransport;
  sessionId: string | null;
  connectionState: PlaybackConnectionState;
  frame: PlaybackFrameObservation | null;
  paused: boolean;
  stalled: boolean;
  reconnecting: boolean;
};

export type PlaybackEvidenceBlockReason =
  | "transport_not_whep"
  | "session_missing"
  | "broker_session_missing"
  | "connection_not_connected"
  | "reconnecting"
  | "playback_paused"
  | "playback_stalled"
  | "media_not_ready"
  | "rendered_frame_missing"
  | "rendered_frame_session_mismatch"
  | "rendered_frame_stale";

export type PlaybackEvidenceSnapshot = {
  version: 1;
  /** Opaque same-origin broker identity. It is never an upstream URL or bearer credential. */
  sessionId: string | null;
  transport: PlaybackTransport;
  connectionState: PlaybackConnectionState;
  sampledAtMs: number;
  baseRevision: number | null;
  currentTimeSeconds: number | null;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  paused: boolean;
  stalled: boolean;
  reconnecting: boolean;
  frame: PlaybackFrameObservation | null;
  qualification: {
    liveActionEligible: boolean;
    blockedReason: PlaybackEvidenceBlockReason | null;
    frameAgeMs: number | null;
    maxFrameAgeMs: number;
  };
  /** This evidence can fail closed in the client; it is not trusted source-timeline correlation. */
  correlation: "uncorrelated_client_diagnostic";
};

export type PlaybackEvidenceCapture = {
  baseRevision?: number;
  sampledAtMs?: number;
  currentTimeSeconds: number | null;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  paused: boolean;
};

export function initialPlaybackEvidenceState(): PlaybackEvidenceState {
  return {
    transport: "none",
    sessionId: null,
    connectionState: "unknown",
    frame: null,
    paused: true,
    stalled: false,
    reconnecting: false
  };
}

export function playbackModeAllowsHls(mode: PlaybackMode): boolean {
  return mode === "preview";
}

export function brokeredScoringSessionId(resourceUrl: string | null, pageUrl: string): string | null {
  if (!resourceUrl) return null;
  try {
    const page = new URL(pageUrl);
    const resource = new URL(resourceUrl, page);
    if (resource.origin !== page.origin || resource.search || resource.hash) return null;
    const match = BROKERED_SCORING_RESOURCE_PATH_PATTERN.exec(resource.pathname);
    return match?.[1] ? `whep-${match[1].toLowerCase()}` : null;
  } catch {
    return null;
  }
}

export function buildPlaybackEvidence(
  state: PlaybackEvidenceState,
  capture: PlaybackEvidenceCapture
): PlaybackEvidenceSnapshot {
  const sampledAtMs = capture.sampledAtMs ?? monotonicEpochMs();
  const paused = state.paused || capture.paused;
  const frameAgeMs = state.frame == null
    ? null
    : Math.max(0, sampledAtMs - state.frame.observedAtMs);
  const blockedReason = playbackEvidenceBlockReason({
    ...state,
    paused,
    readyState: capture.readyState,
    videoWidth: capture.videoWidth,
    videoHeight: capture.videoHeight,
    frameAgeMs
  });

  return {
    version: 1,
    sessionId: state.sessionId,
    transport: state.transport,
    connectionState: state.connectionState,
    sampledAtMs,
    baseRevision: validRevision(capture.baseRevision),
    currentTimeSeconds: finiteNonNegative(capture.currentTimeSeconds),
    readyState: capture.readyState,
    videoWidth: capture.videoWidth,
    videoHeight: capture.videoHeight,
    paused,
    stalled: state.stalled,
    reconnecting: state.reconnecting,
    frame: state.frame,
    qualification: {
      liveActionEligible: blockedReason == null,
      blockedReason,
      frameAgeMs,
      maxFrameAgeMs: AUTHORITATIVE_FRAME_MAX_AGE_MS
    },
    correlation: "uncorrelated_client_diagnostic"
  };
}

function playbackEvidenceBlockReason(input: PlaybackEvidenceState & {
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  frameAgeMs: number | null;
}): PlaybackEvidenceBlockReason | null {
  if (input.transport !== "whep") return "transport_not_whep";
  if (input.reconnecting) return "reconnecting";
  if (!input.sessionId) return "session_missing";
  if (!BROKERED_SCORING_SESSION_ID_PATTERN.test(input.sessionId)) return "broker_session_missing";
  if (input.connectionState !== "connected") return "connection_not_connected";
  if (input.paused) return "playback_paused";
  if (input.stalled) return "playback_stalled";
  if (input.readyState < 2 || input.videoWidth <= 0 || input.videoHeight <= 0) return "media_not_ready";
  if (!input.frame) return "rendered_frame_missing";
  if (input.frame.sessionId !== input.sessionId) return "rendered_frame_session_mismatch";
  if (input.frameAgeMs == null || input.frameAgeMs > AUTHORITATIVE_FRAME_MAX_AGE_MS) {
    return "rendered_frame_stale";
  }
  return null;
}

function validRevision(value: number | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNonNegative(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
