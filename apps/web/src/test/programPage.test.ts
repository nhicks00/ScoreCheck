import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkProgramToken,
  programBuildVersion,
  programCommentaryBufferMs,
  programPageToken
} from "../lib/program";
import {
  buildProgramHeartbeat,
  initialProgramWatchdog,
  PROGRAM_RECONNECTS_BEFORE_RELOAD,
  PROGRAM_WATCHDOG_STALL_MS,
  programWatchdogStep,
  type ProgramWatchdogSample,
  type ProgramWatchdogState
} from "../lib/programWatchdog";

const PROGRAM_ENV_KEYS = [
  "PROGRAM_PAGE_TOKEN",
  "VERCEL_GIT_COMMIT_SHA",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA",
  "RENDER_GIT_COMMIT"
];

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of PROGRAM_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of PROGRAM_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("checkProgramToken", () => {
  it("rejects everything while PROGRAM_PAGE_TOKEN is unset or blank", () => {
    expect(programPageToken()).toBe("");
    expect(checkProgramToken("anything")).toBe(false);
    expect(checkProgramToken("")).toBe(false);
    expect(checkProgramToken(null)).toBe(false);
    expect(checkProgramToken(undefined)).toBe(false);

    process.env.PROGRAM_PAGE_TOKEN = "   ";
    expect(checkProgramToken("   ")).toBe(false);
    expect(checkProgramToken("")).toBe(false);
  });

  it("accepts only the exact configured token", () => {
    process.env.PROGRAM_PAGE_TOKEN = "egress-secret-42";
    expect(checkProgramToken("egress-secret-42")).toBe(true);
    expect(checkProgramToken("egress-secret-43")).toBe(false);
    expect(checkProgramToken("egress-secret-4")).toBe(false);
    expect(checkProgramToken("")).toBe(false);
    expect(checkProgramToken(null)).toBe(false);
    expect(checkProgramToken(undefined)).toBe(false);
  });

  it("forgives surrounding whitespace from copy/paste", () => {
    process.env.PROGRAM_PAGE_TOKEN = "egress-secret-42";
    expect(checkProgramToken("  egress-secret-42  ")).toBe(true);
  });
});

describe("programCommentaryBufferMs", () => {
  it("treats absent, blank, and non-numeric values as no override", () => {
    expect(programCommentaryBufferMs(undefined)).toBeNull();
    expect(programCommentaryBufferMs(null)).toBeNull();
    expect(programCommentaryBufferMs("")).toBeNull();
    expect(programCommentaryBufferMs("   ")).toBeNull();
    expect(programCommentaryBufferMs("fast")).toBeNull();
  });

  it("clamps into 0..10000 and rounds to whole milliseconds", () => {
    expect(programCommentaryBufferMs("0")).toBe(0);
    expect(programCommentaryBufferMs("2500")).toBe(2500);
    expect(programCommentaryBufferMs("99999")).toBe(10000);
    expect(programCommentaryBufferMs("-300")).toBe(0);
    expect(programCommentaryBufferMs("1500.6")).toBe(1501);
  });
});

describe("programBuildVersion", () => {
  it("falls back to local, preferring the Vercel commit sha when present", () => {
    expect(programBuildVersion()).toBe("local");
    process.env.RENDER_GIT_COMMIT = "render-sha";
    expect(programBuildVersion()).toBe("render-sha");
    process.env.VERCEL_GIT_COMMIT_SHA = "vercel-sha";
    expect(programBuildVersion()).toBe("vercel-sha");
  });
});

/** Feeds samples (1s apart by default) through the reducer, collecting actions. */
function runWatchdog(
  samples: Array<Partial<ProgramWatchdogSample> & { atMs: number }>,
  start: ProgramWatchdogState = initialProgramWatchdog(0)
) {
  let state = start;
  const actions: string[] = [];
  const progressedFlags: boolean[] = [];
  for (const sample of samples) {
    const step = programWatchdogStep(state, {
      nowMs: sample.atMs,
      hasSources: sample.hasSources ?? true,
      progress: sample.progress ?? 0
    });
    state = step.state;
    actions.push(step.action);
    progressedFlags.push(step.progressed);
  }
  return { state, actions, progressedFlags };
}

describe("programWatchdogStep", () => {
  it("stays quiet while frames advance, flagging real progress only after the baseline", () => {
    const { actions, progressedFlags } = runWatchdog([
      { atMs: 1000, progress: 0 },
      { atMs: 2000, progress: 30 },
      { atMs: 3000, progress: 61 }
    ]);
    expect(actions).toEqual(["none", "none", "none"]);
    expect(progressedFlags).toEqual([false, true, true]);
  });

  it("does nothing while there are no sources, even when nothing moves", () => {
    const { actions } = runWatchdog([
      { atMs: 1000, hasSources: false },
      { atMs: 20_000, hasSources: false },
      { atMs: 60_000, hasSources: false }
    ]);
    expect(actions).toEqual(["none", "none", "none"]);
  });

  it("tolerates a stall up to the grace window, then reconnects", () => {
    const { actions } = runWatchdog([
      { atMs: 0, progress: 100 }, // baseline
      { atMs: 1000, progress: 130 }, // progress
      { atMs: 1000 + PROGRAM_WATCHDOG_STALL_MS, progress: 130 }, // exactly 5s: still none
      { atMs: 1001 + PROGRAM_WATCHDOG_STALL_MS, progress: 130 } // >5s: reconnect
    ]);
    expect(actions).toEqual(["none", "none", "none", "reconnect"]);
  });

  it("escalates to reload after three consecutive failed reconnects", () => {
    expect(PROGRAM_RECONNECTS_BEFORE_RELOAD).toBe(3);
    const { actions } = runWatchdog([
      { atMs: 0, progress: 50 }, // baseline
      { atMs: 1000, progress: 80 }, // playing
      { atMs: 7000, progress: 80 }, // stall >5s -> reconnect #1
      { atMs: 8000, progress: 0 }, // remounted player: baseline only, no reset
      { atMs: 14_000, progress: 0 }, // stall -> reconnect #2
      { atMs: 15_000, progress: 0 }, // baseline
      { atMs: 21_000, progress: 0 }, // stall -> reconnect #3
      { atMs: 22_000, progress: 0 }, // baseline
      { atMs: 28_000, progress: 0 } // stall with 3 reconnects spent -> reload
    ]);
    expect(actions).toEqual([
      "none",
      "none",
      "reconnect",
      "none",
      "reconnect",
      "none",
      "reconnect",
      "none",
      "reload"
    ]);
  });

  it("never mistakes the post-reconnect metric reset for playback progress", () => {
    const afterReconnect = runWatchdog([
      { atMs: 0, progress: 4523 }, // baseline
      { atMs: 1000, progress: 4553 }, // playing
      { atMs: 7000, progress: 4553 } // reconnect #1
    ]);
    const step = programWatchdogStep(afterReconnect.state, {
      nowMs: 8000,
      hasSources: true,
      progress: 0 // fresh player starts its counters over
    });
    expect(step.progressed).toBe(false);
    expect(step.state.consecutiveReconnects).toBe(1);
  });

  it("resets the reconnect ladder once frames actually flow again", () => {
    const { state, actions, progressedFlags } = runWatchdog([
      { atMs: 0, progress: 10 }, // baseline
      { atMs: 1000, progress: 20 }, // playing
      { atMs: 7000, progress: 20 }, // reconnect #1
      { atMs: 8000, progress: 0 }, // baseline after remount
      { atMs: 9000, progress: 30 } // real recovery
    ]);
    expect(actions).toEqual(["none", "none", "reconnect", "none", "none"]);
    expect(progressedFlags[4]).toBe(true);
    expect(state.consecutiveReconnects).toBe(0);
  });
});

describe("buildProgramHeartbeat", () => {
  it("passes through a healthy payload", () => {
    expect(
      buildProgramHeartbeat({
        token: "egress-secret-42",
        courtNumber: 3,
        videoState: "playing",
        framesRendered: 5400,
        commentaryRoomConnected: true,
        commentaryParticipantCount: 2,
        commentaryAudioTrackCount: 1,
        commentaryRmsDb: -24.04,
        commentaryPeakDb: -10.02,
        secondsSinceCommentaryAudio: 0.26,
        cameraAudioRmsDb: -18.02,
        commentarySyncStatus: "locked",
        commentaryDelayConfiguredMs: 3000,
        commentaryDelayTargetMs: 3025.4,
        commentaryDelayAppliedMs: 3012.6,
        commentarySyncRttMs: 54.8,
        commentarySyncSampleAgeMs: 210.2,
        pageVersion: "abc1234"
      })
    ).toEqual({
      token: "egress-secret-42",
      courtNumber: 3,
      videoState: "playing",
      framesRendered: 5400,
      commentaryRoomConnected: true,
      commentaryParticipantCount: 2,
      commentaryAudioTrackCount: 1,
      commentaryRmsDb: -24,
      commentaryPeakDb: -10,
      secondsSinceCommentaryAudio: 0.3,
      cameraAudioRmsDb: -18,
      commentarySyncStatus: "locked",
      commentaryDelayConfiguredMs: 3000,
      commentaryDelayTargetMs: 3025,
      commentaryDelayAppliedMs: 3013,
      commentarySyncRttMs: 55,
      commentarySyncSampleAgeMs: 210,
      pageVersion: "abc1234"
    });
  });

  it("normalizes hostile media-element values", () => {
    const body = buildProgramHeartbeat({
      token: "t",
      courtNumber: 3.9,
      videoState: "   ",
      framesRendered: Number.NaN,
      commentaryRoomConnected: false,
      commentaryParticipantCount: Number.NaN,
      commentaryAudioTrackCount: -2,
      commentaryRmsDb: Number.NaN,
      commentaryPeakDb: 99,
      secondsSinceCommentaryAudio: -4,
      cameraAudioRmsDb: -999,
      commentarySyncStatus: " ",
      commentaryDelayConfiguredMs: -4,
      commentaryDelayTargetMs: Number.NaN,
      commentaryDelayAppliedMs: 99_999,
      commentarySyncRttMs: 60.4,
      commentarySyncSampleAgeMs: null,
      pageVersion: ""
    });
    expect(body.courtNumber).toBe(3);
    expect(body.videoState).toBe("unknown");
    expect(body.framesRendered).toBe(0);
    expect(body.commentaryParticipantCount).toBe(0);
    expect(body.commentaryAudioTrackCount).toBe(0);
    expect(body.commentaryRmsDb).toBeNull();
    expect(body.commentaryPeakDb).toBe(12);
    expect(body.secondsSinceCommentaryAudio).toBe(0);
    expect(body.cameraAudioRmsDb).toBe(-120);
    expect(body.commentarySyncStatus).toBe("fallback");
    expect(body.commentaryDelayConfiguredMs).toBe(0);
    expect(body.commentaryDelayTargetMs).toBeNull();
    expect(body.commentaryDelayAppliedMs).toBe(10_000);
    expect(body.commentarySyncRttMs).toBe(60);
    expect(body.commentarySyncSampleAgeMs).toBeNull();
    expect(body.pageVersion).toBe("local");
  });

  it("floors fractional frame counts and zeroes negatives", () => {
    expect(buildProgramHeartbeat(base({ framesRendered: 12.9 })).framesRendered).toBe(12);
    expect(buildProgramHeartbeat(base({ framesRendered: -3 })).framesRendered).toBe(0);
    expect(buildProgramHeartbeat(base({ framesRendered: null })).framesRendered).toBe(0);
  });

  it("caps free-text fields at 64 characters", () => {
    const body = buildProgramHeartbeat(base({ videoState: "x".repeat(200), pageVersion: "y".repeat(200) }));
    expect(body.videoState).toHaveLength(64);
    expect(body.pageVersion).toHaveLength(64);
  });
});

function base(overrides: Partial<Parameters<typeof buildProgramHeartbeat>[0]>) {
  return {
    token: "t",
    courtNumber: 1,
    videoState: "playing",
    framesRendered: 0,
    commentaryRoomConnected: false,
    commentaryParticipantCount: 0,
    commentaryAudioTrackCount: 0,
    commentaryRmsDb: null,
    commentaryPeakDb: null,
    secondsSinceCommentaryAudio: null,
    cameraAudioRmsDb: null,
    commentarySyncStatus: "fallback",
    commentaryDelayConfiguredMs: null,
    commentaryDelayTargetMs: null,
    commentaryDelayAppliedMs: null,
    commentarySyncRttMs: null,
    commentarySyncSampleAgeMs: null,
    pageVersion: "local",
    ...overrides
  };
}
