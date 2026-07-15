import { describe, expect, it } from "vitest";
import type { MonitorSnapshot } from "./contracts.js";
import { assertFaultGateCanArm, faultGateArmRequestSchema, FaultGateConflictError, FaultGateControl, faultGateExpectation } from "./faultGateControl.js";
import { buildMonitorSnapshot } from "./correlator.js";

describe("monitoring fault-gate control", () => {
  it("accepts a bounded fifteen-minute operator window", () => {
    expect(faultGateArmRequestSchema.safeParse({ actor: "codex", reason: "Camera 1 recovery gate", durationSeconds: 900 }).success).toBe(true);
    expect(faultGateArmRequestSchema.safeParse({ actor: "codex", reason: "Camera 1 recovery gate", durationSeconds: 1_801 }).success).toBe(false);
  });

  it("arms exactly one expiring in-memory court expectation", () => {
    const control = new FaultGateControl();
    const nowMs = Date.parse("2026-07-13T13:00:00.000Z");
    const gate = control.arm({ courtNumber: 4, actor: "codex", reason: "Court 4 camera-loss gate", durationSeconds: 120 }, nowMs);
    expect(gate.expiresAt).toBe("2026-07-13T13:02:00.000Z");
    expect(faultGateExpectation(gate)).toEqual({
      coveragePhase: "WARMUP",
      mediaExpectation: "REQUIRED",
      broadcastExpectation: "OFF",
      commentaryExpectation: "NONE",
      scoringExpectation: "NONE",
      overrideExpiresAt: gate.expiresAt
    });
    expect(() => control.arm({ courtNumber: 3, actor: "codex", reason: "second", durationSeconds: 120 }, nowMs + 1_000))
      .toThrowError(FaultGateConflictError);
    expect(control.active(nowMs + 120_000)).toEqual([]);
  });

  it("requires idle production control and a healthy raw baseline", () => {
    const snapshot = idleSnapshot();
    expect(() => assertFaultGateCanArm(snapshot, 4)).not.toThrow();
    expect(() => assertFaultGateCanArm({ ...snapshot, event: { id: "event", name: "Live", status: "active", eventDate: null } }, 4))
      .toThrowError(/tournament event is active/);
    const court = snapshot.courts[0]!;
    expect(() => assertFaultGateCanArm({ ...snapshot, courts: [{ ...court, paths: { raw: { ...court.paths.raw!, ready: false } } }] }, 4))
      .toThrowError(/raw feed must be ready/);
  });

  it("requires only raw ingest and leaves derived branches expected off", () => {
    const nowMs = Date.parse("2026-07-13T13:00:00.000Z");
    const gate = new FaultGateControl().arm({ courtNumber: 4, actor: "codex", reason: "raw gate", durationSeconds: 120 }, nowMs);
    const snapshot = buildMonitorSnapshot([], new Map(), 4, nowMs, [], new Map(), null, null, undefined, undefined, new Map(), [], [gate]);
    const court = snapshot.courts[3]!;
    expect(court.stages.find((stage) => stage.stage === "RAW_INGEST")?.state).toBe("CRITICAL");
    expect(court.stages.find((stage) => stage.stage === "PREVIEW")?.state).toBe("EXPECTED_OFF");
    expect(court.stages.find((stage) => stage.stage === "PROGRAM_PATH")?.state).toBe("EXPECTED_OFF");
    expect(court.stages.find((stage) => stage.stage === "PROGRAM_BROWSER")?.state).toBe("EXPECTED_OFF");
  });
});

function idleSnapshot(): MonitorSnapshot {
  return {
    version: 2,
    generatedAt: "2026-07-13T13:00:00.000Z",
    collector: { state: "HEALTHY", agentsExpected: 6, agentsFresh: 6 },
    controlPlane: { state: "HEALTHY", observedAt: "2026-07-13T13:00:00.000Z", ageMs: 0, worker: { state: "NOT_APPLICABLE", status: null, lastSeenAt: null, ageMs: null } },
    event: null,
    youtube: { state: "NOT_APPLICABLE", observedAt: null, ageMs: null },
    notifications: { state: "HEALTHY", pushover: { configured: true, lastSuccessAt: null, lastFailureAt: null }, twilioSms: { configured: false, lastSuccessAt: null, lastFailureAt: null } },
    deadMan: {
      state: "HEALTHY",
      baseline: { configured: true, mode: "RUNNING", lastSuccessAt: null, lastFailureAt: null },
      active: { configured: true, mode: "PAUSED", lastSuccessAt: null, lastFailureAt: null },
      phoneChannel: { configured: true, state: "HEALTHY", baselineAttached: true, activeAttached: true, lastSuccessAt: null, lastFailureAt: null }
    },
    courts: [{
      courtNumber: 4,
      overallState: "HEALTHY",
      stages: [],
      paths: { raw: { name: "court4_raw", courtNumber: 4, branch: "raw", ready: true, readySince: "2026-07-13T12:00:00.000Z", bytesReceived: 1_000, bytesSent: 0, inboundBitrateBps: 3_000_000, frameErrors: 0, readerCount: 0, sourceProtocol: "SRT", sourceMode: "PUSH", videoCodec: "H265", audioCodec: "AAC", videoWidth: 1920, videoHeight: 1080, videoProfile: "Main", audioSampleRateHz: 48_000, audioChannelCount: 2, transport: null } },
      ffmpeg: {},
      browser: null,
      competition: null,
      expectation: { coveragePhase: "OFF", mediaExpectation: "OFF", broadcastExpectation: "OFF", commentaryExpectation: "NONE", scoringExpectation: "NONE", overrideExpiresAt: null },
      faultGate: null,
      youtube: null,
      thumbnail: null,
      egressHost: null
    }],
    agents: [],
    incidents: [],
    silences: [],
    faultGates: []
  };
}
