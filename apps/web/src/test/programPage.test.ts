import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkProgramToken,
  programBuildVersion,
  programCommentaryBufferMs,
  programPageToken
} from "../lib/program";
import { createProgramMonitoringConnection } from "../lib/programMonitoring";
import {
  buildProgramMonitorHeartbeat,
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
  "RENDER_GIT_COMMIT",
  "MONITOR_PUBLIC_URL",
  "MONITOR_BROWSER_HEARTBEAT_SECRET"
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

describe("createProgramMonitoringConnection", () => {
  it("mints the versioned credential format consumed by the monitor gateway", () => {
    process.env.MONITOR_PUBLIC_URL = "https://monitor.example.test/";
    process.env.MONITOR_BROWSER_HEARTBEAT_SECRET = "monitor-browser-heartbeat-secret-that-is-long-enough";
    expect(createProgramMonitoringConnection(3, {
      nowMs: 1_000,
      credentialId: "10000000-0000-4000-8000-000000000001"
    })).toEqual({
      heartbeatUrl: "https://monitor.example.test/v1/browser-heartbeats",
      thumbnailUrl: "https://monitor.example.test/v1/browser-thumbnails",
      credentialId: "10000000-0000-4000-8000-000000000001",
      credential: "eyJ2IjoxLCJjaWQiOiIxMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJjb3VydCI6MywiaWF0IjoxMDAwLCJleHAiOjY0ODAxMDAwfQ.Zt4AiuJ0hr4jb8kh4nMGqp4E66uUYToLWIn4_7UXuk4"
    });
  });

  it("stays disabled unless both endpoint and secret are configured", () => {
    expect(createProgramMonitoringConnection(1)).toBeNull();
  });

  it("rejects malformed and insecure non-local monitoring URLs", () => {
    process.env.MONITOR_BROWSER_HEARTBEAT_SECRET = "b".repeat(32);
    process.env.MONITOR_PUBLIC_URL = "not a url";
    expect(createProgramMonitoringConnection(1)).toBeNull();
    process.env.MONITOR_PUBLIC_URL = "http://monitor.example.test";
    expect(createProgramMonitoringConnection(1)).toBeNull();
    process.env.MONITOR_PUBLIC_URL = "ftp://localhost";
    expect(createProgramMonitoringConnection(1)).toBeNull();
    process.env.MONITOR_PUBLIC_URL = "http://localhost:9109";
    expect(createProgramMonitoringConnection(1)).not.toBeNull();
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

describe("buildProgramMonitorHeartbeat", () => {
  it("passes through a healthy payload", () => {
    const body = buildProgramMonitorHeartbeat(base({
      courtNumber: 3,
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
      commentarySyncSampleAgeMs: 210.2
    }));
    expect(body.video).toMatchObject({ state: "playing", framesRendered: 5400, framesPerSecond: 30, transport: "whep" });
    expect(body.commentary).toMatchObject({
      roomConnected: true,
      participantCount: 2,
      audioTrackCount: 1,
      rmsDb: -24,
      peakDb: -10,
      secondsSinceAudio: 0.3,
      syncStatus: "locked",
      targetDelayMs: 3025,
      appliedDelayMs: 3013
    });
    expect(body.scoreRender.sourceSignature).toBe(body.scoreRender.renderedSignature);
  });

  it("normalizes hostile media-element values", () => {
    const body = buildProgramMonitorHeartbeat(base({
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
      pageBuildVersion: "",
      streamHealth: {
        ...base({}).streamHealth!,
        framesPerSecond: 999,
        width: -1,
        packetsLost: -4
      }
    }));
    expect(body.courtNumber).toBe(3);
    expect(body.video).toMatchObject({ state: "unknown", framesRendered: 0, framesPerSecond: 240, width: 1, packetsLost: 0 });
    expect(body.commentary).toMatchObject({
      participantCount: 0,
      audioTrackCount: 0,
      rmsDb: null,
      peakDb: 12,
      secondsSinceAudio: 0,
      cameraRmsDb: -120,
      syncStatus: "fallback",
      configuredDelayMs: 0,
      targetDelayMs: null,
      appliedDelayMs: 10_000,
      clockRttMs: 60,
      syncSampleAgeMs: null
    });
    expect(body.pageBuildVersion).toBe("local");
  });

  it("floors fractional frame counts and zeroes negatives", () => {
    expect(buildProgramMonitorHeartbeat(base({ framesRendered: 12.9 })).video.framesRendered).toBe(12);
    expect(buildProgramMonitorHeartbeat(base({ framesRendered: -3 })).video.framesRendered).toBe(0);
    expect(buildProgramMonitorHeartbeat(base({ framesRendered: null })).video.framesRendered).toBe(0);
  });

  it("bounds identifiers and score signatures", () => {
    const body = buildProgramMonitorHeartbeat(base({
      pageBuildVersion: "y".repeat(200),
      scoreRender: { ...base({}).scoreRender, sourceSignature: "s".repeat(500) }
    }));
    expect(body.pageBuildVersion).toHaveLength(64);
    expect(body.scoreRender.sourceSignature).toHaveLength(240);
  });
});

function base(overrides: Partial<Parameters<typeof buildProgramMonitorHeartbeat>[0]>) {
  return {
    credentialId: "10000000-0000-4000-8000-000000000001",
    courtNumber: 1,
    heartbeatSeq: 1,
    sampledAt: "2026-07-12T18:30:00.000Z",
    pageLoadedAt: "2026-07-12T18:29:00.000Z",
    pageBuildVersion: "build-1",
    configurationVersion: "config-1",
    videoState: "playing",
    framesRendered: 0,
    streamHealth: {
      transport: "whep",
      connectionState: "connected",
      framesPerSecond: 30,
      width: 1280,
      height: 720,
      rttMs: 20,
      jitterBufferMs: 80,
      packetsLost: 0,
      packetsReceived: 1_000,
      framesDropped: 0,
      bytesReceived: 5_000_000
    },
    reconnectCount: 0,
    reloadCount: 0,
    commentaryConfigured: true,
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
    scoreRender: {
      loaded: true,
      connected: true,
      stale: false,
      frozen: false,
      matchId: "20000000-0000-4000-8000-000000000001",
      phase: "LIVE",
      sourceSignature: "match|LIVE|1|12|10",
      renderedSignature: "match|LIVE|1|12|10",
      domMismatchReason: null,
      stateUpdatedAt: "2026-07-12T18:29:59.000Z"
    },
    ...overrides
  };
}
