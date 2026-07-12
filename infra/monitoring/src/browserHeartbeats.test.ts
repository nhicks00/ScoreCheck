import { describe, expect, it } from "vitest";
import { BrowserHeartbeatManager, signCredentialForTest } from "./browserHeartbeats.js";

const secret = "monitor-browser-heartbeat-secret-that-is-long-enough";
const credentialId = "10000000-0000-4000-8000-000000000001";
const now = new Date("2026-07-12T18:30:00.000Z");

function token(courtNumber = 1) {
  return signCredentialForTest({
    secret,
    credentialId,
    courtNumber,
    issuedAtMs: now.getTime() - 1_000,
    expiresAtMs: now.getTime() + 60_000
  });
}

function payload(sequence = 1) {
  return {
    version: 1,
    credentialId,
    courtNumber: 1,
    heartbeatSeq: sequence,
    sampledAt: now.toISOString(),
    pageLoadedAt: "2026-07-12T18:29:00.000Z",
    pageBuildVersion: "build-1",
    configurationVersion: "config-1",
    video: {
      state: "playing",
      transport: "whep",
      connectionState: "connected",
      framesRendered: 1_800,
      framesPerSecond: 30,
      width: 1280,
      height: 720,
      rttMs: 21,
      jitterBufferMs: 80,
      packetsLost: 0,
      packetsReceived: 12_000,
      framesDropped: 0,
      bytesReceived: 4_000_000,
      reconnectCount: 0,
      reloadCount: 0
    },
    commentary: {
      configured: true,
      roomConnected: true,
      participantCount: 1,
      audioTrackCount: 1,
      rmsDb: -24,
      peakDb: -12,
      secondsSinceAudio: 0.4,
      cameraRmsDb: -30,
      syncStatus: "locked",
      configuredDelayMs: 3_000,
      targetDelayMs: 2_980,
      appliedDelayMs: 2_980,
      clockRttMs: 28,
      syncSampleAgeMs: 350
    },
    scoreRender: {
      loaded: true,
      connected: true,
      stale: false,
      frozen: false,
      matchId: "20000000-0000-4000-8000-000000000001",
      phase: "LIVE",
      sourceSignature: "match|LIVE|1|12|10|0|0",
      renderedSignature: "match|LIVE|1|12|10|0|0",
      domMismatchReason: null,
      stateUpdatedAt: "2026-07-12T18:29:59.000Z"
    }
  };
}

describe("browser heartbeat manager", () => {
  it("shares a stable credential format with the program page", () => {
    expect(signCredentialForTest({
      secret,
      credentialId,
      courtNumber: 3,
      issuedAtMs: 1_000,
      expiresAtMs: 64_801_000
    })).toBe("eyJ2IjoxLCJjaWQiOiIxMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJjb3VydCI6MywiaWF0IjoxMDAwLCJleHAiOjY0ODAxMDAwfQ.Zt4AiuJ0hr4jb8kh4nMGqp4E66uUYToLWIn4_7UXuk4");
  });

  it("accepts a scoped fresh heartbeat", () => {
    const manager = new BrowserHeartbeatManager(secret);
    expect(manager.accept(token(), payload(), now).courtNumber).toBe(1);
    expect(manager.latest().get(1)?.video.framesPerSecond).toBe(30);
  });

  it("rejects replays, court mismatches, and stale samples", () => {
    const manager = new BrowserHeartbeatManager(secret);
    manager.accept(token(), payload(2), now);
    expect(() => manager.accept(token(), payload(2), now)).toThrow(/replayed/i);
    expect(() => manager.accept(token(2), payload(3), now)).toThrow(/scope/i);
    expect(() => manager.accept(token(), { ...payload(3), sampledAt: "2026-07-12T18:00:00.000Z" }, now)).toThrow(/replay window/i);
  });

  it("rejects tampered credentials and unknown payload fields", () => {
    const manager = new BrowserHeartbeatManager(secret);
    expect(() => manager.accept(`${token()}x`, payload(), now)).toThrow(/credential/i);
    expect(() => manager.accept(token(), { ...payload(), token: "must-not-cross-gateway" }, now)).toThrow();
  });
});
