export type MatchScopedRecord = { match_id?: string | null };

/**
 * Returns only the row scoped to the current match. An idle court must never
 * fall back to an arbitrary historical score row.
 */
export function recordForCurrentMatch<T extends MatchScopedRecord>(
  value: T | T[] | null | undefined,
  matchId: string | null | undefined
): T | null {
  if (!matchId) return null;
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.find((row) => row.match_id === matchId) ?? null;
}
