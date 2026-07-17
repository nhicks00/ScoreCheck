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
      credential: "eyJ2Ijo0LCJjaWQiOiIxMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJjb3VydCI6MywiaWF0IjoxMDAwLCJleHAiOjY0ODAxMDAwfQ.YZ3EFSm3dpfp3Cr8SJjCC2Jb8A1fypoiJWV2bVBp3kk"
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
      renderWatchdogEligible: sample.renderWatchdogEligible ?? true,
      presentedFrames: sample.presentedFrames ?? 0,
      inboundFrames: sample.inboundFrames === undefined ? (sample.presentedFrames ?? 0) : sample.inboundFrames
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
      { atMs: 1000, presentedFrames: 0, inboundFrames: 0 },
      { atMs: 2000, presentedFrames: 30, inboundFrames: 30 },
      { atMs: 3000, presentedFrames: 61, inboundFrames: 61 }
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

  it("tolerates a proven render stall up to the grace window, then reconnects", () => {
    const { actions } = runWatchdog([
      { atMs: 0, presentedFrames: 100, inboundFrames: 100 },
      { atMs: 1000, presentedFrames: 130, inboundFrames: 130 },
      { atMs: 2000, presentedFrames: 130, inboundFrames: 160 }, // render-stall clock starts
      { atMs: 2000 + PROGRAM_WATCHDOG_STALL_MS, presentedFrames: 130, inboundFrames: 310 },
      { atMs: 2001 + PROGRAM_WATCHDOG_STALL_MS, presentedFrames: 130, inboundFrames: 340 }
    ]);
    expect(actions).toEqual(["none", "none", "none", "none", "reconnect"]);
  });

  it("remounts a stuck connected transport without escalating to a page reload", () => {
    const { actions } = runWatchdog([
      { atMs: 0, presentedFrames: 50, inboundFrames: 50 },
      { atMs: 1000, presentedFrames: 80, inboundFrames: 80 },
      { atMs: 2000, presentedFrames: 80, inboundFrames: 80 },
      { atMs: 2000 + PROGRAM_WATCHDOG_STALL_MS, presentedFrames: 80, inboundFrames: 80 },
      { atMs: 2001 + PROGRAM_WATCHDOG_STALL_MS, presentedFrames: 80, inboundFrames: 80 }
    ]);
    expect(actions).toEqual(["none", "none", "none", "none", "reconnect"]);
  });

  it("never acts in a hidden tab or before transport stats are eligible", () => {
    const { actions } = runWatchdog([
      { atMs: 0, presentedFrames: 0, inboundFrames: 0, renderWatchdogEligible: false },
      { atMs: 30_000, presentedFrames: 0, inboundFrames: 900, renderWatchdogEligible: false },
      { atMs: 60_000, presentedFrames: 0, inboundFrames: null, renderWatchdogEligible: true }
    ]);
    expect(actions).toEqual(["none", "none", "none"]);
  });

  it("never mistakes the post-reconnect metric reset for playback progress", () => {
    const afterReconnect = runWatchdog([
      { atMs: 0, presentedFrames: 4523, inboundFrames: 4523 },
      { atMs: 1000, presentedFrames: 4553, inboundFrames: 4553 },
      { atMs: 2000, presentedFrames: 4553, inboundFrames: 4583 },
      { atMs: 8000, presentedFrames: 4553, inboundFrames: 4763 }
    ]);
    const step = programWatchdogStep(afterReconnect.state, {
      nowMs: 9000,
      hasSources: true,
      renderWatchdogEligible: true,
      presentedFrames: 0,
      inboundFrames: 0
    });
    expect(step.progressed).toBe(false);
    expect(step.action).toBe("none");
    expect(step.state.renderStallStartedAtMs).toBeNull();
  });

  it("clears render-stall evidence once presented frames flow again", () => {
    const { state, actions, progressedFlags } = runWatchdog([
      { atMs: 0, presentedFrames: 10, inboundFrames: 10 },
      { atMs: 1000, presentedFrames: 20, inboundFrames: 20 },
      { atMs: 2000, presentedFrames: 20, inboundFrames: 50 },
      { atMs: 3000, presentedFrames: 50, inboundFrames: 80 }
    ]);
    expect(actions).toEqual(["none", "none", "none", "none"]);
    expect(progressedFlags[3]).toBe(true);
    expect(state.renderStallStartedAtMs).toBeNull();
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
    expect(body.version).toBe(4);
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
      jitterMs: 4,
      jitterBufferMs: 80,
      packetsLost: 0,
      packetsReceived: 1_000,
      framesReceived: 900,
      framesDecoded: 899,
      keyFramesDecoded: 30,
      framesDropped: 0,
      bytesReceived: 5_000_000,
      freezeCount: 0,
      totalFreezesDurationMs: 0,
      lastPacketAgeMs: 12,
      nackCount: 2,
      pliCount: 1,
      firCount: 0
    },
    visualHealth: {
      sampledAt: "2026-07-12T18:29:59.000Z",
      meanLuma: 120,
      lumaVariance: 900,
      darkPixelRatio: 0.02,
      frameDifference: 14,
      frozenDurationMs: 0,
      blackDurationMs: 0
    },
    reconnectCount: 0,
    reloadCount: 0,
    commentaryConfigured: true,
    commentaryRoomConnected: false,
    commentaryParticipantCount: 0,
    commentaryAudioTrackCount: 0,
    commentaryMutedAudioTrackCount: 0,
    commentaryRmsDb: null,
    commentaryPeakDb: null,
    commentaryClippedSampleRatio: null,
    secondsSinceCommentaryAudio: null,
    commentaryPacketsLost: null,
    commentaryPacketsReceived: null,
    commentaryJitterBufferMs: null,
    cameraAudioTrackPresent: false,
    cameraAudioRmsDb: null,
    cameraAudioPeakDb: null,
    cameraAudioClippedSampleRatio: null,
    secondsSinceCameraAudio: null,
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
