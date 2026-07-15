import { describe, expect, it } from "vitest";
import {
  AUTHORITATIVE_FRAME_MAX_AGE_MS,
  brokeredScoringSessionId,
  buildPlaybackEvidence,
  initialPlaybackEvidenceState,
  playbackModeAllowsHls,
  type PlaybackEvidenceState
} from "../lib/communityPlaybackTiming";

describe("community playback timing evidence", () => {
  it("qualifies only a fresh rendered frame from the active connected WHEP session", () => {
    const state = connectedState();
    const evidence = buildPlaybackEvidence(state, {
      sampledAtMs: 10_500,
      baseRevision: 17,
      currentTimeSeconds: 184.25,
      readyState: 4,
      videoWidth: 1920,
      videoHeight: 1080,
      paused: false
    });

    expect(evidence).toMatchObject({
      sessionId: "whep-00000000-0000-4000-8000-000000000001",
      transport: "whep",
      connectionState: "connected",
      sampledAtMs: 10_500,
      baseRevision: 17,
      currentTimeSeconds: 184.25,
      qualification: {
        liveActionEligible: true,
        blockedReason: null,
        frameAgeMs: 500,
        maxFrameAgeMs: AUTHORITATIVE_FRAME_MAX_AGE_MS
      },
      correlation: "uncorrelated_client_diagnostic"
    });
  });

  it("fails closed for HLS even when it is playing a fresh frame", () => {
    const evidence = buildPlaybackEvidence({ ...connectedState(), transport: "hls" }, readyCapture());
    expect(evidence.qualification).toMatchObject({
      liveActionEligible: false,
      blockedReason: "transport_not_whep"
    });
  });

  it("fails closed while reconnecting, paused, stalled, or missing render evidence", () => {
    expect(reason({ reconnecting: true })).toBe("reconnecting");
    expect(reason({ paused: true })).toBe("playback_paused");
    expect(reason({ stalled: true })).toBe("playback_stalled");
    expect(reason({ frame: null })).toBe("rendered_frame_missing");
  });

  it("accepts only an opaque same-origin broker resource as scoring identity", () => {
    expect(brokeredScoringSessionId(
      "/api/community/session/media/whep/00000000-0000-4000-8000-000000000001",
      "https://scorecheck.example/score/session"
    )).toBe("whep-00000000-0000-4000-8000-000000000001");
    expect(brokeredScoringSessionId(
      "https://edge.example/court1_preview/whep/resource",
      "https://scorecheck.example/score/session"
    )).toBeNull();
    expect(brokeredScoringSessionId(
      "/api/community/session/media/whep/not-a-uuid",
      "https://scorecheck.example/score/session"
    )).toBeNull();
  });

  it("rejects stale frames and frames from the prior WHEP session", () => {
    const stale = buildPlaybackEvidence(connectedState(), {
      ...readyCapture(),
      sampledAtMs: 10_000 + AUTHORITATIVE_FRAME_MAX_AGE_MS + 1
    });
    expect(stale.qualification.blockedReason).toBe("rendered_frame_stale");

    const mismatch = buildPlaybackEvidence({
      ...connectedState(),
      sessionId: "whep-00000000-0000-4000-8000-000000000002"
    }, readyCapture());
    expect(mismatch.qualification.blockedReason).toBe("rendered_frame_session_mismatch");
  });

  it("requires decoded media dimensions and keeps invalid revisions out of evidence", () => {
    const evidence = buildPlaybackEvidence(connectedState(), {
      ...readyCapture(),
      baseRevision: -1,
      videoWidth: 0
    });
    expect(evidence.baseRevision).toBeNull();
    expect(evidence.qualification.blockedReason).toBe("media_not_ready");
  });

  it("permits HLS only for non-authoritative preview mode", () => {
    expect(playbackModeAllowsHls("preview")).toBe(true);
    expect(playbackModeAllowsHls("program")).toBe(false);
    expect(playbackModeAllowsHls("scoring")).toBe(false);
  });

  it("starts in a blocked state", () => {
    const evidence = buildPlaybackEvidence(initialPlaybackEvidenceState(), readyCapture());
    expect(evidence.qualification).toMatchObject({
      liveActionEligible: false,
      blockedReason: "transport_not_whep"
    });
  });
});

function connectedState(overrides: Partial<PlaybackEvidenceState> = {}): PlaybackEvidenceState {
  return {
    transport: "whep",
    sessionId: "whep-00000000-0000-4000-8000-000000000001",
    connectionState: "connected",
    paused: false,
    stalled: false,
    reconnecting: false,
    frame: {
      source: "video-frame-callback",
      sessionId: "whep-00000000-0000-4000-8000-000000000001",
      presentedFrames: 300,
      mediaTimeSeconds: 184.2,
      observedAtMs: 10_000
    },
    ...overrides
  };
}

function readyCapture() {
  return {
    sampledAtMs: 10_500,
    currentTimeSeconds: 184.25,
    readyState: 4,
    videoWidth: 1920,
    videoHeight: 1080,
    paused: false
  };
}

function reason(overrides: Partial<PlaybackEvidenceState>) {
  return buildPlaybackEvidence(connectedState(overrides), readyCapture()).qualification.blockedReason;
}
