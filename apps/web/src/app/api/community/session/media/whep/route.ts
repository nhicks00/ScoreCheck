import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashToken, requestIpHash } from "@/lib/security";
import { communityToken } from "@/lib/communityHttp";
import { CommunityWitnessError } from "@/lib/communityWitness";
import {
  activateCommunityMediaSession,
  claimCommunityMediaSessionClose,
  failCommunityMediaSession,
  finishCommunityMediaCleanup,
  reserveCommunityMediaSession
} from "@/lib/communityMedia";
import {
  CommunityMediaOpenedResourceError,
  communityMediaBrokerConfig,
  communityMediaUpstreamConfig,
  normalizeCommunityPreviewPath,
  openUpstreamWhep,
  readBoundedSdp,
  releaseUpstreamWhepResource,
  validateCommunityRequestOrigin
} from "@/lib/mediaBroker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!validateCommunityRequestOrigin(req.url, req.headers.get("origin"))) {
    return NextResponse.json({ error: "Community video request was not same-origin." }, { status: 403 });
  }
  const token = communityToken(req);
  if (!token) return NextResponse.json({ error: "Community session not found." }, { status: 401 });
  if (!checkRateLimit(`community-media:${hashToken(token)}`, 20, 60_000)
    || !checkRateLimit(`community-media-ip:${requestIpHash(req)}`, 5_000, 60_000)) {
    return NextResponse.json({ error: "Too many community video reconnects." }, { status: 429 });
  }

  let reservationId: string | null = null;
  let openedResource: { upstreamResourceUrl: string; upstreamAffinityCookie: string | null } | null = null;
  try {
    const config = communityMediaBrokerConfig();
    const offerSdp = await readBoundedSdp(req);
    const reservation = await reserveCommunityMediaSession(token);
    reservationId = reservation.id;

    if (reservation.replaced) {
      const claimedBy = `replace:${reservation.id}`;
      const claimed = await claimCommunityMediaSessionClose({
        sessionToken: token,
        mediaSessionId: reservation.replaced.id,
        claimedBy
      });
      if (!claimed) {
        throw new CommunityWitnessError("Previous community video is still closing", 409, "MEDIA_REPLACEMENT_BUSY");
      }
      try {
        await releaseUpstreamWhepResource({
          config,
          upstreamResourceUrl: claimed.upstreamResourceUrl,
          upstreamAffinityCookie: claimed.upstreamAffinityCookie
        });
        await finishCommunityMediaCleanup({
          mediaSessionId: claimed.id,
          claimedBy,
          cleanupClaimToken: claimed.cleanupClaimToken,
          succeeded: true
        });
      } catch (error) {
        await finishCommunityMediaCleanup({
          mediaSessionId: claimed.id,
          claimedBy,
          cleanupClaimToken: claimed.cleanupClaimToken,
          succeeded: false,
          error: error instanceof Error ? error.message : "replacement cleanup failed"
        }).catch(() => undefined);
        throw error;
      }
    }

    const previewPath = normalizeCommunityPreviewPath(reservation.courtNumber, reservation.previewStreamPath);
    const result = await openUpstreamWhep({ config, previewPath, offerSdp });
    openedResource = {
      upstreamResourceUrl: result.upstreamResourceUrl,
      upstreamAffinityCookie: result.upstreamAffinityCookie
    };
    await activateCommunityMediaSession({
      sessionToken: token,
      mediaSessionId: reservation.id,
      ...openedResource
    });

    return new NextResponse(result.answerSdp, {
      status: 201,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "application/sdp",
        location: `/api/community/session/media/whep/${reservation.id}`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff"
      }
    });
  } catch (error) {
    if (error instanceof CommunityMediaOpenedResourceError) {
      openedResource = error.openedResource;
    }
    if (openedResource) {
      try {
        await releaseUpstreamWhepResource({ config: communityMediaUpstreamConfig(), ...openedResource });
        openedResource = null;
      } catch {
        // Keep the validated opaque resource below so the durable cleanup
        // ledger can retry it. Never log or return the upstream URL.
      }
    }
    if (reservationId) {
      await failCommunityMediaSession({
        mediaSessionId: reservationId,
        error: error instanceof CommunityWitnessError ? error.code ?? "media setup rejected" : "media setup failed",
        upstreamResource: openedResource
      }).catch(() => undefined);
    }
    return mediaErrorResponse(error);
  }
}

function mediaErrorResponse(error: unknown): NextResponse {
  if (error instanceof CommunityWitnessError) {
    if (error.status >= 500) {
      console.error("Community media broker failed", { code: error.code, status: error.status });
    }
    if ([401, 403, 404, 410].includes(error.status)) {
      return NextResponse.json({ error: "This community scoring session is no longer active." }, { status: error.status });
    }
    if (error.status === 413 || error.status === 415) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error.status === 429 || error.code === "P0004") {
      return NextResponse.json({ error: "Live court video is at capacity. Remote authoritative scoring is paused until video reconnects." }, { status: 429 });
    }
    if (error.status === 409) {
      return NextResponse.json({ error: "Previous video is still closing. Retry in a moment." }, { status: 409 });
    }
    return NextResponse.json({ error: "Live court video is unavailable. Retry shortly." }, { status: error.status >= 500 ? 503 : error.status });
  }
  console.error("Community media broker failed", { code: "UNEXPECTED" });
  return NextResponse.json({ error: "Live court video is unavailable. Retry shortly." }, { status: 503 });
}
