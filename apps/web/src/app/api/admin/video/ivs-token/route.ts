import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { courtIvsEnv, getEnv, requestOrigin } from "@/lib/env";
import { signedIvsPlaybackUrl } from "@/lib/ivs";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

const querySchema = z.object({
  courtNumber: z.coerce.number().int().min(1).max(99)
});

export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const parsed = querySchema.safeParse({
    courtNumber: req.nextUrl.searchParams.get("courtNumber")
  });
  if (!parsed.success) return NextResponse.json({ error: "Valid court number is required." }, { status: 400 });

  const env = getEnv();
  if (!env.ivsPlaybackPrivateKey) {
    return NextResponse.json({ error: "IVS playback signing is not configured." }, { status: 503 });
  }

  const courtNumber = parsed.data.courtNumber;
  const metadata = await loadIvsMetadata(courtNumber);
  if (!metadata.channelArn || !metadata.playbackUrl) {
    return NextResponse.json({ error: "IVS preview is not configured for this court." }, { status: 503 });
  }

  const expiresInSeconds = 10 * 60;
  const signedUrl = signedIvsPlaybackUrl({
    playbackUrl: metadata.playbackUrl,
    channelArn: metadata.channelArn,
    origin: requestOrigin(req.headers.get("origin") ?? new URL(req.url).origin),
    viewerId: `admin-court-${courtNumber}`,
    expiresInSeconds
  });

  return NextResponse.json({
    playbackUrl: signedUrl,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString()
  });
}

async function loadIvsMetadata(courtNumber: number) {
  const fallback = courtIvsEnv(courtNumber);
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return fallback;

  const db = supabaseAdmin();
  const { data: event } = await db
    .from("events")
    .select("id")
    .eq("slug", env.defaultEventSlug)
    .maybeSingle();
  if (!event) return fallback;

  const { data: court } = await db
    .from("courts")
    .select("ivs_channel_arn,ivs_playback_url")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return {
    channelArn: court?.ivs_channel_arn || fallback.channelArn,
    playbackUrl: court?.ivs_playback_url || fallback.playbackUrl
  };
}
