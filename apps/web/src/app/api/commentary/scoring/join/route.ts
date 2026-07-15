import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isCommentaryRequest } from "@/lib/commentaryAuth";
import {
  CommunityWitnessError,
  communitySessionCookie,
  communitySessionCookieOptions,
  createTrustedCommunityAssignment,
  releaseCommunitySession
} from "@/lib/communityWitness";
import { getActiveEvent, getCourtByNumber } from "@/lib/eventConfig";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";

export const runtime = "nodejs";

const schema = z.object({
  courtNumber: z.number().int().min(1).max(64),
  displayName: z.string().trim().min(1).max(80)
}).strict();

export async function POST(req: NextRequest) {
  if (!(await isCommentaryRequest(req))) {
    return NextResponse.json({ error: "Commentary sign-in is required." }, { status: 401 });
  }
  if (!checkRateLimit(`commentary-score-join:${requestIpHash(req)}`, 12, 10 * 60_000)) {
    return NextResponse.json({ error: "Too many scoring joins. Try again in a few minutes." }, { status: 429 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Choose a valid court and display name." }, { status: 400 });

  try {
    const event = await getActiveEvent();
    if (!event) return NextResponse.json({ error: "There is no active event." }, { status: 404 });
    const court = await getCourtByNumber(event.id, parsed.data.courtNumber);
    if (!court || !court.current_match_id) {
      return NextResponse.json({ error: "This court does not have an active match." }, { status: 409 });
    }
    if (court.scoring_open === false || court.frozen === true) {
      return NextResponse.json({ error: "Community scoring is closed for this court." }, { status: 409 });
    }

    const existingToken = req.cookies.get(communitySessionCookie)?.value;
    if (existingToken) {
      try {
        await releaseCommunitySession({ sessionToken: existingToken, clientActionId: crypto.randomUUID() });
      } catch (error) {
        if (!(error instanceof CommunityWitnessError) || ![404, 409].includes(error.status)) throw error;
      }
    }

    const created = await createTrustedCommunityAssignment({
      eventId: event.id,
      courtId: court.id,
      matchId: court.current_match_id,
      displayName: parsed.data.displayName,
      role: "DESIGNATED_SCORER",
      trustTier: "VERIFIED_COURTSIDE",
      actorLabel: "Commentary portal"
    });
    const response = NextResponse.json({
      ok: true,
      assignment: created.response.assignment,
      match: created.response.match
    });
    response.cookies.set(communitySessionCookie, created.sessionToken, communitySessionCookieOptions);
    return response;
  } catch (error) {
    const status = error instanceof CommunityWitnessError ? error.status : 500;
    const message = status === 409
      ? "This court is already controlled by a higher-priority score source or designated scorer."
      : status === 400
        ? "This scoring assignment is no longer valid for the current match."
        : "Scoring is not ready yet. Please try again in a moment.";
    return NextResponse.json({ error: message }, { status });
  }
}
