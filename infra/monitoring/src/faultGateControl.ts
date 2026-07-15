import { z } from "zod";
import type { CourtExpectation, MonitoringFaultGate, MonitorSnapshot } from "./contracts.js";

export const faultGateArmRequestSchema = z.object({
  profile: z.enum(["RAW_ONLY", "PROGRAM_CONTENT"]),
  actor: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:@-]+$/),
  reason: z.string().trim().min(3).max(300).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  durationSeconds: z.number().int().min(60).max(1_800)
}).strict();

export class FaultGateConflictError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FaultGateConflictError";
  }
}

export class FaultGateControl {
  private gate: MonitoringFaultGate | null = null;

  arm(input: { courtNumber: number; profile: MonitoringFaultGate["profile"]; actor: string; reason: string; durationSeconds: number }, nowMs = Date.now()): MonitoringFaultGate {
    const current = this.active(nowMs)[0] ?? null;
    if (current) {
      throw new FaultGateConflictError("FAULT_GATE_ALREADY_ARMED", `Court ${current.courtNumber} already owns the monitoring fault gate.`);
    }
    this.gate = {
      courtNumber: input.courtNumber,
      profile: input.profile,
      actor: input.actor,
      reason: input.reason,
      armedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + input.durationSeconds * 1_000).toISOString()
    };
    return { ...this.gate };
  }

  disarm(courtNumber: number, nowMs = Date.now()): MonitoringFaultGate | null {
    const current = this.active(nowMs)[0] ?? null;
    if (!current || current.courtNumber !== courtNumber) return null;
    this.gate = null;
    return current;
  }

  active(nowMs = Date.now()): MonitoringFaultGate[] {
    if (this.gate && Date.parse(this.gate.expiresAt) <= nowMs) this.gate = null;
    return this.gate ? [{ ...this.gate }] : [];
  }
}

export function assertFaultGateCanArm(snapshot: MonitorSnapshot, courtNumber: number): void {
  if (snapshot.event) {
    throw new FaultGateConflictError("ACTIVE_EVENT", "Monitoring fault gates cannot be armed while a tournament event is active.");
  }
  if (snapshot.collector.state !== "HEALTHY" || snapshot.collector.agentsFresh !== snapshot.collector.agentsExpected) {
    throw new FaultGateConflictError("COLLECTOR_NOT_HEALTHY", "All monitoring agents must be fresh before arming a fault gate.");
  }
  const court = snapshot.courts.find((entry) => entry.courtNumber === courtNumber);
  if (!court) throw new FaultGateConflictError("COURT_NOT_FOUND", "The requested court is not monitored.");
  if (!expectationIsOff(court.expectation)) {
    throw new FaultGateConflictError("COURT_EXPECTATION_ACTIVE", "The requested court already has an active production expectation.");
  }
  if (snapshot.incidents.some((incident) => incident.status !== "resolved" && incident.courtNumber === courtNumber)) {
    throw new FaultGateConflictError("COURT_INCIDENT_ACTIVE", "Resolve existing court incidents before arming a fault gate.");
  }
  if (!court.paths.raw?.ready || (court.paths.raw.inboundBitrateBps ?? 0) <= 0) {
    throw new FaultGateConflictError("RAW_BASELINE_UNHEALTHY", "The court raw feed must be ready and receiving data before arming a fault gate.");
  }
}

export function faultGateExpectation(gate: MonitoringFaultGate): CourtExpectation {
  return {
    coveragePhase: gate.profile === "PROGRAM_CONTENT" ? "LIVE_MATCH" : "WARMUP",
    mediaExpectation: "REQUIRED",
    broadcastExpectation: "OFF",
    commentaryExpectation: "NONE",
    scoringExpectation: "NONE",
    overrideExpiresAt: gate.expiresAt
  };
}

function expectationIsOff(expectation: CourtExpectation): boolean {
  return expectation.coveragePhase === "OFF"
    && expectation.mediaExpectation === "OFF"
    && expectation.broadcastExpectation === "OFF"
    && expectation.commentaryExpectation === "NONE"
    && expectation.scoringExpectation === "NONE";
}
