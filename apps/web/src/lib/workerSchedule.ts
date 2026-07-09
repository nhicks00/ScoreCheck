import { getEnv } from "./env";
import { eventTimeZone } from "./scheduleTime";
import { supabaseAdmin } from "./supabase";

const DEFAULT_OFF_EVENT_SLEEP_MS = 15 * 60_000;
const MAX_OFF_EVENT_SLEEP_MS = 6 * 60 * 60_000;
const POLLING_STALE_MS = 60_000;
// A sleeping worker only heartbeats once per sleep interval, so staleness
// must be judged against its declared interval, not the polling threshold.
const SLEEP_GRACE_MULTIPLIER = 1.5;

export type WorkerHeartbeatRow = {
  status?: string | null;
  last_seen_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

export function workerHeartbeatStale(heartbeat: WorkerHeartbeatRow | null | undefined, nowMs = Date.now()): boolean {
  if (!heartbeat?.last_seen_at) return true;
  const lastSeen = new Date(heartbeat.last_seen_at).getTime();
  if (!Number.isFinite(lastSeen)) return true;
  const age = nowMs - lastSeen;
  if (heartbeat.status === "sleeping") {
    const raw = heartbeat.metadata?.nextCheckMs;
    const interval = typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? Math.min(raw, MAX_OFF_EVENT_SLEEP_MS)
      : DEFAULT_OFF_EVENT_SLEEP_MS;
    return age > interval * SLEEP_GRACE_MULTIPLIER;
  }
  return age > POLLING_STALE_MS;
}

export type ActiveEventRow = {
  id: string;
  name?: string | null;
  event_date?: string | null;
  settings?: Record<string, unknown> | null;
};

type MatchDateRow = {
  event_id: string;
  scheduled_date: string | null;
};

export type WorkerCoverageStatus = {
  shouldPoll: boolean;
  eventIds: string[];
  today: string;
  timezone: string;
  sleepMs: number;
  reason: string;
  activeEventCount: number;
  coveredEvents: Array<{ id: string; name: string | null; dates: string[]; today: string; timezone: string }>;
};

export async function getWorkerCoverageStatus(now = new Date()): Promise<WorkerCoverageStatus> {
  const db = supabaseAdmin();
  const env = getEnv();
  const timezone = eventTimeZone(null, env.timezone || "America/Denver");
  const today = dateKeyInTimeZone(now, timezone);
  const sleepMs = parseBoundedMs(process.env.WORKER_OFF_EVENT_INTERVAL_MS, DEFAULT_OFF_EVENT_SLEEP_MS, MAX_OFF_EVENT_SLEEP_MS);

  const { data: events, error } = await db
    .from("events")
    .select("id,name,event_date,settings")
    .or("status.eq.active,is_active.eq.true");
  if (error) throw error;

  const activeEvents = ((events ?? []) as ActiveEventRow[]).filter((event) => Boolean(event.id));
  if (!activeEvents.length) {
    return {
      shouldPoll: false,
      eventIds: [],
      today,
      timezone,
      sleepMs,
      reason: "No active event is configured.",
      activeEventCount: 0,
      coveredEvents: []
    };
  }

  const matchDates = await loadMatchDateKeys(activeEvents.map((event) => event.id));
  const coveredEvents = activeEvents
    .map((event) => eventCoverageAt(event, matchDates.get(event.id) ?? [], now, timezone))
    .filter((event) => event.dates.includes(event.today));

  if (!coveredEvents.length) {
    return {
      shouldPoll: false,
      eventIds: [],
      today,
      timezone,
      sleepMs,
      reason: "No active event is scheduled for its current local date.",
      activeEventCount: activeEvents.length,
      coveredEvents: []
    };
  }

  return {
    shouldPoll: true,
    eventIds: coveredEvents.map((event) => event.id),
    today,
    timezone,
    sleepMs,
    reason: `Polling ${coveredEvents.length} covered active event(s) in their event timezone.`,
    activeEventCount: activeEvents.length,
    coveredEvents
  };
}

export function eventCoverageAt(
  event: ActiveEventRow,
  matchDateValues: string[],
  now: Date,
  fallbackTimezone: string
) {
  const timezone = eventTimeZone(event.settings, fallbackTimezone);
  return {
    id: event.id,
    name: event.name ?? null,
    dates: coverageDateKeys(event, matchDateValues),
    today: dateKeyInTimeZone(now, timezone),
    timezone
  };
}

export function coverageDateKeys(event: Pick<ActiveEventRow, "event_date" | "settings">, matchDateValues: string[]) {
  const dates = new Set<string>();
  addDateKey(dates, event.event_date);

  const settings = event.settings && typeof event.settings === "object" && !Array.isArray(event.settings)
    ? event.settings
    : {};
  addDateKey(dates, settings.coverageDate);
  addDateKey(dates, settings.coverageStartDate);
  addDateKey(dates, settings.coverageEndDate);

  for (const value of arrayValue(settings.coverageDates)) addDateKey(dates, value);
  for (const value of matchDateValues) addDateKey(dates, value);

  const start = dateKey(settings.coverageStartDate);
  const end = dateKey(settings.coverageEndDate);
  if (start && end) {
    for (const value of expandDateRange(start, end)) dates.add(value);
  }

  return [...dates].sort();
}

export function dateKeyInTimeZone(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return date.toISOString().slice(0, 10);
  return `${year}-${month}-${day}`;
}

function dateKey(value: unknown) {
  if (typeof value !== "string") return null;
  return value.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] ?? null;
}

function addDateKey(dates: Set<string>, value: unknown) {
  const parsed = dateKey(value);
  if (parsed) dates.add(parsed);
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function expandDateRange(start: string, end: string) {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return [];
  const dates: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 24 * 60 * 60_000) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

async function loadMatchDateKeys(eventIds: string[]) {
  const dates = new Map<string, string[]>();
  if (!eventIds.length) return dates;
  const { data, error } = await supabaseAdmin()
    .from("matches")
    .select("event_id,scheduled_date")
    .in("event_id", eventIds)
    .not("scheduled_date", "is", null);
  if (error) throw error;
  for (const row of (data ?? []) as MatchDateRow[]) {
    if (!row.event_id) continue;
    const existing = dates.get(row.event_id) ?? [];
    existing.push(row.scheduled_date ?? "");
    dates.set(row.event_id, existing);
  }
  return dates;
}

function parseBoundedMs(raw: string | undefined, fallback: number, max: number) {
  if (!raw) return fallback;
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed) || parsed < 60_000 || parsed > max) return fallback;
  return parsed;
}
