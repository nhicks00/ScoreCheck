import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { courtMonitorStreamPath, courtPreviewStreamPath, courtStreamSources, dataSaverStreamAdmitted, videoConfigured } from "@/lib/video";

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
  const configured = await loadStreamConfiguration(courtNumber);
  if (parsed.data.quality === "data_saver" && !dataSaverStreamAdmitted(configured.broadcastExpectation)) {
    return NextResponse.json({
      error: "Data-saver video is unavailable unless this camera has an explicit non-live monitoring expectation."
    }, { status: 409 });
  }
  const previewStreamPath = parsed.data.quality === "data_saver"
    ? courtMonitorStreamPath(courtNumber)
    : courtPreviewStreamPath(courtNumber, configured.previewStreamPath);
  const sources = courtStreamSources(previewStreamPath);
  if (!sources.whepUrl && !sources.hlsUrl) {
    return NextResponse.json({ error: "Stream preview is not configured for this court." }, { status: 503 });
  }

  return NextResponse.json(sources, {
    headers: {
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer"
    }
  });
}

async function loadStreamConfiguration(courtNumber: number): Promise<{
  previewStreamPath: string | null;
  broadcastExpectation: string | null;
}> {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    return { previewStreamPath: null, broadcastExpectation: null };
  }

  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  // getActiveEvent falls back to historical rows; only a manually active event can block monitor transcoding.
  if (!event || event.is_active !== true) return { previewStreamPath: null, broadcastExpectation: "OFF" };

  const { data: court, error: courtError } = await db
    .from("courts")
    .select("id,preview_stream_path")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();
  if (courtError || !court) {
    return { previewStreamPath: null, broadcastExpectation: null };
  }

  const { data: expectation, error: expectationError } = await db
    .from("court_monitoring_expectations")
    .select("broadcast_expectation")
    .eq("event_id", event.id)
    .eq("court_id", court.id)
    .maybeSingle();

  return {
    previewStreamPath: court.preview_stream_path ?? null,
    broadcastExpectation: expectationError ? null : expectation?.broadcast_expectation ?? null
  };
}
