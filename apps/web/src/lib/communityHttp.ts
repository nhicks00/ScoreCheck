import { NextRequest, NextResponse } from "next/server";
import { publishCanonicalScoreOutbox } from "./scoreState";
import {
  CommunityWitnessError,
  communitySessionCookie,
  type CommunitySessionResponse
} from "./communityWitness";

export function communityToken(req: NextRequest): string | null {
  return req.cookies.get(communitySessionCookie)?.value ?? null;
}

export function communityApiError(error: unknown): NextResponse {
  if (error instanceof CommunityWitnessError) {
    const detail = { code: error.code, status: error.status, message: error.message, error };
    if (error.status >= 500) console.error("Community scoring RPC failed", detail);
    else console.warn("Community scoring request rejected", detail);
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    return NextResponse.json({
      error: communityPublicErrorMessage(error, status),
      code: status === 500 ? "INTERNAL" : error.code
    }, { status });
  }
  console.error("Community scoring request failed", error);
  return NextResponse.json({ error: "Community scoring is temporarily unavailable", code: "INTERNAL" }, { status: 500 });
}

function communityPublicErrorMessage(error: CommunityWitnessError, status: number): string {
  if (error.code === "P0003" || status === 410) return "This scoring session has ended.";
  if (error.code === "P0004" || status === 429) return "This court has reached its active contributor limit. Try again shortly.";
  if (error.code === "P0005") return "That point was not recorded because the live video evidence expired. Reconnect, confirm the current score, and enter the point again.";
  if (error.code === "28000" || status === 403) return "This invitation or scoring permission is invalid, expired, or no longer available.";
  if (status === 404) return "The event, court, or scoring session was not found.";
  if (status === 409) return "The score or court changed first. Refresh and try again.";
  if (status === 400) return "This scoring request is not valid.";
  return "Community scoring is temporarily unavailable";
}

export async function communityMutationResponse(result: CommunitySessionResponse): Promise<NextResponse> {
  if (!result.outboxId) {
    return NextResponse.json({ ...result, projectionStatus: "NOT_REQUIRED" });
  }
  try {
    await publishCanonicalScoreOutbox({ outboxId: result.outboxId });
    return NextResponse.json({ ...result, projectionStatus: "PUBLISHED" });
  } catch {
    // Canonical commit and receipt are durable. The outbox publisher has
    // already marked retryable failure, so acknowledge the contribution and
    // let the bounded drain repair broadcast projection.
    return NextResponse.json({ ...result, projectionStatus: "RETRYING" }, { status: 202 });
  }
}
