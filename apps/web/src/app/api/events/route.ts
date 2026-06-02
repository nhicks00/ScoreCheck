import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { readFormOrJson } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const { data, error } = await supabaseAdmin()
    .from("events")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ events: data });
}

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin(req);
  if (unauthorized) return unauthorized;
  const body = await readFormOrJson(req);
  const db = supabaseAdmin();
  await db.from("events").update({ status: "inactive" }).eq("status", "active");
  const { data: event, error } = await db
    .from("events")
    .insert({
      name: body.name || "Untitled Event",
      event_date: body.eventDate || null,
      venue: body.venue || null,
      status: "active"
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const courts = Array.from({ length: 8 }, (_, index) => ({
    event_id: event.id,
    court_number: index + 1,
    display_name: `Court ${index + 1}`,
    camera_name: `Camera ${index + 1}`,
    status: "idle"
  }));
  const { error: courtError } = await db.from("courts").insert(courts);
  if (courtError) return NextResponse.json({ error: courtError.message }, { status: 500 });

  return NextResponse.redirect(new URL(`/admin/events/${event.id}`, req.url), { status: 303 });
}
