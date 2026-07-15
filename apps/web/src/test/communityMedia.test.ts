import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));

vi.mock("../lib/supabase", () => ({
  supabaseAdmin: () => ({ rpc: rpcMock })
}));
vi.mock("../lib/security", () => ({ hashToken: (value: string) => `hash:${value}` }));
vi.mock("../lib/env", () => ({
  getEnv: () => ({
    communityMediaMaxPerCourt: 25,
    communityMediaMaxTotal: 100,
    communityMediaSessionSeconds: 120
  })
}));

import {
  claimCommunityMediaCleanup,
  claimCommunityMediaSessionClose,
  finishCommunityMediaCleanup,
  pruneCommunityMediaHistory
} from "../lib/communityMedia";

const mediaSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

beforeEach(() => {
  rpcMock.mockReset();
});

describe("community media cleanup fencing", () => {
  it("generates and returns a unique claim token for a browser cleanup claim", async () => {
    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => ({
      data: name === "community_claim_media_session_close" ? {
        id: mediaSessionId,
        upstreamResourceUrl: "https://edge.example.com/webrtc/court4_preview/whep/session-1",
        upstreamAffinityCookie: null,
        cleanupClaimToken: args.p_cleanup_claim_token
      } : null,
      error: null
    }));

    const resource = await claimCommunityMediaSessionClose({
      sessionToken: "session-token",
      mediaSessionId,
      claimedBy: "browser:test"
    });

    expect(resource?.cleanupClaimToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(rpcMock).toHaveBeenCalledWith("community_claim_media_session_close", expect.objectContaining({
      p_session_token_hash: "hash:session-token",
      p_cleanup_claim_token: resource?.cleanupClaimToken
    }));
  });

  it("uses one unique claim token for a worker batch and fences completion with the returned token", async () => {
    rpcMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "community_claim_media_cleanup") {
        return {
          data: [{
            id: mediaSessionId,
            upstreamResourceUrl: "https://edge.example.com/webrtc/court4_preview/whep/session-1",
            upstreamAffinityCookie: "SERVERID=edge-a",
            cleanupClaimToken: args.p_cleanup_claim_token
          }],
          error: null
        };
      }
      return { data: null, error: null };
    });

    const [resource] = await claimCommunityMediaCleanup({ workerId: "worker:test", limit: 5 });
    await finishCommunityMediaCleanup({
      mediaSessionId: resource.id,
      claimedBy: "worker:test",
      cleanupClaimToken: resource.cleanupClaimToken,
      succeeded: true
    });

    expect(rpcMock).toHaveBeenNthCalledWith(1, "community_claim_media_cleanup", expect.objectContaining({
      p_cleanup_claim_token: resource.cleanupClaimToken,
      p_limit: 5
    }));
    expect(rpcMock).toHaveBeenNthCalledWith(2, "community_finish_media_cleanup", expect.objectContaining({
      p_cleanup_claim_token: resource.cleanupClaimToken,
      p_succeeded: true
    }));
  });

  it("parses the bounded history-prune summary", async () => {
    rpcMock.mockResolvedValue({
      data: { playbackEvidenceDeleted: 12, mediaSessionsDeleted: 8 },
      error: null
    });

    await expect(pruneCommunityMediaHistory(250)).resolves.toEqual({
      playbackEvidenceDeleted: 12,
      mediaSessionsDeleted: 8
    });
    expect(rpcMock).toHaveBeenCalledWith("community_prune_media_history", { p_limit: 250 });
  });
});
