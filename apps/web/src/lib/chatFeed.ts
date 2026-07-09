/**
 * Shared shapes + pure helpers for the /chat live feed. Kept free of next/react
 * imports so the server component, the API route, and the client component all
 * agree on the message DTO and the per-court colour assignment.
 */

/** Row shape as selected from public.chat_messages. */
export type ChatMessageDbRow = {
  id: string;
  youtube_message_id: string;
  court_number: number | null;
  court_label: string | null;
  author_name: string | null;
  is_moderator: boolean | null;
  is_owner: boolean | null;
  message_text: string | null;
  published_at: string | null;
  created_at: string;
};

/** Client-facing message DTO (camelCase, never exposes channel ids). */
export type ChatMessageDto = {
  id: string;
  youtubeMessageId: string;
  courtNumber: number | null;
  courtLabel: string | null;
  authorName: string | null;
  isModerator: boolean;
  isOwner: boolean;
  text: string;
  publishedAt: string | null;
  createdAt: string;
};

export function chatMessageRowToDto(row: ChatMessageDbRow): ChatMessageDto {
  return {
    id: row.id,
    youtubeMessageId: row.youtube_message_id,
    courtNumber: row.court_number,
    courtLabel: row.court_label,
    authorName: row.author_name,
    isModerator: row.is_moderator === true,
    isOwner: row.is_owner === true,
    text: row.message_text ?? "",
    publishedAt: row.published_at,
    createdAt: row.created_at
  };
}

/**
 * A palette of eight visually distinct hues for the court badges. Indexing by
 * court number keeps each court's colour stable across renders and sessions.
 */
export const COURT_BADGE_COLORS = [
  "#ff6b4a", // coral
  "#22d3ee", // cyan
  "#34d399", // green
  "#fbbf24", // amber
  "#a78bfa", // violet
  "#f472b6", // pink
  "#38bdf8", // sky
  "#fb923c" // orange
] as const;

/** Stable, distinct badge colour for a court number (falls back gracefully). */
export function courtColor(courtNumber: number | null | undefined): string {
  if (courtNumber == null || !Number.isFinite(courtNumber)) return "#94a3b8";
  const index = ((Math.trunc(courtNumber) - 1) % COURT_BADGE_COLORS.length + COURT_BADGE_COLORS.length) % COURT_BADGE_COLORS.length;
  return COURT_BADGE_COLORS[index];
}

/** Short relative time, e.g. "now", "3m", "2h", "1d". */
export function relativeTime(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diff = Math.max(0, nowMs - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return "now";
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}
