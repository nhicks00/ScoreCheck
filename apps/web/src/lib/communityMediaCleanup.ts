import {
  claimCommunityMediaCleanup,
  finishCommunityMediaCleanup,
  pruneCommunityMediaHistory
} from "./communityMedia";
import { CommunityWitnessError } from "./communityWitness";
import {
  communityMediaUpstreamConfig,
  releaseUpstreamWhepResource
} from "./mediaBroker";

export type CommunityMediaCleanupSummary = {
  claimed: number;
  closed: number;
  retrying: number;
  configured: boolean;
  playbackEvidenceDeleted: number;
  mediaSessionsDeleted: number;
  pruningSucceeded: boolean;
};

const CLEANUP_CONCURRENCY = 5;

export async function drainCommunityMediaSessions(input: {
  workerId: string;
  limit?: number;
}): Promise<CommunityMediaCleanupSummary> {
  let playbackEvidenceDeleted = 0;
  let mediaSessionsDeleted = 0;
  let pruningSucceeded = true;
  try {
    const pruned = await pruneCommunityMediaHistory();
    playbackEvidenceDeleted = pruned.playbackEvidenceDeleted;
    mediaSessionsDeleted = pruned.mediaSessionsDeleted;
  } catch {
    // History retention is deliberately independent from live resource
    // cleanup. Report its failure without stranding WHEP resources.
    pruningSucceeded = false;
  }

  const retention = { playbackEvidenceDeleted, mediaSessionsDeleted, pruningSucceeded };
  let config;
  try {
    // Cleanup depends only on upstream credentials. Admission capacity may be
    // deliberately set to zero during an incident without stranding resources
    // that were already opened.
    config = communityMediaUpstreamConfig();
  } catch (error) {
    if (error instanceof CommunityWitnessError && error.code === "MEDIA_NOT_CONFIGURED") {
      return { claimed: 0, closed: 0, retrying: 0, configured: false, ...retention };
    }
    throw error;
  }

  const resources = await claimCommunityMediaCleanup({ workerId: input.workerId, limit: input.limit });
  let closed = 0;
  let retrying = 0;
  for (let offset = 0; offset < resources.length; offset += CLEANUP_CONCURRENCY) {
    const outcomes = await Promise.all(resources.slice(offset, offset + CLEANUP_CONCURRENCY).map(async (resource) => {
      try {
        await releaseUpstreamWhepResource({
          config,
          upstreamResourceUrl: resource.upstreamResourceUrl,
          upstreamAffinityCookie: resource.upstreamAffinityCookie
        });
        await finishCommunityMediaCleanup({
          mediaSessionId: resource.id,
          claimedBy: input.workerId,
          cleanupClaimToken: resource.cleanupClaimToken,
          succeeded: true
        });
        return "closed" as const;
      } catch (error) {
        await finishCommunityMediaCleanup({
          mediaSessionId: resource.id,
          claimedBy: input.workerId,
          cleanupClaimToken: resource.cleanupClaimToken,
          succeeded: false,
          error: error instanceof Error ? error.message : "cleanup failed"
        }).catch(() => undefined);
        return "retrying" as const;
      }
    }));
    closed += outcomes.filter((outcome) => outcome === "closed").length;
    retrying += outcomes.filter((outcome) => outcome === "retrying").length;
  }
  return { claimed: resources.length, closed, retrying, configured: true, ...retention };
}
