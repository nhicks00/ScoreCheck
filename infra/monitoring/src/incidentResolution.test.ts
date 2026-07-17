import { describe, expect, it } from "vitest";
import type { CourtMonitorSnapshot, IncidentSnapshot, MonitorSnapshot, MonitoringFaultGate } from "./contracts.js";
import { enrichIncidentChange } from "./incidentResolution.js";

describe("incident resolution semantics", () => {
  it("records fault-gate expiry and does not claim dependency recovery while raw remains down", () => {
    const change = enrichIncidentChange(resolvedIncident(), snapshot({ rawReady: false, gate: null, expectationRequired: false }));

    expect(change.detail).toMatchObject({
      resolutionKind: "FAULT_GATE_EXPIRED",
      expectationSource: "fault_gate",
      rawReady: false,
      faultGateActive: false
    });
    expect(change.incident.evidence.resolutionKind).toBe("FAULT_GATE_EXPIRED");
  });

  it("records dependency recovery when raw returned before the alert resolved and the gate is still active", () => {
    const incident = resolvedIncident({ resolvedAt: "2026-07-13T13:01:30.000Z" });
    const change = enrichIncidentChange(incident, snapshot({
      rawReady: true,
      rawReadySince: "2026-07-13T13:01:20.000Z",
      gate: faultGate("2026-07-13T13:15:00.000Z"),
      expectationRequired: true
    }));

    expect(change.detail).toMatchObject({
      resolutionKind: "DEPENDENCY_RECOVERED",
      expectationSource: "fault_gate",
      rawReady: true,
      faultGateActive: true
    });
  });

  it("does not backdate a late raw reconnect into an earlier fault-gate resolution", () => {
    const change = enrichIncidentChange(resolvedIncident(), snapshot({
      rawReady: true,
      rawReadySince: "2026-07-13T13:02:20.000Z",
      gate: null,
      expectationRequired: false
    }));

    expect(change.detail?.resolutionKind).toBe("FAULT_GATE_EXPIRED");
  });

  it("records a manual gate end separately from dependency recovery", () => {
    const incident = resolvedIncident({
      resolvedAt: "2026-07-13T13:01:10.000Z",
      lastObservedAt: "2026-07-13T13:01:10.000Z"
    });
    const change = enrichIncidentChange(incident, snapshot({
      rawReady: false,
      gate: null,
      expectationRequired: false
    }));

    expect(change.detail).toMatchObject({
      resolutionKind: "FAULT_GATE_ENDED",
      expectationSource: "fault_gate",
      rawReady: false,
      faultGateActive: false
    });
  });
});

function resolvedIncident(patch: Partial<IncidentSnapshot> = {}) {
  const incident: IncidentSnapshot = {
    id: "00000000-0000-4000-8000-000000000001",
    fingerprint: "idle|mediamtx|RAW_INGEST|court-1|REQUIRED_RAW_PATH_MISSING",
    eventId: null,
    rootDependency: "mediamtx",
    status: "resolved",
    severity: "critical",
    stage: "RAW_INGEST",
    issueCode: "REQUIRED_RAW_PATH_MISSING",
    courtNumber: 1,
    host: "bvm-preview-01",
    summary: "[INTENTIONAL FAULT GATE] Required camera ingest is missing on court 1.",
    firstAction: "Restore the isolated test feed.",
    evidence: {
      expectationSource: "fault_gate",
      faultGateExpiresAt: "2026-07-13T13:02:00.000Z"
    },
    openedAt: "2026-07-13T13:00:30.000Z",
    lastObservedAt: "2026-07-13T13:02:10.000Z",
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: "2026-07-13T13:02:10.000Z",
    ...patch
  };
  return { incident, eventType: "RESOLVED" as const };
}

function faultGate(expiresAt: string): MonitoringFaultGate {
  return {
    courtNumber: 1,
    profile: "RAW_ONLY",
    actor: "codex",
    reason: "Camera 1 raw-loss gate",
    armedAt: "2026-07-13T13:00:00.000Z",
    expiresAt
  };
}

function snapshot(input: {
  rawReady: boolean;
  rawReadySince?: string;
  gate: MonitoringFaultGate | null;
  expectationRequired: boolean;
}): MonitorSnapshot {
  const court: CourtMonitorSnapshot = {
    courtNumber: 1,
    overallState: input.rawReady ? "HEALTHY" : "UNKNOWN",
    stages: [{
      stage: "RAW_INGEST",
      state: input.rawReady ? "HEALTHY" : "UNKNOWN",
      severity: "info",
      issueCode: null,
      summary: input.rawReady ? "raw path ready." : "raw path unavailable.",
      firstAction: null,
      confidence: "high",
      observedAt: "2026-07-13T13:02:10.000Z",
      ageMs: 0,
      evidence: {}
    }],
    paths: { raw: {
      name: "court1_raw",
      courtNumber: 1,
      branch: "raw",
      ready: input.rawReady,
      readySince: input.rawReadySince ?? null,
      bytesReceived: input.rawReady ? 1_000 : 0,
      bytesSent: 0,
      inboundBitrateBps: input.rawReady ? 3_000_000 : 0,
      frameErrors: 0,
      readerCount: 0,
      sourceProtocol: "RTMP",
      sourceMode: "PUSH",
      videoCodec: "H264",
      audioCodec: "AAC",
      videoWidth: 1920,
      videoHeight: 1080,
      videoProfile: "Main",
      audioSampleRateHz: 48_000,
      audioChannelCount: 2,
      transport: null
    } },
    ffmpeg: {},
    contentAnalysis: null,
    browser: null,
    competition: null,
    expectation: input.expectationRequired
      ? { coveragePhase: "WARMUP", mediaExpectation: "REQUIRED", broadcastExpectation: "OFF", commentaryExpectation: "NONE", scoringExpectation: "NONE", overrideExpiresAt: input.gate?.expiresAt ?? null }
      : { coveragePhase: "OFF", mediaExpectation: "OFF", broadcastExpectation: "OFF", commentaryExpectation: "NONE", scoringExpectation: "NONE", overrideExpiresAt: null },
    faultGate: input.gate,
    youtube: null,
    thumbnail: null,
    egressHost: "bvm-compositor-a"
  };
  return {
    version: 4,
    generatedAt: "2026-07-13T13:02:10.000Z",
    collector: { state: "HEALTHY", agentsExpected: 6, agentsFresh: 6 },
    controlPlane: { state: "HEALTHY", observedAt: "2026-07-13T13:02:10.000Z", ageMs: 0, worker: { state: "NOT_APPLICABLE", status: null, lastSeenAt: null, ageMs: null } },
    event: null,
    youtube: { state: "NOT_APPLICABLE", observedAt: null, ageMs: null },
    notifications: { state: "HEALTHY", pushover: { configured: true, lastSuccessAt: null, lastFailureAt: null } },
    deadMan: {
      state: "HEALTHY",
      baseline: { configured: true, mode: "RUNNING", lastSuccessAt: null, lastFailureAt: null },
      active: { configured: true, mode: "PAUSED", lastSuccessAt: null, lastFailureAt: null },
      phoneChannel: { configured: true, state: "HEALTHY", baselineAttached: true, activeAttached: true, lastSuccessAt: null, lastFailureAt: null }
    },
    courts: [court],
    agents: [],
    incidents: [],
    silences: [],
    faultGates: input.gate ? [input.gate] : []
  };
}
