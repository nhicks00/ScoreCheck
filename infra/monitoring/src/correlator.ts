import { MONITORING_CONTRACT_VERSION, worstHealthState, type AgentSnapshot, type HealthState, type IncidentSnapshot, type MediaPathSnapshot, type MonitorSnapshot, type MonitoringStage, type StageHealth } from "./contracts.js";
import type { AgentTarget } from "./config.js";

export type AgentRuntime = {
  target: AgentTarget;
  snapshot: AgentSnapshot | null;
  lastSeenAt: string | null;
  lastErrorAt: string | null;
};

export function buildMonitorSnapshot(targets: AgentTarget[], runtimes: Map<string, AgentRuntime>, courtCount: number, nowMs = Date.now(), incidents: IncidentSnapshot[] = []): MonitorSnapshot {
  const agents = targets.map((target) => {
    const runtime = runtimes.get(target.id);
    const ageMs = age(runtime?.lastSeenAt ?? null, nowMs);
    return {
      agentId: target.id,
      role: target.role,
      state: agentState(runtime?.snapshot ?? null, ageMs),
      lastSeenAt: runtime?.lastSeenAt ?? null,
      ageMs
    };
  });

  const paths = latestMediaPaths(runtimes, nowMs);
  const courts = Array.from({ length: courtCount }, (_, index) => {
    const courtNumber = index + 1;
    const courtPaths = paths.filter((path) => path.courtNumber === courtNumber);
    const byBranch = Object.fromEntries(courtPaths.map((path) => [path.branch, path])) as Partial<Record<MediaPathSnapshot["branch"], MediaPathSnapshot>>;
    const stages = [
      pathStage("RAW_INGEST", "raw", byBranch.raw ?? null, nowMs),
      pathStage("PREVIEW", "preview", byBranch.preview ?? null, nowMs),
      pathStage("PROGRAM_PATH", "program", byBranch.program ?? null, nowMs)
    ];
    return {
      courtNumber,
      overallState: worstHealthState(stages.map((stage) => stage.state)),
      stages,
      paths: byBranch
    };
  });

  const agentsFresh = agents.filter((agent) => agent.state === "HEALTHY" || agent.state === "DEGRADED").length;
  return {
    version: MONITORING_CONTRACT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    collector: {
      state: targets.length === 0 ? "UNKNOWN" : worstHealthState(agents.map((agent) => agent.state)),
      agentsExpected: targets.length,
      agentsFresh
    },
    courts,
    agents,
    incidents
  };
}

function agentState(snapshot: AgentSnapshot | null, ageMs: number | null): HealthState {
  if (!snapshot || ageMs == null || ageMs > 20_000) return "UNKNOWN";
  if (ageMs > 10_000 || snapshot.collectionErrors.length > 0) return "DEGRADED";
  return "HEALTHY";
}

function latestMediaPaths(runtimes: Map<string, AgentRuntime>, nowMs: number): MediaPathSnapshot[] {
  const byName = new Map<string, { path: MediaPathSnapshot; observedAtMs: number }>();
  for (const runtime of runtimes.values()) {
    if (!runtime.snapshot) continue;
    const observedAtMs = Date.parse(runtime.snapshot.generatedAt);
    if (!Number.isFinite(observedAtMs) || nowMs - observedAtMs > 20_000) continue;
    for (const path of runtime.snapshot.mediaPaths) {
      const existing = byName.get(path.name);
      if (!existing || observedAtMs > existing.observedAtMs) byName.set(path.name, { path, observedAtMs });
    }
  }
  return [...byName.values()].map((entry) => entry.path);
}

function pathStage(stage: MonitoringStage, branch: MediaPathSnapshot["branch"], path: MediaPathSnapshot | null, nowMs: number): StageHealth {
  if (!path) {
    return {
      stage,
      state: "UNKNOWN",
      severity: "warning",
      issueCode: "NO_PATH_OBSERVATION",
      summary: `No current ${branch} path observation.`,
      firstAction: "Confirm the host agent and expected coverage state.",
      confidence: "high",
      observedAt: null,
      ageMs: null,
      evidence: { branch }
    };
  }
  return {
    stage,
    state: path.ready ? "HEALTHY" : "UNKNOWN",
    severity: path.ready ? "info" : "warning",
    issueCode: path.ready ? null : "PATH_NOT_READY_EXPECTATION_UNKNOWN",
    summary: path.ready ? `${branch} path ready.` : `${branch} path is not ready; expectation has not been loaded yet.`,
    firstAction: path.ready ? null : "Check coverage expectation before treating this as an outage.",
    confidence: "high",
    observedAt: new Date(nowMs).toISOString(),
    ageMs: 0,
    evidence: {
      branch,
      ready: path.ready,
      bitrateBps: path.inboundBitrateBps,
      readers: path.readerCount,
      frameErrors: path.frameErrors
    }
  };
}

function age(timestamp: string | null, nowMs: number): number | null {
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}
