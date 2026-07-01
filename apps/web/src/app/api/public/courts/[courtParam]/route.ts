import { NextRequest, NextResponse } from "next/server";
import { publicCourtData } from "@/lib/scorerSessions";
import { supabaseAdmin } from "@/lib/supabase";

type Relation<T> = T | T[] | null | undefined;

export async function GET(req: NextRequest, { params }: { params: Promise<{ courtParam: string }> }) {
  try {
    const { courtParam } = await params;
    const eventSlug = req.nextUrl.searchParams.get("eventSlug") ?? undefined;
    const data = await publicCourtData(eventSlug, courtParam);
    if (!data) return NextResponse.json({ error: "Court not found" }, { status: 404 });
    const db = supabaseAdmin();
    const { data: court, error } = await db
      .from("courts")
      .select("*, matches:current_match_id(*), score_states(*)")
      .eq("id", data.court.id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const match = firstRelation(court?.matches);
    const score = firstRelation(court?.score_states);
    return NextResponse.json({
      event: data.event,
      court: data.court,
      match,
      score,
      scorerStatus: data.scorerStatus
    }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not load court" }, { status: 500 });
  }
}

function firstRelation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}
