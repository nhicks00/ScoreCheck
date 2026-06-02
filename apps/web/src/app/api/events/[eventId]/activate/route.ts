import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  const db = supabaseAdmin();

  await db.from("events").update({ status: "inactive" }).eq("status", "active");
  const { data: event, error } = await db
    .from("events")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", eventId)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.redirect(new URL(`/admin/events/${event.id}`, req.url), { status: 303 });
}
