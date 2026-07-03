import { NextRequest, NextResponse } from "next/server";
import { buildOverlayState, overlayLayout } from "@/lib/overlay";
import { missingEnvKeys } from "@/lib/env";
import { coerceOverlayState, fallbackOverlayState } from "@/lib/overlayState";
import { scoreForCurrentMatch } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest, { params }: { params: Promise<{ courtNumber: string }> }) {
  const { courtNumber } = await params;
  if (missingEnvKeys().some((key) => key.startsWith("NEXT_PUBLIC_SUPABASE") || key === "SUPABASE_SERVICE_ROLE_KEY")) {
    return NextResponse.json(envFallbackOverlayState(Number(courtNumber)), { headers: { "cache-control": "no-store" } });
  }

  const eventId = req.nextUrl.searchParams.get("eventId");
  const db = supabaseAdmin();
  const courtNumberValue = Number(courtNumber);
  const { court, error } = await loadOverlayCourt(courtNumberValue, eventId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!court) return NextResponse.json({ error: "Court not found" }, { status: 404 });

  const cached = await db.from("overlay_states").select("payload").eq("court_id", court.id).maybeSingle();
  if (cached.data?.payload) {
    return NextResponse.json(withOverlayLayout(cached.data.payload, court), { headers: { "cache-control": "no-store" } });
  }

  const match = Array.isArray(court.matches) ? court.matches[0] : court.matches;
  const score = scoreForCurrentMatch(court.score_states, match?.id);
  return NextResponse.json(buildOverlayState({
    event: { id: court.event_id, settings: eventSettings(court) },
    court,
    match: match ?? null,
    score: score ?? null
  }), { headers: { "cache-control": "no-store" } });
}

async function loadOverlayCourt(courtNumber: number, eventId: string | null) {
  const db = supabaseAdmin();
  const select = "*, events!inner(id,status,settings), matches:current_match_id(*), score_states(*)";
  if (eventId) {
    const result = await db
      .from("courts")
      .select(select)
      .eq("court_number", courtNumber)
      .eq("event_id", eventId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { court: result.data, error: result.error };
  }

  const active = await db
    .from("courts")
    .select(select)
    .eq("court_number", courtNumber)
    .eq("events.status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active.data || active.error) return { court: active.data, error: active.error };

  const latest = await db
    .from("courts")
    .select(select)
    .eq("court_number", courtNumber)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { court: latest.data, error: latest.error };
}

function withOverlayLayout(payload: unknown, court: Record<string, unknown>) {
  return coerceOverlayState({
    ...(typeof payload === "object" && payload ? payload : {}),
    courtLabel: overlayCourtLabel(court),
    layout: overlayLayout(eventSettings(court))
  }, Number(court.court_number) || 1);
}

function overlayCourtLabel(court: Record<string, unknown>) {
  const vblLabel = stringValue(court.vbl_court_label);
  if (vblLabel) return vblLabel;

  const vblCourtNumber = stringValue(court.vbl_court_number);
  if (vblCourtNumber) return /^court\b/i.test(vblCourtNumber) ? vblCourtNumber : `Court ${vblCourtNumber}`;

  return stringValue(court.display_name) ?? `Court ${Number(court.court_number) || 1}`;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function eventSettings(court: Record<string, unknown>) {
  const event = Array.isArray(court.events) ? court.events[0] : court.events;
  if (!event || typeof event !== "object") return null;
  const settings = (event as { settings?: unknown }).settings;
  return settings && typeof settings === "object" && !Array.isArray(settings) ? settings as Record<string, unknown> : null;
}

function envFallbackOverlayState(courtNumber: number) {
  const fallback = fallbackOverlayState(courtNumber);
  return {
    ...fallback,
    health: {
      ...fallback.health,
      apiOnline: false,
      stale: true,
      message: "Supabase is not configured"
    }
  };
}
