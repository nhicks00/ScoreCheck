import { describe, expect, it } from "vitest";
import type { IncidentSnapshot } from "./contracts.js";
import { operatorNotificationCopy } from "./operatorNotificationCopy.js";

describe("operator notification copy", () => {
  it("does not tell the operator to restart a camera for an analyzer failure", () => {
    const copy = operatorNotificationCopy(incident({ stage: "RAW_INGEST", issueCode: "CAMERA_CONTENT_ANALYZER_UNAVAILABLE", courtNumber: 4 }));
    expect(copy.problem).toBe("ScoreCheck cannot verify Camera 4's picture or sound.");
    expect(copy.action).toBe("Leave Camera 4 streaming and contact the technical operator. Do not restart the camera for this alert.");
  });

  it("turns a missing camera feed into a direct physical check", () => {
    const copy = operatorNotificationCopy(incident());
    expect(copy).toMatchObject({
      title: "Camera 4 needs attention",
      problem: "Camera 4 stopped sending usable video.",
      action: "Check that Camera 4 is powered on, connected to the internet, and still streaming.",
      recovery: "Camera 4 is sending video again. No action is needed."
    });
  });

  it("describes a broadcast-output failure without infrastructure jargon", () => {
    const copy = operatorNotificationCopy(incident({ stage: "EGRESS", issueCode: "EGRESS_WORKER_UNAVAILABLE" }));
    expect(copy.problem).toBe("Camera 4's broadcast output stopped.");
    expect(copy.action).toContain("restart its broadcast output in ScoreCheck");
    expect(JSON.stringify(copy)).not.toMatch(/egress|redis|worker|host capacity/i);
  });

  it("turns an over-capacity assignment into a plain stop-before-starting action", () => {
    const copy = operatorNotificationCopy(incident({
      stage: "EGRESS",
      issueCode: "EGRESS_EXPECTATION_EXCEEDS_CAPACITY",
      courtNumber: null
    }));
    expect(copy.problem).toBe("ScoreCheck does not have room to start another broadcast.");
    expect(copy.action).toBe("Do not start another broadcast until an unused output is stopped or more capacity is available.");
    expect(JSON.stringify(copy)).not.toMatch(/egress|worker|web request|compositor/i);
  });

  it("gives a commentator a concrete reconnect action", () => {
    const copy = operatorNotificationCopy(incident({ stage: "COMMENTARY", issueCode: "COMMENTARY_TRACK_MUTED" }));
    expect(copy.problem).toBe("Commentator sound is missing for Camera 4.");
    expect(copy.action).toContain("check mute and microphone settings");
  });

  it("routes an unknown issue to the first red dashboard item", () => {
    const copy = operatorNotificationCopy(incident({ stage: "CONTROL", issueCode: "UNRECOGNIZED_FAILURE", courtNumber: null }));
    expect(copy.title).toBe("ScoreCheck needs attention");
    expect(copy.action).toContain("technical operator");
    expect(JSON.stringify(copy)).not.toContain("UNRECOGNIZED_FAILURE");
  });

  it("keeps an external phone-channel configuration alert in plain English", () => {
    const copy = operatorNotificationCopy(incident({
      stage: "NOTIFICATION",
      issueCode: "EXTERNAL_DEAD_MAN_PHONE_CHANNEL_MISSING",
      courtNumber: null
    }));
    expect(copy).toMatchObject({
      problem: "Phone alerts may not be delivered.",
      action: "Keep the ScoreCheck monitor open until phone alerts are working again."
    });
    expect(JSON.stringify(copy)).not.toMatch(/dead.?man|channel|healthchecks/i);
  });

  it("labels an intentional camera-loss gate and tells the operator to wait", () => {
    const copy = operatorNotificationCopy(incident({
      summary: "[INTENTIONAL FAULT GATE] Required camera ingest is missing on court 4.",
      evidence: { expectationSource: "fault_gate" }
    }));
    expect(copy).toEqual({
      title: "TEST: Camera 4 feed stopped",
      problem: "This is the planned Camera 4 disconnect test.",
      action: "Leave Camera 4 off until ScoreCheck tells you to restart it.",
      recoveryTitle: "TEST: Camera 4 feed is back",
      recovery: "Camera 4 is sending video again. The planned test is complete."
    });
  });
});

function incident(patch: Partial<IncidentSnapshot> = {}): IncidentSnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    fingerprint: "event|camera|RAW_INGEST|4|REQUIRED_RAW_PATH_MISSING",
    eventId: "00000000-0000-4000-8000-000000000002",
    rootDependency: "mediamtx",
    status: "open",
    severity: "critical",
    stage: "RAW_INGEST",
    issueCode: "REQUIRED_RAW_PATH_MISSING",
    courtNumber: 4,
    host: "media-host",
    summary: "Technical summary that must not reach the phone.",
    firstAction: "Technical action that must not reach the phone.",
    evidence: {},
    openedAt: "2026-07-13T21:00:00.000Z",
    lastObservedAt: "2026-07-13T21:00:05.000Z",
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    ...patch
  };
}
