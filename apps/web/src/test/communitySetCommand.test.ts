import { afterEach, describe, expect, it, vi } from "vitest";
import { setCanonicalCurrentSet } from "../app/score/session/communityWitnessApi";
import type { PlaybackEvidenceSnapshot } from "../lib/communityPlaybackTiming";

describe("canonical current-set command client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits an explicit revisioned command instead of storing a viewer-local set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const playbackEvidence: PlaybackEvidenceSnapshot = {
      version: 1,
      sessionId: "whep-00000000-0000-4000-8000-000000000456",
      transport: "whep",
      connectionState: "connected",
      sampledAtMs: 1_000,
      baseRevision: 41,
      currentTimeSeconds: 10,
      readyState: 4,
      videoWidth: 1280,
      videoHeight: 720,
      paused: false,
      stalled: false,
      reconnecting: false,
      frame: {
        source: "video-frame-callback",
        sessionId: "whep-00000000-0000-4000-8000-000000000456",
        presentedFrames: 12,
        mediaTimeSeconds: 10,
        observedAtMs: 950
      },
      qualification: {
        liveActionEligible: true,
        blockedReason: null,
        frameAgeMs: 50,
        maxFrameAgeMs: 1_500
      },
      correlation: "uncorrelated_client_diagnostic"
    };

    await setCanonicalCurrentSet({
      clientActionId: "00000000-0000-4000-8000-000000000123",
      expectedRevision: 41,
      setNumber: 2,
      playbackEvidence
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/community/session/commands");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      clientActionId: "00000000-0000-4000-8000-000000000123",
      expectedRevision: 41,
      action: { type: "SET_CURRENT_SET", set: 2 },
      playbackEvidence
    });
  });
});
