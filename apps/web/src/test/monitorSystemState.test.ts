import { describe, expect, it } from "vitest";
import { deriveMonitorSystemState } from "../lib/monitorSystemState";

describe("monitor system state", () => {
  it("does not claim readiness from a stale checkpoint", () => {
    expect(deriveMonitorSystemState({
      courtStates: ["HEALTHY"],
      globalStates: ["HEALTHY"],
      hasCriticalIncident: false,
      stale: true
    })).toBe("UNKNOWN");
  });

  it("includes degraded operator dependencies in the aggregate state", () => {
    expect(deriveMonitorSystemState({
      courtStates: ["HEALTHY", "EXPECTED_OFF"],
      globalStates: ["HEALTHY", "DEGRADED"],
      hasCriticalIncident: false,
      stale: false
    })).toBe("DEGRADED");
  });

  it("keeps a critical incident authoritative", () => {
    expect(deriveMonitorSystemState({
      courtStates: ["HEALTHY"],
      globalStates: ["UNKNOWN"],
      hasCriticalIncident: true,
      stale: true
    })).toBe("CRITICAL");
  });

  it("reports healthy only when active court and global dependencies are healthy", () => {
    expect(deriveMonitorSystemState({
      courtStates: ["HEALTHY", "EXPECTED_OFF"],
      globalStates: ["HEALTHY", "NOT_APPLICABLE"],
      hasCriticalIncident: false,
      stale: false
    })).toBe("HEALTHY");
  });
});
