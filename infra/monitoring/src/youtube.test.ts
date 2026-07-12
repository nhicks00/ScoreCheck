import { describe, expect, it } from "vitest";
import { assessYouTubeCourt } from "./youtube.js";

describe("YouTube health assessment", () => {
  it("treats good ingestion as healthy", () => {
    const result = assessYouTubeCourt(1, "video-1", { id: "video-1", liveStreamingDetails: { actualStartTime: "now" } }, {
      broadcasts: [{ id: "video-1", status: { lifeCycleStatus: "live" }, contentDetails: { boundStreamId: "stream-1" } }],
      streams: [{ id: "stream-1", status: { streamStatus: "active", healthStatus: { status: "good", configurationIssues: [] } } }]
    }, "LIVE", 1_000);
    expect(result.state).toBe("HEALTHY");
    expect(result.healthStatus).toBe("good");
  });

  it("treats configuration issues as critical and absent provider data as unknown", () => {
    expect(assessYouTubeCourt(1, "video-1", { id: "video-1" }, {
      broadcasts: [{ id: "video-1", status: { lifeCycleStatus: "testing" }, contentDetails: { boundStreamId: "stream-1" } }],
      streams: [{ id: "stream-1", status: { healthStatus: { status: "bad", configurationIssues: [{ type: "gopSizeLong" }] } } }]
    }, "LIVE", 1_000)).toMatchObject({ state: "CRITICAL", configurationIssues: expect.arrayContaining(["gopSizeLong"]) });
    expect(assessYouTubeCourt(1, "video-1", null, null, "TESTING", 1_000).state).toBe("DEGRADED");
  });

  it("treats an inactive or unbound expected-live destination as critical", () => {
    expect(assessYouTubeCourt(1, "video-1", { id: "video-1" }, {
      broadcasts: [{ id: "video-1", status: { lifeCycleStatus: "ready" }, contentDetails: {} }],
      streams: []
    }, "LIVE", 1_000)).toMatchObject({
      state: "CRITICAL",
      configurationIssues: expect.arrayContaining(["bound-stream-missing", "broadcast-not-live", "stream-not-active"])
    });
  });

  it("treats warning-only YouTube health as degraded", () => {
    expect(assessYouTubeCourt(1, "video-1", { id: "video-1" }, {
      broadcasts: [{ id: "video-1", status: { lifeCycleStatus: "live" }, contentDetails: { boundStreamId: "stream-1" } }],
      streams: [{ id: "stream-1", status: { streamStatus: "active", healthStatus: { status: "ok", configurationIssues: [{ type: "videoBitrateLow" }] } } }]
    }, "LIVE", 1_000)).toMatchObject({ state: "DEGRADED", configurationIssues: ["videoBitrateLow"] });
  });
});
