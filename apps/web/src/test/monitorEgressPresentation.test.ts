import { describe, expect, it } from "vitest";
import { egressRuntimeHealthy } from "../lib/monitorEgressPresentation";

function egress(overrides: Partial<Parameters<typeof egressRuntimeHealthy>[0]> = {}): Parameters<typeof egressRuntimeHealthy>[0] {
  return {
    idle: true,
    canAcceptRequest: true,
    nativeCanAcceptRequest: true,
    activeWebRequests: 0,
    maximumWebRequests: 1,
    cgroupMemoryBytes: 512 * 1024 * 1024,
    cpuLoadRatio: 0.1,
    memoryLoadRatio: 0.2,
    ...overrides
  };
}

describe("monitor Egress presentation", () => {
  it("treats an idle admissible worker as healthy", () => {
    expect(egressRuntimeHealthy(egress())).toBe(true);
  });

  it("treats one active output at the declared maximum as healthy", () => {
    expect(egressRuntimeHealthy(egress({
      idle: false,
      canAcceptRequest: false,
      nativeCanAcceptRequest: false,
      activeWebRequests: 1
    }))).toBe(true);
  });

  it("rejects contradictory or over-capacity worker state", () => {
    expect(egressRuntimeHealthy(egress({ idle: false, activeWebRequests: 0 }))).toBe(false);
    expect(egressRuntimeHealthy(egress({ idle: false, activeWebRequests: 2 }))).toBe(false);
    expect(egressRuntimeHealthy(egress({ idle: true, canAcceptRequest: false }))).toBe(false);
  });
});
