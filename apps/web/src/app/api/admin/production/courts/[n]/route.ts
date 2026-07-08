import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getActiveEvent } from "@/lib/eventConfig";
import { isValidCourtNumber, maskStreamKey } from "@/lib/opsConsole";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Production-console court settings for stream/court :n of the ACTIVE event.
 * Two fields today: the YouTube RTMP stream key (migration 013, plan §3.4)
 * and the public YouTube video id (migration 003) that fan surfaces turn into
 * "Watch live" links. Set/replace semantics — the full key is write-only;
 * every response carries at most maskStreamKey()'s last-4 preview. Video ids
 * are public, so they round-trip in the clear. Deliberately separate from the
 * fan-scoring court PATCH (different route, different concerns).
 */

const schema = z.object({
  // null or blank clears a field; anything else replaces it wholesale.
  // Both optional — a PATCH updates only the fields it names.
  youtubeStreamKey: z.string().trim().max(200).nullable().optional(),
  youtubeVideoId: z.string().trim().max(100).nullable().optional()
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ n: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;

  const { n } = await params;
  const courtNumber = Number(n);
  if (!isValidCourtNumber(courtNumber)) {
    return NextResponse.json({ error: "Court number must be an integer 1-99" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid court update" }, { status: 400 });

  const updates: Record<string, string | null> = {};
  const result: Record<string, unknown> = { ok: true, courtNumber };
  if (parsed.data.youtubeStreamKey !== undefined) {
    const youtubeStreamKey = parsed.data.youtubeStreamKey || null;
    updates.youtube_stream_key = youtubeStreamKey;
    result.youtubeKeyMasked = maskStreamKey(youtubeStreamKey);
  }
  if (parsed.data.youtubeVideoId !== undefined) {
    const youtubeVideoId = parsed.data.youtubeVideoId || null;
    updates.youtube_video_id = youtubeVideoId;
    result.youtubeVideoId = youtubeVideoId;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Invalid court update" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  if (!event) return NextResponse.json({ error: "No active event" }, { status: 404 });

  const { data, error } = await db
    .from("courts")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("event_id", event.id)
    .eq("court_number", courtNumber)
    .select("id")
    .maybeSingle();
  if (error) {
    if (error.code === "42703") {
      return NextResponse.json(
        { error: "courts.youtube_stream_key does not exist yet — apply supabase/migrations/013_youtube_stream_keys.sql" },
        { status: 500 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: `No court ${courtNumber} in the active event` }, { status: 404 });

  return NextResponse.json(result);
}
