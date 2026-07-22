import { NextRequest, NextResponse } from "next/server";
import { buildOverlayState, overlayLayout } from "@/lib/overlay";
import { missingEnvKeys } from "@/lib/env";
import { coerceOverlayState, fallbackOverlayState } from "@/lib/overlayState";
import { ifNoneMatchContains, overlayEntityTag } from "@/lib/overlayHttp";
import { scoreForCurrentMatch } from "@/lib/scoreState";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest, { params }: { params: Promise<{ courtNumber: string }> }) {
  const { courtNumber } = await params;
  if (missingEnvKeys().some((key) => key.startsWith("NEXT_PUBLIC_SUPABASE") || key === "SUPABASE_SERVICE_ROLE_KEY")) {
    return overlayResponse(req, coerceOverlayState(envFallbackOverlayState(Number(courtNumber)), Number(courtNumber)));
  }

  const eventId = req.nextUrl.searchParams.get("eventId");
  const courtNumberValue = Number(courtNumber);
  const persisted = await loadPersistedOverlay(courtNumberValue, eventId);
  if (persisted.error) return NextResponse.json({ error: persisted.error.message }, { status: 500 });
  if (persisted.data?.payload) {
    return overlayResponse(req, coercePersistedOverlay(persisted.data, courtNumberValue));
  }

  // Only newly-created or partially-migrated courts should need this repair
  // path. Normal overlay polling reads the already-materialized payload rather
  // than rejoining courts, events, matches, and scores every five seconds.
  const { court, error } = await loadOverlayCourt(courtNumberValue, eventId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!court) {
    if (eventId) return NextResponse.json({ error: "Court not found" }, { status: 404 });
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const match = Array.isArray(court.matches) ? court.matches[0] : court.matches;
  const score = scoreForCurrentMatch(court.score_states, match?.id);
  return overlayResponse(req, withOverlayLayout(buildOverlayState({
    event: { id: court.event_id, settings: eventSettings(court) },
    court,
    match: match ?? null,
    score: score ?? null
  }), court));
}

function overlayResponse(req: NextRequest, state: ReturnType<typeof coerceOverlayState>) {
  const etag = overlayEntityTag(state);
  const headers = {
    "cache-control": "private, no-cache, must-revalidate",
    etag
  };
  if (ifNoneMatchContains(req.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(state, { headers });
}

async function loadPersistedOverlay(courtNumber: number, eventId: string | null) {
  const db = supabaseAdmin();
  const select = "payload,stale,updated_at,events!inner(status,settings),courts!inner(display_name,vbl_court_label,vbl_court_number)";
  if (eventId) {
    return db
      .from("overlay_states")
      .select(select)
      .eq("court_number", courtNumber)
      .eq("event_id", eventId)
      .limit(1)
      .maybeSingle();
  }

  return db
    .from("overlay_states")
    .select(select)
    .eq("court_number", courtNumber)
    .eq("events.status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
}

function coercePersistedOverlay(row: {
  payload: unknown;
  stale: boolean;
  updated_at: string | null;
  events?: unknown;
  courts?: unknown;
}, courtNumber: number) {
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  const health = payload.health && typeof payload.health === "object" && !Array.isArray(payload.health)
    ? payload.health as Record<string, unknown>
    : {};
  const event = firstRecord(row.events);
  const court = firstRecord(row.courts);
  const settings = event?.settings && typeof event.settings === "object" && !Array.isArray(event.settings)
    ? event.settings as Record<string, unknown>
    : null;
  return coerceOverlayState({
    ...payload,
    courtLabel: overlayCourtLabel({ ...court, court_number: courtNumber }),
    layout: overlayLayout(settings),
    health: {
      ...health,
      lastUpdateAt: row.updated_at ?? health.lastUpdateAt ?? null,
      stale: row.stale || health.stale === true
    }
  }, courtNumber);
}

function firstRecord(value: unknown): Record<string, unknown> {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : {};
}

async function loadOverlayCourt(courtNumber: number, eventId: string | null) {
  const db = supabaseAdmin();
  // Explicit match columns — never source_payload, the large VBL bracket JSONB
  // the scorebug never reads. These are exactly the fields buildOverlayState
  // consumes; pulling the blob here cost egress on ~8 overlays x every 2s.
  const matchColumns = "id,match_number,round_name,scheduled_time,team_a,team_a_seed,team_b,team_b_seed,team_a_players,team_b_players,format";
  const select = `*, events!inner(id,status,settings), matches:current_match_id(${matchColumns}), score_states(*)`;
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
  return { court: active.data, error: active.error };
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
