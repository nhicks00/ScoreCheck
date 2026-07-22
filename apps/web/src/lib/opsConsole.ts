import { timestampAgeMs } from "./timeLabels";

/**
 * Production ops console (/admin/production) pure decision logic: program
 * heartbeat freshness, controller URL building, YouTube key masking, and
 * program-page link gating. Explicit inputs only (no env/DB reads) so every
 * rule here is unit-testable — the ...FromEnv wrappers at the bottom are the
 * only functions that touch process.env.
 *
 * The console itself is docs/PRODUCTION_PLATFORM_PLAN.md §3.5; the controller
 * API this builds URLs for is infra/controller/src/index.ts.
 */

/* ---------------------------------------------------------------------------
   Program heartbeat freshness (program_heartbeats, migration 012)
--------------------------------------------------------------------------- */

/**
 * Program pages heartbeat every 5s; beyond ~15s the page (or its Chrome) is
 * gone — same threshold the migration documents.
 */
export const PROGRAM_HEARTBEAT_FRESH_MS = 15_000;

export type HeartbeatFreshness = "fresh" | "stale" | "never";

/**
 * fresh  — beat within the last 15s (small future skew counts as fresh)
 * stale  — a row exists but the page stopped beating
 * never  — no row / unparseable timestamp: the page has never reported
 */
export function classifyHeartbeatFreshness(
  lastSeenAt: string | Date | null | undefined,
  nowMs = Date.now()
): HeartbeatFreshness {
  const ageMs = timestampAgeMs(lastSeenAt, nowMs);
  if (ageMs == null) return "never";
  return ageMs <= PROGRAM_HEARTBEAT_FRESH_MS ? "fresh" : "stale";
}

export function countFreshHeartbeats(
  rows: Array<{ last_seen_at: string | null }> | null | undefined,
  nowMs = Date.now()
): number {
  return (rows ?? []).filter((row) => classifyHeartbeatFreshness(row.last_seen_at, nowMs) === "fresh").length;
}

/* ---------------------------------------------------------------------------
   Production controller (infra/controller) URL building
--------------------------------------------------------------------------- */

/** Mirrors the controller's own court validation (parseCourt: int 1-99). */
export function isValidCourtNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 99;
}

/**
 * CONTROLLER_URL, normalized: trimmed, trailing slashes stripped, and
 * required to parse as an absolute http(s) URL. Anything else — unset, blank,
 * or garbage — is null, which the console renders as "controller offline"
 * instead of letting fetch() throw on a malformed base.
 */
export function normalizeControllerUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
}

export type ControllerCourtAction = "start" | "stop";

/** `${CONTROLLER_URL}/courts/:n/start|stop` — the controller's API shape. */
export function controllerCourtActionUrl(
  rawBaseUrl: string | null | undefined,
  courtNumber: number,
  action: ControllerCourtAction
): string | null {
  const base = normalizeControllerUrl(rawBaseUrl);
  if (!base || !isValidCourtNumber(courtNumber)) return null;
  return `${base}/courts/${courtNumber}/${action}`;
}

/** `${CONTROLLER_URL}/courts` — active egresses, the fleet-status source. */
export function controllerCourtsUrl(rawBaseUrl: string | null | undefined): string | null {
  const base = normalizeControllerUrl(rawBaseUrl);
  return base ? `${base}/courts` : null;
}

/* ---------------------------------------------------------------------------
   Controller fleet payload (GET /courts -> { courts: egress summaries })
--------------------------------------------------------------------------- */

export type ControllerEgress = {
  egressId: string;
  court: number | null;
  status: string;
  startedAt: string | null;
  error: string | null;
};

/** Defensive parse of the controller's egress list — never throws. */
export function parseControllerCourts(payload: unknown): ControllerEgress[] {
  if (!payload || typeof payload !== "object") return [];
  const list = (payload as { courts?: unknown }).courts;
  if (!Array.isArray(list)) return [];
  const egresses: ControllerEgress[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.egressId !== "string" || row.egressId === "") continue;
    egresses.push({
      egressId: row.egressId,
      court: isValidCourtNumber(row.court) ? row.court : null,
      status: typeof row.status === "string" ? row.status : "UNKNOWN",
      startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
      error: typeof row.error === "string" && row.error !== "" ? row.error : null
    });
  }
  return egresses;
}

export function egressForCourt(
  egresses: ControllerEgress[] | null | undefined,
  courtNumber: number
): ControllerEgress | null {
  return (egresses ?? []).find((egress) => egress.court === courtNumber) ?? null;
}

export type BroadcastChip = {
  label: string;
  tone: "live" | "pending" | "stale" | "idle";
};

/** Court broadcast chip from its active egress (null egress = not broadcasting). */
export function broadcastChipForEgress(egress: ControllerEgress | null): BroadcastChip {
  if (!egress) return { label: "Off air", tone: "idle" };
  switch (egress.status) {
    case "EGRESS_ACTIVE":
      return { label: "On air", tone: "live" };
    case "EGRESS_STARTING":
      return { label: "Starting", tone: "pending" };
    case "EGRESS_ENDING":
      return { label: "Stopping", tone: "pending" };
    default:
      return { label: egress.error ? "Egress error" : egress.status, tone: "stale" };
  }
}

/* ---------------------------------------------------------------------------
   YouTube stream key masking (courts.youtube_stream_key, migration 013)
--------------------------------------------------------------------------- */

/**
 * Set/replace display pattern: full keys NEVER go back to the client — only
 * this mask does. Keys shorter than 8 chars reveal nothing (masking most of
 * nothing is revealing something).
 */
export function maskStreamKey(key: string | null | undefined): string | null {
  const trimmed = (key ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length < 8) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/* ---------------------------------------------------------------------------
   Fan "Watch live" links (courts.youtube_video_id, migration 003)
--------------------------------------------------------------------------- */

/**
 * Public YouTube deep link for a court's live broadcast. Video ids are public
 * (unlike stream keys, which stay masked) — blank/missing ids return null so
 * fan surfaces simply omit the link.
 */
export function youtubeWatchUrl(videoId: string | null | undefined): string | null {
  const trimmed = (videoId ?? "").trim();
  if (!trimmed) return null;
  return `https://www.youtube.com/watch?v=${encodeURIComponent(trimmed)}`;
}

/* ---------------------------------------------------------------------------
   Program page monitor links (/program/court/{n})
--------------------------------------------------------------------------- */

/**
 * Debug-mode program-page link for the console's "open program page" action.
 * Built server-side ONLY when PROGRAM_PAGE_TOKEN is configured — an unset
 * token returns null so the secret (or its absence) never shapes client
 * markup beyond a missing link.
 */
export function buildProgramMonitorPath(
  courtNumber: number,
  token: string | null | undefined,
  build: string | null | undefined,
  deployment: string | null | undefined
): string | null {
  const trimmed = (token ?? "").trim();
  const rendererBuild = (build ?? "").trim();
  const rendererDeployment = (deployment ?? "").trim();
  if (!trimmed
    || !isValidCourtNumber(courtNumber)
    || !/^[a-f0-9]{40}$/.test(rendererBuild)
    || !/^dpl_[A-Za-z0-9]+$/.test(rendererDeployment)) return null;
  const query = new URLSearchParams({
    court: String(courtNumber),
    build: rendererBuild,
    deployment: rendererDeployment,
    debug: "1"
  });
  return `/program/bootstrap?${query.toString()}#token=${encodeURIComponent(trimmed)}`;
}

/* ---------------------------------------------------------------------------
   Env wrappers (the only process.env readers in this module)
--------------------------------------------------------------------------- */

export function controllerBaseUrlFromEnv(): string | null {
  return normalizeControllerUrl(process.env.CONTROLLER_URL);
}

export function controllerTokenFromEnv(): string | null {
  const token = process.env.CONTROLLER_TOKEN?.trim();
  return token ? token : null;
}

/** Broadcast controls need both the URL and the bearer token. */
export function controllerConfiguredFromEnv(): boolean {
  return controllerBaseUrlFromEnv() != null && controllerTokenFromEnv() != null;
}
