const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type RelativeTimeOptions = {
  fallback?: string;
  now?: Date | number;
  timeZone?: string;
};

export function timestampAgeMs(value: string | Date | null | undefined, now: Date | number = Date.now()) {
  const timestamp = coerceTimestamp(value);
  if (timestamp == null) return null;
  const nowMs = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  return nowMs - timestamp;
}

export function isFreshTimestamp(value: string | Date | null | undefined, maxAgeMs: number, now: Date | number = Date.now()) {
  const ageMs = timestampAgeMs(value, now);
  return ageMs != null && ageMs >= 0 && ageMs <= maxAgeMs;
}

export function formatRelativeTime(value: string | Date | null | undefined, options: RelativeTimeOptions = {}) {
  const fallback = options.fallback ?? "unknown";
  const timestamp = coerceTimestamp(value);
  if (timestamp == null) return fallback;

  const nowMs = typeof options.now === "number" ? options.now : options.now?.getTime() ?? Date.now();
  if (!Number.isFinite(nowMs)) return fallback;

  const deltaMs = nowMs - timestamp;
  if (deltaMs < -MINUTE_MS) return `in ${formatDuration(Math.abs(deltaMs))}`;
  if (deltaMs < 10 * SECOND_MS) return "just now";
  if (deltaMs < MINUTE_MS) return `${Math.round(deltaMs / SECOND_MS)} sec ago`;
  if (deltaMs < HOUR_MS) return `${Math.round(deltaMs / MINUTE_MS)} min ago`;
  if (deltaMs < DAY_MS) return `${Math.round(deltaMs / HOUR_MS)} hr ago`;
  if (deltaMs < 2 * DAY_MS) return "Yesterday";
  if (deltaMs < 7 * DAY_MS) return `${Math.round(deltaMs / DAY_MS)} days ago`;
  return formatAbsoluteTime(new Date(timestamp), nowMs, options.timeZone);
}

function coerceTimestamp(value: string | Date | null | undefined) {
  if (!value) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDuration(deltaMs: number) {
  if (deltaMs < HOUR_MS) return `${Math.round(deltaMs / MINUTE_MS)} min`;
  if (deltaMs < DAY_MS) return `${Math.round(deltaMs / HOUR_MS)} hr`;
  return `${Math.round(deltaMs / DAY_MS)} days`;
}

function formatAbsoluteTime(date: Date, nowMs: number, timeZone?: string) {
  const yearFormatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" });
  const sameYear = yearFormatter.format(date) === yearFormatter.format(new Date(nowMs));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone
  }).format(date);
}
