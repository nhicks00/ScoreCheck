import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { fanScoringSettings } from "@/lib/eventConfig";
import { supabaseAdmin } from "@/lib/supabase";

const schema = z.object({
  action: z.enum(["promote", "revoke", "release"])
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { sessionId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid session action" }, { status: 400 });
  const db = supabaseAdmin();
  const { data: session, error } = await db.from("scorer_sessions").select("*, events:event_id(*)").eq("id", sessionId).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const now = new Date();

  if (parsed.data.action === "promote") {
    await db.from("scorer_sessions").update({
      status: "revoked",
      revoked_at: now.toISOString(),
      updated_at: now.toISOString()
    }).eq("court_id", session.court_id).eq("role", "active").in("status", ["active", "promoted"]);
    const event = Array.isArray(session.events) ? session.events[0] : session.events;
    const settings = fanScoringSettings(event);
    const { data, error: updateError } = await db.from("scorer_sessions").update({
      role: "active",
      status: "promoted",
      promoted_at: now.toISOString(),
      lease_expires_at: new Date(now.getTime() + settings.failoverSeconds * 1000).toISOString(),
      updated_at: now.toISOString()
    }).eq("id", sessionId).select("*").single();
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
    return NextResponse.json({ ok: true, session: data });
  }

  const status = parsed.data.action === "release" ? "released" : "revoked";
  const patch = parsed.data.action === "release"
    ? { status, released_at: now.toISOString(), updated_at: now.toISOString() }
    : { status, revoked_at: now.toISOString(), updated_at: now.toISOString() };
  const { data, error: updateError } = await db.from("scorer_sessions").update(patch).eq("id", sessionId).select("*").single();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  return NextResponse.json({ ok: true, session: data });
}
