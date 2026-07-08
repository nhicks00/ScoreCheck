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

export type ProgramHeartbeatBody = {
  token: string;
  courtNumber: number;
  videoState: string;
  framesRendered: number;
  commentaryLoaded: boolean;
  pageVersion: string;
};

const MAX_HEARTBEAT_TEXT = 64;

/**
 * Normalizes the 5s heartbeat POST body for /api/program/heartbeat. Values
 * come straight off media elements, so everything defensive lives here:
 * counts become non-negative integers, free-text fields are trimmed and
 * capped, and blanks fall back to explicit placeholders.
 */
export function buildProgramHeartbeat(input: {
  token: string;
  courtNumber: number;
  videoState: string | null | undefined;
  framesRendered: number | null | undefined;
  commentaryLoaded: boolean;
  pageVersion: string | null | undefined;
}): ProgramHeartbeatBody {
  return {
    token: input.token,
    courtNumber: Math.trunc(input.courtNumber),
    videoState: clampText(input.videoState, "unknown"),
    framesRendered: clampCount(input.framesRendered),
    commentaryLoaded: Boolean(input.commentaryLoaded),
    pageVersion: clampText(input.pageVersion, "local")
  };
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
