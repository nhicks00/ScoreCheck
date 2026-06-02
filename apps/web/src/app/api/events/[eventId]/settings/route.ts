import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

const settingsSchema = z.object({
  overlayLayout: z.enum(["top-left", "bottom-left"])
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid event settings payload" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: event, error: loadError } = await db.from("events").select("settings").eq("id", eventId).single();
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });

  const current = event.settings && typeof event.settings === "object" && !Array.isArray(event.settings)
    ? event.settings as Record<string, unknown>
    : {};
  const settings = { ...current, overlayLayout: parsed.data.overlayLayout };
  const { data: updated, error } = await db
    .from("events")
    .update({ settings, updated_at: new Date().toISOString() })
    .eq("id", eventId)
    .select("id,settings")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, event: updated });
}
