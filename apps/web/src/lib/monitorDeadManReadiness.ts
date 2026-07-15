import type { MonitorHealthState, MonitorSnapshot } from "./monitoringTypes";

export type MonitorDeadManReadiness = {
  label: string;
  state: MonitorHealthState;
};

export function deriveMonitorDeadManReadiness(deadMan: MonitorSnapshot["deadMan"]): MonitorDeadManReadiness {
  const channel = deadMan.phoneChannel;
  if (!channel.configured || channel.state === "NOT_APPLICABLE") {
    return { label: "Phone setup missing", state: "DEGRADED" };
  }
  if (channel.lastFailureAt) {
    return { label: "Phone check failed", state: "DEGRADED" };
  }
  if (channel.state === "UNKNOWN" || channel.baselineAttached == null || channel.activeAttached == null) {
    return { label: "Checking phone", state: "UNKNOWN" };
  }
  if (!channel.baselineAttached && !channel.activeAttached) {
    return { label: "Phone not attached", state: "DEGRADED" };
  }
  if (!channel.baselineAttached) {
    return { label: "Idle phone off", state: "DEGRADED" };
  }
  if (!channel.activeAttached) {
    return { label: "Coverage phone off", state: "DEGRADED" };
  }
  if (deadMan.state === "DEGRADED") {
    return { label: "Check delivery failed", state: "DEGRADED" };
  }
  if (deadMan.state === "UNKNOWN") {
    return { label: "Verifying checks", state: "UNKNOWN" };
  }
  if (deadMan.state === "NOT_APPLICABLE") {
    return { label: "Checks not running", state: "DEGRADED" };
  }
  return {
    label: deadMan.active.mode === "RUNNING" ? "Coverage protected" : "Idle protected",
    state: "HEALTHY"
  };
}
