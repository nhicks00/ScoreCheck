import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashToken, requestIpHash } from "@/lib/security";
import { communityToken } from "@/lib/communityHttp";
import { CommunityWitnessError } from "@/lib/communityWitness";
import {
  claimCommunityMediaSessionClose,
  finishCommunityMediaCleanup
} from "@/lib/communityMedia";
import {
  communityMediaUpstreamConfig,
  releaseUpstreamWhepResource,
  validateCommunityRequestOrigin
} from "@/lib/mediaBroker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  if (!validateCommunityRequestOrigin(req.url, req.headers.get("origin"))) {
    return NextResponse.json({ error: "Community video request was not same-origin." }, { status: 403 });
  }
  const token = communityToken(req);
  if (!token) return new NextResponse(null, { status: 204 });
  if (!checkRateLimit(`community-media-close:${hashToken(token)}`, 120, 60_000)
    || !checkRateLimit(`community-media-close-ip:${requestIpHash(req)}`, 5_000, 60_000)) {
    return NextResponse.json({ error: "Too many community video cleanup requests." }, { status: 429 });
  }
  const parsed = z.string().uuid().safeParse((await params).sessionId);
  if (!parsed.success) return NextResponse.json({ error: "Invalid community video resource." }, { status: 400 });

  const claimedBy = `browser:${crypto.randomUUID()}`;
  try {
    const resource = await claimCommunityMediaSessionClose({
      sessionToken: token,
      mediaSessionId: parsed.data,
      claimedBy
    });
    if (!resource) return new NextResponse(null, { status: 204 });

    try {
      await releaseUpstreamWhepResource({
        // Closing an existing resource must remain possible while admission
        // capacity is intentionally zeroed during an incident.
        config: communityMediaUpstreamConfig(),
        upstreamResourceUrl: resource.upstreamResourceUrl,
        upstreamAffinityCookie: resource.upstreamAffinityCookie
      });
      await finishCommunityMediaCleanup({
        mediaSessionId: resource.id,
        claimedBy,
        cleanupClaimToken: resource.cleanupClaimToken,
        succeeded: true
      });
      return new NextResponse(null, { status: 204 });
    } catch (error) {
      await finishCommunityMediaCleanup({
        mediaSessionId: resource.id,
        claimedBy,
        cleanupClaimToken: resource.cleanupClaimToken,
        succeeded: false,
        error: error instanceof Error ? error.message : "browser cleanup failed"
      }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof CommunityWitnessError && [401, 403, 404, 410].includes(error.status)) {
      return new NextResponse(null, { status: 204 });
    }
    console.error("Community media cleanup failed", {
      code: error instanceof CommunityWitnessError ? error.code : "UNEXPECTED"
    });
    return NextResponse.json({ error: "Community video cleanup will retry." }, { status: 503 });
  }
}
