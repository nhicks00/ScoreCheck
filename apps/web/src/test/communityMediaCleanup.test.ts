import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  finish: vi.fn(),
  prune: vi.fn(),
  config: vi.fn(),
  release: vi.fn()
}));

vi.mock("../lib/communityMedia", () => ({
  claimCommunityMediaCleanup: mocks.claim,
  finishCommunityMediaCleanup: mocks.finish,
  pruneCommunityMediaHistory: mocks.prune
}));
vi.mock("../lib/mediaBroker", () => ({
  communityMediaUpstreamConfig: mocks.config,
  releaseUpstreamWhepResource: mocks.release
}));

import { drainCommunityMediaSessions } from "../lib/communityMediaCleanup";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.mockReturnValue({
    baseUrl: new URL("https://edge.example.com/webrtc"),
    authorization: "Basic test"
  });
  mocks.release.mockResolvedValue(undefined);
  mocks.finish.mockResolvedValue(undefined);
  mocks.prune.mockResolvedValue({ playbackEvidenceDeleted: 2, mediaSessionsDeleted: 3 });
});

describe("community media cleanup worker", () => {
  it("keeps browser cleanup independent from admission capacity", () => {
    const route = readFileSync(
      join(process.cwd(), "src/app/api/community/session/media/whep/[sessionId]/route.ts"),
      "utf8"
    );
    expect(route).toContain("communityMediaUpstreamConfig()");
    expect(route).not.toContain("communityMediaBrokerConfig()");
  });

  it("passes each claim token through successful fenced completion", async () => {
    mocks.claim.mockResolvedValue([{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      upstreamResourceUrl: "https://edge.example.com/webrtc/court4_preview/whep/session-1",
      upstreamAffinityCookie: null,
      cleanupClaimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    }]);

    await expect(drainCommunityMediaSessions({ workerId: "worker:test" })).resolves.toEqual({
      claimed: 1,
      closed: 1,
      retrying: 0,
      configured: true,
      playbackEvidenceDeleted: 2,
      mediaSessionsDeleted: 3,
      pruningSucceeded: true
    });
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({
      cleanupClaimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      succeeded: true
    }));
  });

  it("uses the same fencing token when cleanup must be retried", async () => {
    mocks.claim.mockResolvedValue([{
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      upstreamResourceUrl: "https://edge.example.com/webrtc/court4_preview/whep/session-1",
      upstreamAffinityCookie: null,
      cleanupClaimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    }]);
    mocks.release.mockRejectedValue(new Error("edge unavailable"));

    await expect(drainCommunityMediaSessions({ workerId: "worker:test" })).resolves.toMatchObject({
      retrying: 1
    });
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({
      cleanupClaimToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      succeeded: false
    }));
  });

  it("runs history retention even when upstream cleanup is not configured", async () => {
    const { CommunityWitnessError } = await import("../lib/communityWitness");
    mocks.config.mockImplementation(() => {
      throw new CommunityWitnessError("not configured", 503, "MEDIA_NOT_CONFIGURED");
    });

    await expect(drainCommunityMediaSessions({ workerId: "worker:test" })).resolves.toEqual({
      claimed: 0,
      closed: 0,
      retrying: 0,
      configured: false,
      playbackEvidenceDeleted: 2,
      mediaSessionsDeleted: 3,
      pruningSucceeded: true
    });
    expect(mocks.prune).toHaveBeenCalledTimes(1);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("continues live resource cleanup when retention pruning fails", async () => {
    mocks.prune.mockRejectedValue(new Error("prune unavailable"));
    mocks.claim.mockResolvedValue([]);

    await expect(drainCommunityMediaSessions({ workerId: "worker:test" })).resolves.toEqual({
      claimed: 0,
      closed: 0,
      retrying: 0,
      configured: true,
      playbackEvidenceDeleted: 0,
      mediaSessionsDeleted: 0,
      pruningSucceeded: false
    });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });
});
