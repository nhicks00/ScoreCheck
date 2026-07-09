const DEFAULT_EVENT_TIME_ZONE = "America/Denver";

type EventSettingsLike = Record<string, unknown> | null | undefined;

type ScheduledMatchLike = {
  scheduled_date?: string | null;
  scheduled_time?: string | null;
} | null | undefined;

export function eventTimeZone(settings: EventSettingsLike, fallback = DEFAULT_EVENT_TIME_ZONE) {
  const configured = textValue(settings?.timezone ?? settings?.timeZone);
  if (configured && isValidTimeZone(configured)) return configured;
  return isValidTimeZone(fallback) ? fallback : "UTC";
}

export function scheduledTimestamp(match: ScheduledMatchLike, timeZone: string) {
  return localScheduleTimestamp(match?.scheduled_date, match?.scheduled_time, timeZone);
}

export function localScheduleTimestamp(scheduledDate: unknown, scheduledTime: unknown, timeZone: string) {
  if (!isValidTimeZone(timeZone)) return Number.NaN;

  const date = textValue(scheduledDate)?.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const time = parseTime(textValue(scheduledTime));
  if (!date || !time) return Number.NaN;

  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const localAsUtc = Date.UTC(year, month - 1, day, time.hour, time.minute, 0, 0);
  const normalized = new Date(localAsUtc);
  if (
    normalized.getUTCFullYear() !== year
    || normalized.getUTCMonth() !== month - 1
    || normalized.getUTCDate() !== day
  ) {
    return Number.NaN;
  }

  // Start from the wall-clock value represented as UTC, then converge on the
  // real instant using the offset at the candidate instant. The second pass is
  // required when the date and candidate sit on opposite sides of a DST edge.
  let instant = localAsUtc;
  for (let pass = 0; pass < 3; pass += 1) {
    const offset = timeZoneOffsetMs(new Date(instant), timeZone);
    if (!Number.isFinite(offset)) return Number.NaN;
    const next = localAsUtc - offset;
    if (next === instant) break;
    instant = next;
  }

  return localPartsMatch(new Date(instant), timeZone, { year, month, day, ...time })
    ? instant
    : Number.NaN;
}

function parseTime(value: string | null) {
  if (!value) return null;

  const twelveHour = value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (twelveHour) {
    let hour = Number(twelveHour[1]);
    const minute = Number(twelveHour[2]);
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;
    const suffix = twelveHour[3].toUpperCase();
    if (suffix === "PM" && hour !== 12) hour += 12;
    if (suffix === "AM" && hour === 12) hour = 0;
    return { hour, minute };
  }

  const twentyFourHour = value.match(/^([01]?\d|2[0-3]):(\d{2})$/);
  if (!twentyFourHour) return null;
  const hour = Number(twentyFourHour[1]);
  const minute = Number(twentyFourHour[2]);
  return minute <= 59 ? { hour, minute } : null;
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = localDateParts(date, timeZone);
  if (!parts) return Number.NaN;
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  const instantAtMinute = Math.floor(date.getTime() / 60_000) * 60_000;
  return localAsUtc - instantAtMinute;
}

function localPartsMatch(
  date: Date,
  timeZone: string,
  expected: { year: number; month: number; day: number; hour: number; minute: number }
) {
  const actual = localDateParts(date, timeZone);
  return Boolean(actual)
    && actual!.year === expected.year
    && actual!.month === expected.month
    && actual!.day === expected.day
    && actual!.hour === expected.hour
    && actual!.minute === expected.minute;
}

function localDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const parsed = {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
  return Object.values(parsed).every(Number.isFinite) ? parsed : null;
}

export function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function textValue(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}
