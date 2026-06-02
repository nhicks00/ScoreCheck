import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { eventId } = await params;
  const { data, error } = await supabaseAdmin()
    .from("matches")
    .select("*")
    .eq("event_id", eventId)
    .order("scheduled_date", { ascending: true, nullsFirst: false })
    .order("scheduled_time", { ascending: true, nullsFirst: false })
    .order("match_number", { ascending: true, nullsFirst: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ matches: data });
}
