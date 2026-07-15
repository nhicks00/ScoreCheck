import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isCommentaryRequest } from "@/lib/commentaryAuth";
import {
  claimTrustedCommunityDesignatedAssignment,
  CommunityWitnessError,
  communitySessionCookie,
  communitySessionCookieOptions,
  createTrustedCommunityAssignment,
  getCommunitySession,
  releaseCommunitySession
} from "@/lib/communityWitness";
import { getActiveEvent, getCourtByNumber } from "@/lib/eventConfig";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIpHash } from "@/lib/security";

export const runtime = "nodejs";

const requestBase = {
  courtNumber: z.number().int().min(1).max(64),
  displayName: z.string().trim().min(1).max(80)
} as const;

const schema = z.discriminatedUnion("mode", [
  z.object({ ...requestBase, mode: z.literal("view") }).strict(),
  z.object({
    ...requestBase,
    mode: z.literal("score"),
    clientActionId: z.string().uuid()
  }).strict()
]);

export async function POST(req: NextRequest) {
  if (!(await isCommentaryRequest(req))) {
    return NextResponse.json({ error: "Commentary sign-in is required." }, { status: 401 });
  }
  if (!checkRateLimit(`commentary-session-join:${requestIpHash(req)}`, 12, 10 * 60_000)) {
    return NextResponse.json({ error: "Too many court joins. Try again in a few minutes." }, { status: 429 });
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
    if (parsed.data.mode === "score" && (court.scoring_open === false || court.frozen === true)) {
      return NextResponse.json({ error: "Community scoring is closed for this court." }, { status: 409 });
    }

    const existingToken = req.cookies.get(communitySessionCookie)?.value;
    let joined: {
      sessionToken: string;
      response: Awaited<ReturnType<typeof getCommunitySession>>;
    } | null = null;
    if (parsed.data.mode === "score") {
      joined = existingToken
        ? await claimTrustedCommunityDesignatedAssignment({
            eventId: event.id,
            courtId: court.id,
            matchId: court.current_match_id,
            sessionToken: existingToken,
            displayName: parsed.data.displayName,
            actionId: parsed.data.clientActionId,
            actorLabel: "Commentary scorer"
          })
        : null;
    } else {
      if (existingToken) {
        try {
          const existing = await getCommunitySession(existingToken);
          if (existing.assignment.status === "ACTIVE"
            && existing.assignment.eventId === event.id
            && existing.assignment.courtId === court.id
            && existing.assignment.matchId === court.current_match_id) {
            joined = { sessionToken: existingToken, response: existing };
          }
        } catch (error) {
          // Replace only a confirmed absent/terminal session. An ambiguous
          // backend failure must not silently release a live designated seat.
          if (!(error instanceof CommunityWitnessError)
            || ![403, 404, 410].includes(error.status)) throw error;
        }
      }
      joined ??= await createTrustedCommunityAssignment({
        eventId: event.id,
        courtId: court.id,
        matchId: court.current_match_id,
        displayName: parsed.data.displayName,
        role: "OBSERVER",
        trustTier: "REMOTE",
        actorLabel: "Commentary viewer"
      });
    }

    if (!joined) {
      return NextResponse.json({
        error: "Open the live court view before taking the scorer seat."
      }, { status: 409 });
    }

    // Viewer navigation reuses a live same-match cookie and replaces only a
    // confirmed different/terminal scope. Scorer claims promote in place so
    // a lost response remains recoverable with the existing HttpOnly token and
    // any active brokered media session stays attached to the same assignment.
    if (parsed.data.mode === "view" && existingToken && existingToken !== joined.sessionToken) {
      try {
        await releaseCommunitySession({ sessionToken: existingToken, clientActionId: crypto.randomUUID() });
      } catch (error) {
        console.warn("Could not release replaced commentary community session", {
          status: error instanceof CommunityWitnessError ? error.status : 500
        });
      }
    }

    const response = NextResponse.json({
      ok: true,
      assignment: joined.response.assignment,
      match: joined.response.match
    });
    if (parsed.data.mode === "view") {
      response.cookies.set(communitySessionCookie, joined.sessionToken, communitySessionCookieOptions);
    }
    return response;
  } catch (error) {
    const status = error instanceof CommunityWitnessError ? error.status : 500;
    const scoringMode = parsed.data.mode === "score";
    const message = status === 409 && scoringMode
      ? "The scorer seat is already held or a higher-priority score source controls this court. Your court view is still available."
      : status === 409
        ? "The live court view is at capacity right now. Please try again shortly."
      : status === 400
        ? "This court session is no longer valid for the current match."
        : scoringMode
          ? "The scorer seat is not ready yet. Your court view is still available."
          : "The live court view is not ready yet. Please try again in a moment.";
    return NextResponse.json({ error: message }, { status });
  }
}
