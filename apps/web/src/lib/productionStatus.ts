import {
  classifyHeartbeatFreshness,
  controllerBaseUrlFromEnv,
  controllerCourtActionUrl,
  controllerCourtsUrl,
  controllerTokenFromEnv,
  countFreshHeartbeats,
  maskStreamKey,
  parseControllerCourts,
  type ControllerCourtAction,
  type ControllerEgress,
  type HeartbeatFreshness
} from "./opsConsole";
import { supabaseAdmin } from "./supabase";
import { getActiveEvent } from "./eventConfig";
import { courtStreamPath } from "./video";
import { getEnv } from "./env";
import { workerHeartbeatStale, type WorkerHeartbeatRow } from "./workerSchedule";

/**
 * Server-side data assembly for /admin/production: one snapshot shape shared
 * by the page's first render and the polled status route, so the console
 * never shows two versions of the truth. Pure decision logic lives in
 * ./opsConsole; this module owns the Supabase queries and the short-timeout
 * reachability probes (controller + MediaMTX).
 */

export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export type ConsoleMatch = {
  teamA: string | null;
  teamB: string | null;
  roundName: string | null;
  matchNumber: string | null;
};

export type ConsoleScore = {
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  currentSet: number;
  status: string;
  stale: boolean;
};

export type ConsoleHeartbeat = {
  freshness: HeartbeatFreshness;
  lastSeenAt: string | null;
  ageSeconds: number | null;
  videoState: string | null;
  framesRendered: number | null;
  commentaryLoaded: boolean | null;
};

export type ConsoleCourt = {
  courtId: string | null;
  courtNumber: number;
  displayName: string;
  streamPath: string;
  courtStatus: string | null;
  match: ConsoleMatch | null;
  score: ConsoleScore | null;
  youtubeKeyMasked: string | null;
  heartbeat: ConsoleHeartbeat;
};

export type WorkerSummary = {
  state: "ok" | "stale" | "missing" | "error";
  workerId: string | null;
  status: string | null;
  lastSeenAt: string | null;
};

export type ProductionSnapshot = {
  event: { id: string; name: string } | null;
  courts: ConsoleCourt[];
  freshHeartbeats: number;
  heartbeatsAvailable: boolean;
  worker: WorkerSummary;
  generatedAt: string;
};

type CourtRow = {
  id: string;
  court_number: number;
  display_name: string | null;
  status?: string | null;
  stream_path?: string | null;
  current_match_id?: string | null;
  youtube_stream_key?: string | null;
  matches?: MatchRow | MatchRow[] | null;
  score_states?: ScoreRow | ScoreRow[] | null;
};

type MatchRow = {
  id: string;
  team_a: string | null;
  team_b: string | null;
  round_name: string | null;
  match_number: string | null;
};

type ScoreRow = {
  match_id?: string | null;
  team_a_score: number;
  team_b_score: number;
  team_a_sets: number;
  team_b_sets: number;
  current_set: number;
  status: string;
  stale: boolean;
};

type HeartbeatRow = {
  court_number: number;
  last_seen_at: string | null;
  video_state: string | null;
  frames_rendered: number | null;
  commentary_loaded: boolean | null;
};

export async function loadProductionSnapshot(): Promise<ProductionSnapshot> {
  const db = supabaseAdmin();
  const courtCount = getEnv().courtCount;
  const nowMs = Date.now();

  const event = await getActiveEvent(db);
  const [courtsResult, heartbeatsResult, workerResult] = await Promise.all([
    event
      ? db
          .from("courts")
          .select("*, matches:current_match_id(*), score_states(*)")
          .eq("event_id", event.id)
          .order("court_number", { ascending: true })
      : Promise.resolve({ data: [] as unknown[], error: null }),
    db.from("program_heartbeats").select("*"),
    db
      .from("worker_heartbeats")
      .select("worker_id,status,last_seen_at,metadata")
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  const courtRows = (courtsResult.data ?? []) as CourtRow[];
  const courtByNumber = new Map(courtRows.map((row) => [row.court_number, row]));
  // Tolerate a missing program_heartbeats table (migration 012 not applied):
  // the console renders "never" chips plus an availability note instead of 500ing.
  const heartbeatRows = (heartbeatsResult.error ? [] : (heartbeatsResult.data ?? [])) as HeartbeatRow[];
  const heartbeatByCourt = new Map(heartbeatRows.map((row) => [row.court_number, row]));

  const courts: ConsoleCourt[] = Array.from({ length: courtCount }, (_, index) => {
    const courtNumber = index + 1;
    const row = courtByNumber.get(courtNumber) ?? null;
    return buildConsoleCourt(courtNumber, row, heartbeatByCourt.get(courtNumber) ?? null, nowMs);
  });

  return {
    event: event ? { id: event.id, name: event.name } : null,
    courts,
    freshHeartbeats: countFreshHeartbeats(heartbeatRows, nowMs),
    heartbeatsAvailable: !heartbeatsResult.error,
    worker: summarizeWorker(workerResult.data as (WorkerHeartbeatRow & { worker_id?: string }) | null, Boolean(workerResult.error), nowMs),
    generatedAt: new Date(nowMs).toISOString()
  };
}

function buildConsoleCourt(
  courtNumber: number,
  row: CourtRow | null,
  heartbeat: HeartbeatRow | null,
  nowMs: number
): ConsoleCourt {
  const match = firstRelation(row?.matches);
  const score = scoreForMatch(row?.score_states, match?.id);
  return {
    courtId: row?.id ?? null,
    courtNumber,
    displayName: row?.display_name?.trim() || `Court ${courtNumber}`,
    streamPath: courtStreamPath(courtNumber, row?.stream_path),
    courtStatus: row?.status ?? null,
    match: match
      ? {
          teamA: match.team_a,
          teamB: match.team_b,
          roundName: match.round_name,
          matchNumber: match.match_number
        }
      : null,
    score: score
      ? {
          teamAScore: score.team_a_score,
          teamBScore: score.team_b_score,
          teamASets: score.team_a_sets,
          teamBSets: score.team_b_sets,
          currentSet: score.current_set,
          status: score.status,
          stale: Boolean(score.stale)
        }
      : null,
    youtubeKeyMasked: maskStreamKey(row?.youtube_stream_key),
    heartbeat: {
      freshness: classifyHeartbeatFreshness(heartbeat?.last_seen_at, nowMs),
      lastSeenAt: heartbeat?.last_seen_at ?? null,
      ageSeconds: heartbeatAgeSeconds(heartbeat?.last_seen_at, nowMs),
      videoState: heartbeat?.video_state ?? null,
      framesRendered: heartbeat?.frames_rendered ?? null,
      commentaryLoaded: heartbeat?.commentary_loaded ?? null
    }
  };
}

function summarizeWorker(
  row: (WorkerHeartbeatRow & { worker_id?: string }) | null,
  queryFailed: boolean,
  nowMs: number
): WorkerSummary {
  if (queryFailed) return { state: "error", workerId: null, status: null, lastSeenAt: null };
  if (!row) return { state: "missing", workerId: null, status: null, lastSeenAt: null };
  return {
    state: workerHeartbeatStale(row, nowMs) ? "stale" : "ok",
    workerId: row.worker_id ?? null,
    status: row.status ?? null,
    lastSeenAt: row.last_seen_at ?? null
  };
}

/* ---------------------------------------------------------------------------
   Reachability probes (status route only — short timeouts, never throw)
--------------------------------------------------------------------------- */

export type ControllerStatus = {
  configured: boolean;
  /** null = not probed (unconfigured); true/false = probe result. */
  reachable: boolean | null;
  error: string | null;
  egresses: ControllerEgress[];
};

export async function checkController(timeoutMs = HEALTH_PROBE_TIMEOUT_MS): Promise<ControllerStatus> {
  const baseUrl = controllerBaseUrlFromEnv();
  const token = controllerTokenFromEnv();
  const listUrl = controllerCourtsUrl(baseUrl);
  if (!listUrl || !token) {
    return { configured: false, reachable: null, error: null, egresses: [] };
  }
  try {
    const res = await fetch(listUrl, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return {
        configured: true,
        reachable: true,
        error: `controller responded ${res.status}${res.status === 401 ? " (check CONTROLLER_TOKEN)" : ""}`,
        egresses: []
      };
    }
    const payload: unknown = await res.json().catch(() => null);
    return { configured: true, reachable: true, error: null, egresses: parseControllerCourts(payload) };
  } catch {
    return { configured: true, reachable: false, error: "controller unreachable", egresses: [] };
  }
}

export type MediamtxStatus = {
  configured: boolean;
  /** null = not probed (unconfigured); true = HTTP answered; false = network-dead. */
  up: boolean | null;
};

/**
 * "Video server up" probe: HEAD the court1 WHEP endpoint on the MediaMTX
 * droplet. Any HTTP response (including 404/405 while the stream is idle)
 * proves the server answers; only a network failure/timeout reports down.
 */
export async function checkMediamtxPreview(timeoutMs = HEALTH_PROBE_TIMEOUT_MS): Promise<MediamtxStatus> {
  const whepBase = getEnv().mediamtxWhepBaseUrl.trim().replace(/\/+$/, "");
  if (!whepBase) return { configured: false, up: null };
  try {
    await fetch(`${whepBase}/court1/whep`, {
      method: "HEAD",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { configured: true, up: true };
  } catch {
    return { configured: true, up: false };
  }
}

/* ---------------------------------------------------------------------------
   Controller proxy (POST /courts/:n/start|stop) — shared by the two admin
   broadcast routes so URL building, auth, timeouts, and error mapping stay
   identical.
--------------------------------------------------------------------------- */

export const CONTROLLER_ACTION_TIMEOUT_MS = 10_000;

export const CONTROLLER_OFFLINE_MESSAGE =
  "Compositor controller offline — CONTROLLER_URL/CONTROLLER_TOKEN not configured. Expected until the compositor fleet ships (infra/compositor/GATING_EXPERIMENT.md).";

export type ControllerProxyResult = {
  status: number;
  body: Record<string, unknown>;
};

export async function proxyControllerCourtAction(
  courtNumber: number,
  action: ControllerCourtAction
): Promise<ControllerProxyResult> {
  const baseUrl = controllerBaseUrlFromEnv();
  const token = controllerTokenFromEnv();
  const url = controllerCourtActionUrl(baseUrl, courtNumber, action);
  if (!url || !token) {
    return { status: 503, body: { error: CONTROLLER_OFFLINE_MESSAGE } };
  }

  // Start pulls the court's YouTube key out of Supabase server-side (plan
  // §3.4: keys live on the court row, only servers read them). The controller
  // falls back to its own COURT_{N}_YOUTUBE_KEY env when we send none.
  const body: Record<string, unknown> = {};
  if (action === "start") {
    const youtubeKey = await activeCourtYoutubeKey(courtNumber);
    if (youtubeKey) body.youtubeKey = youtubeKey;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(CONTROLLER_ACTION_TIMEOUT_MS)
    });
    const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return { status: res.status, body: payload };
    }
    return {
      status: res.ok ? 502 : res.status,
      body: { error: `Controller responded ${res.status} without a JSON body` }
    };
  } catch {
    return { status: 502, body: { error: "Compositor controller unreachable — is the base droplet up?" } };
  }
}

/** courts.youtube_stream_key for the active event's court n; null on any miss. */
async function activeCourtYoutubeKey(courtNumber: number): Promise<string | null> {
  try {
    const db = supabaseAdmin();
    const event = await getActiveEvent(db);
    if (!event) return null;
    // select("*") tolerates migration 013 not being applied yet — the column
    // is simply absent from the row instead of erroring the whole request.
    const { data } = await db
      .from("courts")
      .select("*")
      .eq("event_id", event.id)
      .eq("court_number", courtNumber)
      .maybeSingle();
    const key = (data as { youtube_stream_key?: string | null } | null)?.youtube_stream_key;
    const trimmed = (key ?? "").trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
   Small shared helpers
--------------------------------------------------------------------------- */

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function scoreForMatch(
  value: ScoreRow | ScoreRow[] | null | undefined,
  matchId: string | null | undefined
): ScoreRow | null {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  if (!matchId) return rows[0] ?? null;
  return rows.find((row) => row.match_id === matchId) ?? null;
}

function heartbeatAgeSeconds(lastSeenAt: string | null | undefined, nowMs: number): number | null {
  if (!lastSeenAt) return null;
  const timestamp = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round((nowMs - timestamp) / 1000));
}
