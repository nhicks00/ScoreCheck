import { describe, expect, it } from "vitest";
import { deriveMonitorPagingReadiness } from "../lib/monitorPagingReadiness";
import type { MonitorSnapshot } from "../lib/monitoringTypes";

type Notifications = MonitorSnapshot["notifications"];

describe("monitor paging readiness", () => {
  it("does not present verified Pushover as complete paging when SMS is absent", () => {
    expect(deriveMonitorPagingReadiness(notifications({
      state: "HEALTHY",
      push: { configured: true, lastSuccessAt: "2026-07-15T01:35:16.265Z", lastFailureAt: null }
    }))).toEqual({ label: "Push ready · SMS off", state: "DEGRADED" });
  });

  it("reports both required providers as ready only after both succeed", () => {
    expect(deriveMonitorPagingReadiness(notifications({
      state: "HEALTHY",
      push: { configured: true, lastSuccessAt: "2026-07-15T01:35:16.265Z", lastFailureAt: null },
      sms: { configured: true, lastSuccessAt: "2026-07-15T01:36:16.265Z", lastFailureAt: null }
    }))).toEqual({ label: "Push + SMS ready", state: "HEALTHY" });
  });

  it("distinguishes an untested provider from a failed provider", () => {
    expect(deriveMonitorPagingReadiness(notifications({
      state: "UNKNOWN",
      push: { configured: true, lastSuccessAt: "2026-07-15T01:35:16.265Z", lastFailureAt: null },
      sms: { configured: true, lastSuccessAt: null, lastFailureAt: null }
    }))).toEqual({ label: "Push ready · SMS untested", state: "UNKNOWN" });

    expect(deriveMonitorPagingReadiness(notifications({
      state: "DEGRADED",
      push: { configured: true, lastSuccessAt: "2026-07-15T01:35:16.265Z", lastFailureAt: null },
      sms: { configured: true, lastSuccessAt: null, lastFailureAt: "2026-07-15T01:36:16.265Z" }
    }))).toEqual({ label: "Push ready · SMS failed", state: "DEGRADED" });
  });

  it("keeps backend delivery degradation visible even if provider fields look ready", () => {
    expect(deriveMonitorPagingReadiness(notifications({
      state: "DEGRADED",
      push: { configured: true, lastSuccessAt: "2026-07-15T01:35:16.265Z", lastFailureAt: null },
      sms: { configured: true, lastSuccessAt: "2026-07-15T01:36:16.265Z", lastFailureAt: null }
    }))).toEqual({ label: "Phone delivery failed", state: "DEGRADED" });
  });

  it("warns when no phone provider is configured", () => {
    expect(deriveMonitorPagingReadiness(notifications({ state: "NOT_APPLICABLE" }))).toEqual({
      label: "Phone alerts off",
      state: "DEGRADED"
    });
  });
});

function notifications({
  state,
  push = { configured: false, lastSuccessAt: null, lastFailureAt: null },
  sms = { configured: false, lastSuccessAt: null, lastFailureAt: null }
}: {
  state: Notifications["state"];
  push?: Notifications["pushover"];
  sms?: Notifications["twilioSms"];
}): Notifications {
  return { state, pushover: push, twilioSms: sms };
}
