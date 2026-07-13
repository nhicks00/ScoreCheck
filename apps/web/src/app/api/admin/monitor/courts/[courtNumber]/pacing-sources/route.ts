import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { getActiveEvent } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import {
  courtPreviewStreamPath,
  courtProgramStreamPath,
  courtStreamSources,
  videoConfigured
} from "@/lib/video";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z.object({
  courtNumber: z.coerce.number().int().min(1).max(8)
});

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ courtNumber: string }> }
) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const parsed = paramsSchema.safeParse(await context.params);
  if (!parsed.success) {
    return NextResponse.json({ error: "Court number must be between 1 and 8." }, { status: 400 });
  }
  if (!videoConfigured()) {
    return NextResponse.json({ error: "MediaMTX WHEP playback is not configured." }, { status: 503 });
  }

  const courtNumber = parsed.data.courtNumber;
  const configuredPaths = await loadConfiguredPaths(courtNumber);
  const previewPath = courtPreviewStreamPath(courtNumber, configuredPaths.preview);
  const programPath = courtProgramStreamPath(courtNumber, configuredPaths.program);
  const previewWhepUrl = courtStreamSources(previewPath).whepUrl;
  const programWhepUrl = courtStreamSources(programPath).whepUrl;
  if (!previewWhepUrl || !programWhepUrl) {
    return NextResponse.json({ error: "Both preview and program WHEP sources are required for comparison." }, { status: 503 });
  }

  return NextResponse.json({
    version: 1,
    courtNumber,
    preview: { path: previewPath, whepUrl: previewWhepUrl },
    program: { path: programPath, whepUrl: programWhepUrl }
  }, {
    headers: {
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer"
    }
  });
}

async function loadConfiguredPaths(courtNumber: number): Promise<{ preview: string | null; program: string | null }> {
  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return { preview: null, program: null };

  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  if (!event) return { preview: null, program: null };

  const { data: court } = await db
    .from("courts")
    .select("preview_stream_path,program_stream_path")
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .maybeSingle();

  return {
    preview: court?.preview_stream_path ?? null,
    program: court?.program_stream_path ?? null
  };
}
