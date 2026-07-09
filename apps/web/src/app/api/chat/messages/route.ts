import { NextRequest, NextResponse } from "next/server";
import { isChatRequest } from "@/lib/chatAuth";
import { getActiveEvent } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";
import { chatMessageRowToDto, type ChatMessageDbRow } from "@/lib/chatFeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * Recent chat messages for the active event. Backs the /chat client's polling
 * backbone (and realtime backfill): pass `sinceMs` for an incremental fetch of
 * anything inserted after a cursor, or omit it for the latest window. Guarded
 * by the standalone chat passcode cookie — never the admin cookie.
 */
export async function GET(req: NextRequest) {
  if (!(await isChatRequest(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = clampLimit(url.searchParams.get("limit"));
  const sinceMs = Number(url.searchParams.get("sinceMs"));
  const hasSince = Number.isFinite(sinceMs) && sinceMs > 0;

  const db = supabaseAdmin();
  const eventIdParam = url.searchParams.get("eventId")?.trim();
  const eventId = eventIdParam || (await getActiveEvent(db))?.id || null;
  if (!eventId) return NextResponse.json({ eventId: null, messages: [], cursorMs: null });

  let query = db
    .from("chat_messages")
    .select("id,youtube_message_id,court_number,court_label,author_name,is_moderator,is_owner,message_text,published_at,created_at")
    .eq("event_id", eventId);

  // Incremental: everything after the cursor, oldest first. Initial: the latest
  // window newest-first, reversed below so the client always appends ascending.
  query = hasSince
    ? query.gt("created_at", new Date(sinceMs).toISOString()).order("created_at", { ascending: true }).limit(limit)
    : query.order("created_at", { ascending: false }).limit(limit);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data as ChatMessageDbRow[] | null) ?? [];
  const ordered = hasSince ? rows : [...rows].reverse();
  const messages = ordered.map(chatMessageRowToDto);
  const cursorMs = messages.length
    ? Math.max(...messages.map((m) => Date.parse(m.createdAt)).filter(Number.isFinite))
    : hasSince
      ? sinceMs
      : null;

  return NextResponse.json({ eventId, messages, cursorMs });
}

function clampLimit(raw: string | null): number {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, value);
}
