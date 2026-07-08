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
 * Today that is exactly one field: the YouTube RTMP stream key (migration
 * 013, plan §3.4). Set/replace semantics — the full key is write-only; every
 * response carries at most maskStreamKey()'s last-4 preview. Deliberately
 * separate from the fan-scoring court PATCH (different route, different
 * concerns).
 */

const schema = z.object({
  // null or blank clears the key; anything else replaces it wholesale.
  youtubeStreamKey: z.string().trim().max(200).nullable()
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
  const youtubeStreamKey = parsed.data.youtubeStreamKey || null;

  const db = supabaseAdmin();
  const event = await getActiveEvent(db);
  if (!event) return NextResponse.json({ error: "No active event" }, { status: 404 });

  const { data, error } = await db
    .from("courts")
    .update({ youtube_stream_key: youtubeStreamKey, updated_at: new Date().toISOString() })
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

  return NextResponse.json({ ok: true, courtNumber, youtubeKeyMasked: maskStreamKey(youtubeStreamKey) });
}
