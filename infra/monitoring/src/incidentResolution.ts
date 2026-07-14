import type { CourtMonitorSnapshot, IncidentSnapshot, MonitorSnapshot, MonitoringStage } from "./contracts.js";
import type { IncidentChange } from "./incidents.js";

export const INCIDENT_RESOLUTION_KINDS = [
  "DEPENDENCY_RECOVERED",
  "FAULT_GATE_EXPIRED",
  "FAULT_GATE_ENDED",
  "EXPECTATION_ENDED",
  "ALERT_CLEARED_UNVERIFIED"
] as const;

export type IncidentResolutionKind = typeof INCIDENT_RESOLUTION_KINDS[number];

export function enrichIncidentChange(change: IncidentChange, snapshot: MonitorSnapshot): IncidentChange {
  const court = change.incident.courtNumber == null
    ? null
    : snapshot.courts.find((entry) => entry.courtNumber === change.incident.courtNumber) ?? null;
  const context = courtContext(change.incident, court);

  if (change.eventType !== "RESOLVED") {
    return {
      ...change,
      incident: { ...change.incident, evidence: { ...change.incident.evidence, ...context } },
      detail: { ...(change.detail ?? {}), ...context }
    };
  }

  const resolution = classifyResolution(change.incident, court, context);
  return {
    ...change,
    incident: { ...change.incident, evidence: { ...change.incident.evidence, ...context, ...resolution } },
    detail: { ...(change.detail ?? {}), ...context, ...resolution }
  };
}

function classifyResolution(
  incident: IncidentSnapshot,
  court: CourtMonitorSnapshot | null,
  context: Record<string, string | number | boolean | null>
): Record<string, string | number | boolean | null> & { resolutionKind: IncidentResolutionKind } {
  if (!court) {
    return {
      resolutionKind: "DEPENDENCY_RECOVERED",
      resolutionReason: "Alertmanager confirmed that the shared alert condition cleared."
    };
  }

  if (dependencyRecoveredAtResolution(incident, court)) {
    return {
      resolutionKind: "DEPENDENCY_RECOVERED",
      resolutionReason: "The monitored dependency was healthy when the alert condition cleared."
    };
  }

  const expectationSource = context.expectationSource;
  const gateExpiresAt = typeof context.faultGateExpiresAt === "string" ? context.faultGateExpiresAt : null;
  const resolvedAtMs = Date.parse(incident.resolvedAt ?? incident.lastObservedAt);
  if (expectationSource === "fault_gate" && !court.faultGate) {
    const expired = gateExpiresAt != null
      && Number.isFinite(resolvedAtMs)
      && Date.parse(gateExpiresAt) <= resolvedAtMs;
    return {
      resolutionKind: expired ? "FAULT_GATE_EXPIRED" : "FAULT_GATE_ENDED",
      resolutionReason: expired
        ? "The intentional fault-gate expectation expired while the monitored dependency was still unhealthy."
        : "The intentional fault-gate expectation ended while the monitored dependency was still unhealthy."
    };
  }

  if (!stageExpected(incident.stage, court)) {
    return {
      resolutionKind: "EXPECTATION_ENDED",
      resolutionReason: "The monitoring expectation ended while the dependency was not proven healthy."
    };
  }

  return {
    resolutionKind: "ALERT_CLEARED_UNVERIFIED",
    resolutionReason: "The alert cleared without current evidence that the monitored dependency recovered."
  };
}

function courtContext(
  incident: IncidentSnapshot,
  court: CourtMonitorSnapshot | null
): Record<string, string | number | boolean | null> {
  if (!court) return {};
  const raw = court.paths.raw;
  const existingSource = incident.evidence.expectationSource;
  const source = existingSource === "fault_gate" || existingSource === "control_plane"
    ? existingSource
    : court.faultGate ? "fault_gate" : "control_plane";
  const existingExpiry = typeof incident.evidence.faultGateExpiresAt === "string"
    ? incident.evidence.faultGateExpiresAt
    : null;
  return {
    expectationSource: source,
    faultGateActive: court.faultGate != null,
    faultGateExpiresAt: court.faultGate?.expiresAt ?? existingExpiry,
    coveragePhase: court.expectation.coveragePhase,
    mediaExpectation: court.expectation.mediaExpectation,
    broadcastExpectation: court.expectation.broadcastExpectation,
    commentaryExpectation: court.expectation.commentaryExpectation,
    scoringExpectation: court.expectation.scoringExpectation,
    rawReady: raw?.ready ?? false,
    rawReadySince: raw?.readySince ?? null,
    rawBitrateBps: raw?.inboundBitrateBps ?? 0,
    rawFrameErrors: raw?.frameErrors ?? 0
  };
}

function dependencyRecoveredAtResolution(incident: IncidentSnapshot, court: CourtMonitorSnapshot): boolean {
  const resolvedAtMs = Date.parse(incident.resolvedAt ?? incident.lastObservedAt);
  if (incident.stage === "RAW_INGEST") {
    const raw = court.paths.raw;
    if (!raw?.ready || !raw.readySince || !Number.isFinite(resolvedAtMs)) return false;
    if (Date.parse(raw.readySince) > resolvedAtMs) return false;
    if (incident.issueCode === "RAW_BITRATE_LOW") return (raw.inboundBitrateBps ?? 0) >= 500_000;
    return true;
  }
  return court.stages.find((stage) => stage.stage === incident.stage)?.state === "HEALTHY";
}

function stageExpected(stage: MonitoringStage, court: CourtMonitorSnapshot): boolean {
  switch (stage) {
    case "RAW_INGEST":
    case "PREVIEW":
      return court.expectation.mediaExpectation !== "OFF";
    case "PROGRAM_PATH":
    case "PROGRAM_BROWSER":
    case "EGRESS":
    case "YOUTUBE":
      return court.expectation.broadcastExpectation !== "OFF";
    case "COMMENTARY":
      return court.expectation.commentaryExpectation !== "NONE";
    case "SCORE_SOURCE":
    case "SCORE_RENDER":
      return court.expectation.scoringExpectation !== "NONE";
    default:
      return true;
  }
}
