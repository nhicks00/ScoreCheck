import { getEnv, publicOrigin } from "./env";
import { defaultManualState } from "./manualScoring";
import { persistScoreAndOverlay } from "./scoreState";
import { supabaseAdmin } from "./supabase";

export const DEFAULT_FAN_SCORING_SETTINGS = {
  heartbeatSeconds: 5,
  staleSeconds: 15,
  failoverSeconds: 35,
  maxBackupScorersPerCourt: 4,
  claimExpirationMinutes: 10,
  videoTokenSeconds: 600,
  requireYoutubeVerification: true,
  allowCourtsideMode: true
};

export const DEFAULT_MATCH_FORMAT = {
  bestOf: 3,
  pointsPerSet: [21, 21, 15],
  winByTwo: true,
  cap: null,
  setsToWin: 2
};

type Db = ReturnType<typeof supabaseAdmin>;

export type EventRow = {
  id: string;
  name: string;
  slug?: string | null;
  status: string;
  is_active?: boolean | null;
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
  youtube_video_id?: string | null;
  youtube_live_chat_id?: string | null;
  ivs_channel_arn?: string | null;
  ivs_playback_url?: string | null;
  public_score_url?: string | null;
};

export async function getActiveEvent(db = supabaseAdmin()): Promise<EventRow | null> {
  const byFlag = await db
    .from("events")
    .select("*")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (byFlag.error && !isMissingColumnError(byFlag.error, "is_active")) {
    throwSupabaseError(byFlag.error);
  }
  if (byFlag.data) return byFlag.data as EventRow;

  const byStatus = await db
    .from("events")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (byStatus.error) throwSupabaseError(byStatus.error);
  return (byStatus.data as EventRow | null) ?? null;
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
  courtIvs?: Record<number, { channelArn?: string; playbackUrl?: string }>;
  courtYoutube?: Record<number, { displayName?: string; videoId?: string; liveChatId?: string }>;
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

  for (let courtNumber = 1; courtNumber <= env.courtCount; courtNumber += 1) {
    const ivs = input.courtIvs?.[courtNumber] ?? {};
    const youtube = input.courtYoutube?.[courtNumber] ?? {};
    const displayName = youtube.displayName || `Court ${courtNumber}`;
    const courtPayload = {
      event_id: event.id,
      court_number: courtNumber,
      display_name: displayName,
      camera_name: `Camera ${courtNumber}`,
      mode: "manual",
      status: "waiting",
      frozen: false,
      scoring_open: true,
      backup_requested: true,
      public_score_url: `${siteUrl}/score/court/${courtNumber}`,
      youtube_video_id: youtube.videoId || null,
      youtube_live_chat_id: youtube.liveChatId || null,
      ivs_channel_arn: ivs.channelArn || null,
      ivs_playback_url: ivs.playbackUrl || null,
      updated_at: now
    };
    const { data: existingCourt } = await db
      .from("courts")
      .select("*")
      .eq("event_id", event.id)
      .eq("court_number", courtNumber)
      .maybeSingle();
    const courtResult = existingCourt
      ? await db.from("courts").update(courtPayload).eq("id", existingCourt.id).select("*").single()
      : await db.from("courts").insert(courtPayload).select("*").single();
    if (courtResult.error) throw courtResult.error;
    const court = courtResult.data as CourtRow;

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
    await db.from("courts").update({
      current_match_id: match.id,
      status: "waiting",
      updated_at: now
    }).eq("id", court.id);

    const initial = defaultManualState();
    await persistScoreAndOverlay(court, match, {
      court_id: court.id,
      match_id: match.id,
      team_a_score: initial.team_a_score,
      team_b_score: initial.team_b_score,
      team_a_sets: initial.team_a_sets,
      team_b_sets: initial.team_b_sets,
      current_set: initial.current_set,
      set_scores: initial.set_scores,
      serving_team: initial.serving_team,
      timeouts: initial.timeouts,
      status: "Pre-Match",
      source: "manual",
      stale: false,
      message: null
    });
  }

  return event;
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
