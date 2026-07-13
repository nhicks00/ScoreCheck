import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { courtMonitorStreamPath, courtPreviewStreamPath, courtStreamSources, videoConfigured } from "@/lib/video";

export const runtime = "nodejs";

const querySchema = z.object({
  courtNumber: z.coerce.number().int().min(1).max(99),
  quality: z.enum(["data_saver", "detail"]).optional()
});

export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const parsed = querySchema.safeParse({
    courtNumber: req.nextUrl.searchParams.get("courtNumber"),
    quality: req.nextUrl.searchParams.get("quality") ?? undefined
  });
  if (!parsed.success) return NextResponse.json({ error: "Valid court number is required." }, { status: 400 });

  if (!videoConfigured()) {
    return NextResponse.json({ error: "MediaMTX stream playback is not configured." }, { status: 503 });
  }

  const courtNumber = parsed.data.courtNumber;
  const previewStreamPath = parsed.data.quality === "data_saver"
    ? courtMonitorStreamPath(courtNumber)
    : courtPreviewStreamPath(courtNumber, await loadPreviewStreamPath(courtNumber));
  const sources = courtStreamSources(previewStreamPath);
  if (!sources.whepUrl && !sources.hlsUrl) {
    return NextResponse.json({ error: "Stream preview is not configured for this court." }, { status: 503 });
  }

  return NextResponse.json(sources);
}

async function loadPreviewStreamPath(courtNumber: number): Promise<string | null> {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return null;

  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  if (!event) return null;

  const { data: court } = await db
    .from("courts")
    .select("preview_stream_path")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return court?.preview_stream_path ?? null;
}
