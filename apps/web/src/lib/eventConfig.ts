import { getEnv, publicOrigin } from "./env";
import { transitionCommunityMatch } from "./communityWitness";
import { refreshCourtOverlay, trustedScoreActionId } from "./scoreState";
import { supabaseAdmin } from "./supabase";

export const DEFAULT_FAN_SCORING_SETTINGS = {
  heartbeatSeconds: 5,
  staleSeconds: 15,
  failoverSeconds: 35,
  maxBackupScorersPerCourt: 4,
  claimExpirationMinutes: 10,
  allowScoreOnlyMode: true
};

export const DEFAULT_MATCH_FORMAT = {
  bestOf: 3,
  pointsPerSet: [21, 21, 15],
  winByTwo: true,
  cap: null,
  setsToWin: 2
};

export const AVP_DENVER_VBL_BRACKET_SOURCES = [
  "https://volleyballlife.com/event/37451/division/136904/round/311708/pools",
  "https://volleyballlife.com/event/37451/division/136905/round/311711/pools"
];

export const AVP_DENVER_STREAM_COURT_MAP: Record<number, { displayName: string; vblCourtNumber: string; vblCourtLabel: string }> = {
  1: { displayName: "Center Court", vblCourtNumber: "ST", vblCourtLabel: "Center Court" },
  2: { displayName: "Court 7", vblCourtNumber: "7", vblCourtLabel: "Court 7" },
  3: { displayName: "Court 8", vblCourtNumber: "8", vblCourtLabel: "Court 8" },
  4: { displayName: "Court 10", vblCourtNumber: "10", vblCourtLabel: "Court 10" },
  5: { displayName: "Court 11", vblCourtNumber: "11", vblCourtLabel: "Court 11" },
  6: { displayName: "Court 14", vblCourtNumber: "14", vblCourtLabel: "Court 14" },
  7: { displayName: "Court 16", vblCourtNumber: "16", vblCourtLabel: "Court 16" },
  8: { displayName: "Court 18", vblCourtNumber: "18", vblCourtLabel: "Court 18" }
};

type Db = ReturnType<typeof supabaseAdmin>;

export type EventRow = {
  id: string;
  name: string;
  slug?: string | null;
  status: string;
  is_active?: boolean | null;
  event_date?: string | null;
  created_at?: string | null;
  settings?: Record<string, unknown> | null;
};

export type CourtRow = {
  id: string;
  event_id: string;
  court_number: number;
  display_name: string;
  current_match_id: string | null;
  status: string;
  mode: "api" | "manual" | "hybrid";
  frozen: boolean;
  last_update_at: string | null;
  scoring_open?: boolean | null;
  backup_requested?: boolean | null;
  preview_stream_path: string;
  program_stream_path: string;
  program_video_delay_ms?: number | null;
  camera_audio_gain_db?: number | null;
  commentary_gain_db?: number | null;
  commentary_delay_ms?: number | null;
  public_score_url?: string | null;
  vbl_court_number?: string | null;
  vbl_court_label?: string | null;
};

/**
 * The single source of truth for "which event is current". Resolution order
 * (see selectActiveEvent for the pure, tested logic):
 *   1. An event flagged is_active = true — manual admin control, always wins.
 *   2. Otherwise the most sensible NON-completed event by date (nearest
 *      upcoming, else most recent), so it tracks the live/next tournament.
 *   3. Otherwise the most recent event overall (only completed events remain),
 *      so this never returns empty when any event exists.
 *
 * We `select("*")` and decide in JS rather than filtering on is_active in SQL:
 * this keeps the missing-column guard implicit (an older DB without is_active
 * simply yields undefined flags and falls through to the date logic) and lets
 * one pure function own the priority ordering.
 */
export async function getActiveEvent(db = supabaseAdmin()): Promise<EventRow | null> {
  const { data, error } = await db
    .from("events")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throwSupabaseError(error);
  const events = (data as EventRow[] | null) ?? [];
  return selectActiveEvent(events, currentDateIso());
}

/**
 * Pure selection of the current event from a list. `today` is a YYYY-MM-DD
 * string in the app's timezone; event_date is a Postgres `date` (also
 * YYYY-MM-DD), so plain string comparison is chronological. Kept side-effect
 * free so the priority ordering can be unit tested without a database.
 */
export function selectActiveEvent(events: EventRow[], today: string): EventRow | null {
  if (!Array.isArray(events) || events.length === 0) return null;

  // 1. Manual control always wins. The DB enforces at most one is_active row,
  //    but if data is ever inconsistent, pick deterministically by recency.
  const flagged = events.filter((event) => event.is_active === true);
  if (flagged.length > 0) return [...flagged].sort(byRecencyDesc)[0];

  // 2. Prefer a current event among the non-completed ones.
  const live = events.filter((event) => normalizeStatus(event.status) !== "completed");
  if (live.length > 0) return mostRelevant(live, today);

  // 3. Only completed events remain — never return empty when events exist.
  return [...events].sort(byRecencyDesc)[0];
}

/** Nearest upcoming non-completed event, else the most recent past/undated one. */
function mostRelevant(events: EventRow[], today: string): EventRow {
  const upcoming = events
    .filter((event) => typeof event.event_date === "string" && event.event_date >= today)
    .sort((a, b) => {
      if (a.event_date !== b.event_date) return (a.event_date as string) < (b.event_date as string) ? -1 : 1;
      return byCreatedDesc(a, b);
    });
  if (upcoming.length > 0) return upcoming[0];
  return [...events].sort(byRecencyDesc)[0];
}

/** Later event_date first (undated sorts last), tiebroken by newer created_at. */
function byRecencyDesc(a: EventRow, b: EventRow): number {
  const aDate = a.event_date ?? "";
  const bDate = b.event_date ?? "";
  if (aDate !== bDate) return aDate < bDate ? 1 : -1;
  return byCreatedDesc(a, b);
}

/** Newer created_at first (missing sorts last). */
function byCreatedDesc(a: EventRow, b: EventRow): number {
  const aCreated = a.created_at ?? "";
  const bCreated = b.created_at ?? "";
  if (aCreated === bCreated) return 0;
  return aCreated < bCreated ? 1 : -1;
}

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "").trim().toLowerCase();
}

/** Today as YYYY-MM-DD in the app's configured timezone (falls back to UTC). */
function currentDateIso(now: Date = new Date()): string {
  const timeZone = getEnv().timezone;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Make `eventId` the one active event: clear is_active on every other event
 * first (so the partial unique index never sees two actives), demote a
 * previously-active event's status to 'inactive' (do NOT auto-complete it),
 * then promote the chosen event to is_active=true, status='active'. This is the
 * single write authority the admin "Set as active" action goes through.
 */
export async function setActiveEvent(eventId: string, db = supabaseAdmin()): Promise<EventRow> {
  const now = new Date().toISOString();

  const { data: previouslyActive, error: previousError } = await db
    .from("events")
    .select("id,status,is_active")
    .neq("id", eventId);
  if (previousError && !isMissingColumnError(previousError, "is_active")) throwSupabaseError(previousError);
  let previousEvents = (previouslyActive ?? []) as Array<{ id: string; status: string; is_active?: boolean }>;
  if (previousError) {
    const fallback = await db.from("events").select("id,status").neq("id", eventId);
    if (fallback.error) throwSupabaseError(fallback.error);
    previousEvents = (fallback.data ?? []) as Array<{ id: string; status: string }>;
  }
  for (const previous of previousEvents) {
    if (previous.status === "active" || previous.is_active === true) {
      await endEventCourtMatches(previous.id, "Event switched inactive", "queued", db);
    }
  }

  const cleared = await db.from("events").update({ is_active: false, updated_at: now }).neq("id", eventId);
  const isActiveMissing = cleared.error ? isMissingColumnError(cleared.error, "is_active") : false;
  if (cleared.error && !isActiveMissing) throwSupabaseError(cleared.error);

  const demoted = await db.from("events").update({ status: "inactive", updated_at: now }).eq("status", "active").neq("id", eventId);
  if (demoted.error) throwSupabaseError(demoted.error);

  const promotion = isActiveMissing
    ? { status: "active", updated_at: now }
    : { status: "active", is_active: true, updated_at: now };
  const { data, error } = await db.from("events").update(promotion).eq("id", eventId).select("*").single();
  if (error) throwSupabaseError(error);
  return data as EventRow;
}

/** Archive an event: mark it completed and ensure it is not the active one. */
export async function setEventCompleted(eventId: string, db = supabaseAdmin()): Promise<EventRow> {
  const now = new Date().toISOString();
  await endEventCourtMatches(eventId, "Event completed", "finished", db);
  const completion: Record<string, unknown> = { status: "completed", updated_at: now };
  let result = await db.from("events").update({ ...completion, is_active: false }).eq("id", eventId).select("*").single();
  if (result.error && isMissingColumnError(result.error, "is_active")) {
    result = await db.from("events").update(completion).eq("id", eventId).select("*").single();
  }
  if (result.error) throwSupabaseError(result.error);
  return result.data as EventRow;
}

async function endEventCourtMatches(
  eventId: string,
  actorLabel: string,
  queueStatus: "queued" | "finished",
  db: Db
) {
  const { data: courts, error } = await db
    .from("courts")
    .select("*")
    .eq("event_id", eventId)
    .not("current_match_id", "is", null);
  if (error) throwSupabaseError(error);
  for (const court of (courts ?? []) as CourtRow[]) {
    if (!court.current_match_id) continue;
    await transitionCommunityMatch({
      eventId,
      courtId: court.id,
      fromMatchId: court.current_match_id,
      toMatchId: null,
      actionId: trustedScoreActionId({ type: "event-lifecycle-end-match", eventId, courtId: court.id, matchId: court.current_match_id, actorLabel }),
      actorType: "ADMIN",
      actorLabel,
      initialAuthorityMode: "PAUSED_DISPUTE"
    });
    const now = new Date().toISOString();
    const queueResult = await db.from("court_match_queue")
      .update({ is_active: false, status: queueStatus, updated_at: now })
      .eq("court_id", court.id)
      .eq("is_active", true);
    if (queueResult.error) throwSupabaseError(queueResult.error);
    const courtResult = await db.from("courts")
      .update({ status: "idle", last_update_at: now, updated_at: now })
      .eq("id", court.id);
    if (courtResult.error) throwSupabaseError(courtResult.error);
    await refreshCourtOverlay(court.id);
  }
}

export async function getEventBySlug(slug: string, db = supabaseAdmin()): Promise<EventRow | null> {
  const { data, error } = await db.from("events").select("*").eq("slug", slug).maybeSingle();
  if (error) throwSupabaseError(error);
  return (data as EventRow | null) ?? null;
}

export async function getCourtByNumber(eventId: string, courtNumber: number, db = supabaseAdmin()): Promise<CourtRow | null> {
  const { data, error } = await db
    .from("courts")
    .select("*")
    .eq("event_id", eventId)
    .eq("court_number", courtNumber)
    .maybeSingle();
  if (error) throwSupabaseError(error);
  return (data as CourtRow | null) ?? null;
}

export async function resolveCourtIdentifier(input: {
  eventSlug?: string;
  courtParam: string;
  db?: Db;
}): Promise<{ event: EventRow; court: CourtRow } | null> {
  const db = input.db ?? supabaseAdmin();
  const event = input.eventSlug
    ? await getEventBySlug(input.eventSlug, db)
    : await getActiveEvent(db);
  if (!event) return null;

  const numeric = Number(input.courtParam);
  if (Number.isInteger(numeric) && numeric >= 1) {
    const court = await getCourtByNumber(event.id, numeric, db);
    return court ? { event, court } : null;
  }

  const { data } = await db
    .from("courts")
    .select("*")
    .eq("id", input.courtParam)
    .maybeSingle();
  const court = data as CourtRow | null;
  return court ? { event, court } : null;
}

function isMissingColumnError(error: { code?: string; message?: string }, column: string): boolean {
  return error.code === "42703" || Boolean(error.message?.includes(column) && error.message.toLowerCase().includes("column"));
}

function throwSupabaseError(error: { message?: string }) {
  throw new Error(error.message || "Supabase request failed");
}

export async function ensureAvpDenverSeeded(input: {
  siteUrl?: string;
  courtStreamPaths?: Record<number, string>;
} = {}, db = supabaseAdmin()) {
  const env = getEnv();
  const slug = env.defaultEventSlug;
  const now = new Date().toISOString();
  const siteUrl = publicOrigin(input.siteUrl ?? env.publicSiteUrl);
  const settings = {
    defaultFormat: DEFAULT_MATCH_FORMAT,
    staleTimeoutSeconds: 20,
    activePollIntervalMs: 1800,
    upcomingPollIntervalMs: 20000,
    overlayTheme: "default",
    fanScoring: DEFAULT_FAN_SCORING_SETTINGS
  };

  await db.from("events").update({ is_active: false, status: "inactive", updated_at: now }).neq("slug", slug);
  const existing = await getEventBySlug(slug, db);
  const eventResult = existing
    ? await db.from("events").update({
      name: env.eventName,
      slug,
      status: "active",
      is_active: true,
      settings,
      updated_at: now
    }).eq("id", existing.id).select("*").single()
    : await db.from("events").insert({
      name: env.eventName,
      slug,
      venue: "Denver",
      status: "active",
      is_active: true,
      settings
    }).select("*").single();
  if (eventResult.error) throw eventResult.error;
  const event = eventResult.data as EventRow;

  await Promise.all(AVP_DENVER_VBL_BRACKET_SOURCES.map((sourceUrl) => db.from("bracket_sources").upsert({
    event_id: event.id,
    source_url: sourceUrl,
    source_type: "bracket",
    status: "pending",
    last_error: null
  }, { onConflict: "event_id,source_url" })));

  for (let courtNumber = 1; courtNumber <= env.courtCount; courtNumber += 1) {
    const streamCourt = AVP_DENVER_STREAM_COURT_MAP[courtNumber];
    const displayName = streamCourt?.displayName || `Court ${courtNumber}`;
    const generatedVblCourt = vblCourtFromDisplayName(displayName);
    const { data: existingCourt } = await db
      .from("courts")
      .select("*")
      .eq("event_id", event.id)
      .eq("court_number", courtNumber)
      .maybeSingle();
    const courtPayload = {
      event_id: event.id,
      court_number: courtNumber,
      display_name: displayName,
      camera_name: `Camera ${courtNumber}`,
      mode: existingCourt?.mode === "api" ? "hybrid" : existingCourt?.mode ?? "hybrid",
      status: "waiting",
      frozen: false,
      scoring_open: true,
      backup_requested: true,
      public_score_url: `${siteUrl}/score/court/${courtNumber}`,
      preview_stream_path: input.courtStreamPaths?.[courtNumber] || `court${courtNumber}_preview`,
      program_stream_path: `court${courtNumber}_program`,
      vbl_court_number: streamCourt?.vblCourtNumber ?? generatedVblCourt.number,
      vbl_court_label: streamCourt?.vblCourtLabel ?? generatedVblCourt.label,
      updated_at: now
    };
    const courtResult = existingCourt
      ? await db.from("courts").update(courtPayload).eq("id", existingCourt.id).select("*").single()
      : await db.from("courts").insert(courtPayload).select("*").single();
    if (courtResult.error) throw courtResult.error;
    const court = courtResult.data as CourtRow;

    const currentMatch = court.current_match_id
      ? await loadMatch(court.current_match_id, db)
      : null;
    if (currentMatch?.source_type === "vbl") {
      continue;
    }

    const { data: activeMatch } = await db
      .from("matches")
      .select("*")
      .eq("event_id", event.id)
      .eq("source_type", "manual")
      .eq("court_number", String(courtNumber))
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const matchResult = activeMatch
      ? await db.from("matches").update({
        team_a: activeMatch.team_a ?? "Team on left",
        team_b: activeMatch.team_b ?? "Team on right",
        format: activeMatch.format ?? DEFAULT_MATCH_FORMAT,
        updated_at: now
      }).eq("id", activeMatch.id).select("*").single()
      : await db.from("matches").insert({
        event_id: event.id,
        external_match_id: `seed-${slug}-court-${courtNumber}`,
        source_type: "manual",
        api_url: null,
        match_number: displayName,
        round_name: "Pool Play",
        court_number: String(courtNumber),
        physical_court: displayName,
        team_a: "Team on left",
        team_b: "Team on right",
        team_a_players: [],
        team_b_players: [],
        format: DEFAULT_MATCH_FORMAT,
        status: "scheduled",
        source_payload: { seededBy: "seed:avp-denver" }
      }).select("*").single();
    if (matchResult.error) throw matchResult.error;

    const match = matchResult.data;
    await transitionCommunityMatch({
      eventId: event.id,
      courtId: court.id,
      fromMatchId: court.current_match_id,
      toMatchId: match.id,
      actionId: trustedScoreActionId({ type: "seed-event-court", eventId: event.id, courtId: court.id, matchId: match.id }),
      actorType: "SYSTEM",
      actorLabel: "Event seed",
      initialAuthorityMode: "PAUSED_DISPUTE"
    });
    await db.from("courts").update({
      status: "waiting",
      updated_at: now
    }).eq("id", court.id);
    await refreshCourtOverlay(court.id);
  }

  return event;
}

async function loadMatch(matchId: string, db: Db) {
  const { data, error } = await db.from("matches").select("id,source_type").eq("id", matchId).maybeSingle();
  if (error) throwSupabaseError(error);
  return data as { id: string; source_type?: string | null } | null;
}

function vblCourtFromDisplayName(displayName: string): { number: string | null; label: string | null } {
  const courtNumber = displayName.match(/\bcourt\s+(\d+)\b/i)?.[1] ?? null;
  if (courtNumber) {
    return { number: courtNumber, label: `Court ${courtNumber}` };
  }
  if (/center/i.test(displayName)) {
    return { number: null, label: "Center Court" };
  }
  return { number: null, label: null };
}

export function fanScoringSettings(event: EventRow | null | undefined) {
  const settings = event?.settings?.fanScoring;
  const record = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Partial<typeof DEFAULT_FAN_SCORING_SETTINGS>
    : {};
  return {
    ...DEFAULT_FAN_SCORING_SETTINGS,
    ...record
  };
}
