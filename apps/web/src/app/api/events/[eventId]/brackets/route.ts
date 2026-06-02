import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { readFormOrJson } from "@/lib/http";
import { parseVblUrl } from "@/lib/vbl";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  const body = await readFormOrJson(req);
  const sourceUrl = body.sourceUrl?.trim();
  if (!sourceUrl) return NextResponse.json({ error: "sourceUrl is required" }, { status: 400 });
  const parsed = parseVblUrl(sourceUrl);
  const sourceType = parsed?.isBracket ? "bracket" : parsed?.isPool ? "pool" : "unknown";

  const { error } = await supabaseAdmin().from("bracket_sources").upsert({
    event_id: eventId,
    source_url: sourceUrl,
    source_type: sourceType,
    status: "pending",
    last_error: null
  }, { onConflict: "event_id,source_url" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.redirect(new URL(`/admin/events/${eventId}`, req.url), { status: 303 });
}
