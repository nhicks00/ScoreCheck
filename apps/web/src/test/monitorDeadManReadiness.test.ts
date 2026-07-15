import { describe, expect, it } from "vitest";
import { deriveMonitorDeadManReadiness } from "../lib/monitorDeadManReadiness";
import type { MonitorSnapshot } from "../lib/monitoringTypes";

type DeadMan = MonitorSnapshot["deadMan"];

describe("monitor external watchdog readiness", () => {
  it("degrades email-only checks instead of presenting them as phone protected", () => {
    expect(deriveMonitorDeadManReadiness(deadMan({
      phoneChannel: channel({ baselineAttached: false, activeAttached: false, state: "DEGRADED" })
    }))).toEqual({ label: "Phone not attached", state: "DEGRADED" });
  });

  it("identifies the missing check attachment", () => {
    expect(deriveMonitorDeadManReadiness(deadMan({
      phoneChannel: channel({ baselineAttached: true, activeAttached: false, state: "DEGRADED" })
    }))).toEqual({ label: "Coverage phone off", state: "DEGRADED" });
    expect(deriveMonitorDeadManReadiness(deadMan({
      phoneChannel: channel({ baselineAttached: false, activeAttached: true, state: "DEGRADED" })
    }))).toEqual({ label: "Idle phone off", state: "DEGRADED" });
  });

  it("distinguishes provider audit failure from missing attachment", () => {
    expect(deriveMonitorDeadManReadiness(deadMan({
      phoneChannel: channel({
        state: "DEGRADED",
        lastFailureAt: "2026-07-15T00:05:00.000Z"
      })
    }))).toEqual({ label: "Phone check failed", state: "DEGRADED" });
  });

  it("reports protected only when both checks and their phone channel are healthy", () => {
    expect(deriveMonitorDeadManReadiness(deadMan())).toEqual({ label: "Idle protected", state: "HEALTHY" });
    expect(deriveMonitorDeadManReadiness(deadMan({ activeMode: "RUNNING" }))).toEqual({ label: "Coverage protected", state: "HEALTHY" });
  });

  it("keeps ping delivery failure visible after phone attachment is verified", () => {
    expect(deriveMonitorDeadManReadiness(deadMan({ state: "DEGRADED" }))).toEqual({
      label: "Check delivery failed",
      state: "DEGRADED"
    });
  });
});

function deadMan({
  state = "HEALTHY",
  activeMode = "PAUSED",
  phoneChannel = channel()
}: {
  state?: DeadMan["state"];
  activeMode?: DeadMan["active"]["mode"];
  phoneChannel?: DeadMan["phoneChannel"];
} = {}): DeadMan {
  return {
    state,
    baseline: { configured: true, mode: "RUNNING", lastSuccessAt: null, lastFailureAt: null },
    active: { configured: true, mode: activeMode, lastSuccessAt: null, lastFailureAt: null },
    phoneChannel
  };
}

function channel(patch: Partial<DeadMan["phoneChannel"]> = {}): DeadMan["phoneChannel"] {
  return {
    configured: true,
    state: "HEALTHY",
    baselineAttached: true,
    activeAttached: true,
    lastSuccessAt: "2026-07-15T00:00:00.000Z",
    lastFailureAt: null,
    ...patch
  };
}
