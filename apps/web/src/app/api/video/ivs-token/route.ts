import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { courtIvsEnv, getEnv, requestOrigin } from "@/lib/env";
import { fanScoringSettings } from "@/lib/eventConfig";
import { signedIvsPlaybackUrl } from "@/lib/ivs";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashToken, requestIpHash } from "@/lib/security";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

const schema = z.object({
  sessionToken: z.string().min(16),
  courtNumber: z.coerce.number().int().min(1).max(8)
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Valid scorer session is required." }, { status: 400 });
  const ipHash = requestIpHash(req);
  if (!checkRateLimit(`ivs-token:${ipHash}`, 20, 10 * 60_000)) {
    return NextResponse.json({ error: "Too many video token requests." }, { status: 429 });
  }

  const env = getEnv();
  if (!env.ivsPlaybackPrivateKey) {
    return NextResponse.json({ error: "Preview video is not available yet." }, { status: 503 });
  }

  const db = supabaseAdmin();
  const { data: session, error } = await db
    .from("scorer_sessions")
    .select("*, events:event_id(*), courts:court_id(*)")
    .eq("session_token_hash", hashToken(parsed.data.sessionToken))
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!session || !["active", "backup"].includes(session.role) || !["active", "promoted"].includes(session.status)) {
    return NextResponse.json({ error: "Only active and backup scorekeepers can view preview video." }, { status: 403 });
  }
  const court = Array.isArray(session.courts) ? session.courts[0] : session.courts;
  const event = Array.isArray(session.events) ? session.events[0] : session.events;
  if (!court || court.court_number !== parsed.data.courtNumber) {
    return NextResponse.json({ error: "Scorer session does not match this court." }, { status: 403 });
  }
  const fallback = courtIvsEnv(parsed.data.courtNumber);
  const channelArn = court.ivs_channel_arn || fallback.channelArn;
  const playbackUrl = court.ivs_playback_url || fallback.playbackUrl;
  if (!channelArn || !playbackUrl) {
    return NextResponse.json({ error: "Preview video is not available yet." }, { status: 503 });
  }
  const settings = fanScoringSettings(event);
  const expiresInSeconds = settings.videoTokenSeconds;
  const signedUrl = signedIvsPlaybackUrl({
    playbackUrl,
    channelArn,
    origin: requestOrigin(new URL(req.url).origin),
    viewerId: session.id,
    expiresInSeconds
  });
  await db.from("scorer_session_events").insert({
    event_id: session.event_id,
    court_id: session.court_id,
    match_id: session.match_id,
    session_id: session.id,
    type: "video_token_issued",
    payload: { courtNumber: parsed.data.courtNumber, expiresInSeconds }
  });
  return NextResponse.json({
    playbackUrl: signedUrl,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString()
  });
}
