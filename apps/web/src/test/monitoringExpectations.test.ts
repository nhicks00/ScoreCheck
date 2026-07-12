import { describe, expect, it } from "vitest";
import { monitoringExpectationForBroadcast } from "../lib/monitoringExpectations";

describe("monitoring expectations", () => {
  it("arms a bounded event-day expectation when a court broadcast starts", () => {
    const now = new Date("2026-07-12T12:00:00.000Z");
    expect(monitoringExpectationForBroadcast("start", now)).toEqual({
      coverage_phase: "WARMUP",
      media_expectation: "REQUIRED",
      broadcast_expectation: "LIVE",
      commentary_expectation: "OPTIONAL",
      scoring_expectation: "SCHEDULED",
      override_created_by: "scorecheck-admin-production",
      override_created_at: "2026-07-12T12:00:00.000Z",
      override_reason: "Court broadcast started from the production console.",
      override_expires_at: "2026-07-13T06:00:00.000Z",
      updated_at: "2026-07-12T12:00:00.000Z"
    });
  });

  it("clears every expectation and override when a court broadcast stops", () => {
    expect(monitoringExpectationForBroadcast("stop", new Date("2026-07-12T12:00:00.000Z"))).toEqual({
      coverage_phase: "OFF",
      media_expectation: "OFF",
      broadcast_expectation: "OFF",
      commentary_expectation: "NONE",
      scoring_expectation: "NONE",
      override_created_by: null,
      override_created_at: null,
      override_reason: null,
      override_expires_at: null,
      updated_at: "2026-07-12T12:00:00.000Z"
    });
  });
});
