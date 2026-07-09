import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { courtStreamPath, courtStreamSources, videoConfigured } from "@/lib/video";

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

  if (!videoConfigured()) {
    return NextResponse.json({ error: "MediaMTX stream playback is not configured." }, { status: 503 });
  }

  const courtNumber = parsed.data.courtNumber;
  const streamPath = courtStreamPath(courtNumber, await loadStreamPath(courtNumber));
  const sources = courtStreamSources(streamPath);
  if (!sources.whepUrl && !sources.hlsUrl) {
    return NextResponse.json({ error: "Stream preview is not configured for this court." }, { status: 503 });
  }

  return NextResponse.json(sources);
}

async function loadStreamPath(courtNumber: number): Promise<string | null> {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return null;

  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  if (!event) return null;

  const { data: court } = await db
    .from("courts")
    .select("stream_path")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return court?.stream_path ?? null;
}
