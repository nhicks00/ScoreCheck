import type { MonitorHealthState } from "./monitoringTypes";

const STATE_RANK: Record<MonitorHealthState, number> = {
  CRITICAL: 9,
  UNKNOWN: 8,
  DEGRADED: 7,
  RECOVERING: 6,
  STARTING: 5,
  HEALTHY: 4,
  MAINTENANCE: 3,
  EXPECTED_OFF: 2,
  NOT_APPLICABLE: 1
};

export function deriveMonitorSystemState(input: {
  courtStates: MonitorHealthState[];
  globalStates: MonitorHealthState[];
  hasCriticalIncident: boolean;
  stale: boolean;
}): MonitorHealthState {
  if (input.hasCriticalIncident) return "CRITICAL";
  if (input.stale) return "UNKNOWN";
  return [...input.courtStates, ...input.globalStates].reduce(
    (worst, state) => STATE_RANK[state] > STATE_RANK[worst] ? state : worst,
    "NOT_APPLICABLE" as MonitorHealthState
  );
}
