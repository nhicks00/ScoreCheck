import { describe, expect, it } from "vitest";
import { deriveMonitorPagingReadiness } from "../lib/monitorPagingReadiness";
import type { MonitorSnapshot } from "../lib/monitoringTypes";

type Notifications = MonitorSnapshot["notifications"];

describe("monitor paging readiness", () => {
  it("treats verified Pushover as complete phone paging", () => {
    expect(deriveMonitorPagingReadiness(notifications({
      state: "HEALTHY",
      push: { configured: true, lastSuccessAt: "2026-07-15T01:35:16.265Z", lastFailureAt: null }
    }))).toEqual({ label: "Pushover ready", state: "HEALTHY" });
  });

  it("distinguishes untested Pushover from failed Pushover", () => {
    expect(deriveMonitorPagingReadiness(notifications({
      state: "UNKNOWN",
      push: { configured: true, lastSuccessAt: null, lastFailureAt: null }
    }))).toEqual({ label: "Pushover untested", state: "UNKNOWN" });
    expect(deriveMonitorPagingReadiness(notifications({
      state: "DEGRADED",
      push: { configured: true, lastSuccessAt: null, lastFailureAt: "2026-07-15T01:36:16.265Z" }
    }))).toEqual({ label: "Pushover failed", state: "DEGRADED" });
  });

  it("keeps backend delivery degradation visible even if Pushover fields look ready", () => {
    expect(deriveMonitorPagingReadiness(notifications({
      state: "DEGRADED",
      push: { configured: true, lastSuccessAt: "2026-07-15T01:35:16.265Z", lastFailureAt: null }
    }))).toEqual({ label: "Phone delivery failed", state: "DEGRADED" });
  });

  it("warns when Pushover is not configured", () => {
    expect(deriveMonitorPagingReadiness(notifications({ state: "NOT_APPLICABLE" }))).toEqual({
      label: "Phone alerts off",
      state: "DEGRADED"
    });
  });
});

function notifications({
  state,
  push = { configured: false, lastSuccessAt: null, lastFailureAt: null }
}: {
  state: Notifications["state"];
  push?: Notifications["pushover"];
}): Notifications {
  return { state, pushover: push };
}
