export type VblSourceScopedMatch = {
  source_type?: "vbl" | "manual" | null;
  bracket_url?: unknown;
};

export function normalizeVblSourceUrl(value: unknown) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    return stripTrailingSlash(url.toString());
  } catch {
    return stripTrailingSlash(raw);
  }
}

export function buildActiveVblSourceSet(values: unknown[]) {
  return new Set(values.map(normalizeVblSourceUrl).filter((value): value is string => Boolean(value)));
}

export function matchBelongsToActiveVblSource(match: VblSourceScopedMatch | null | undefined, activeSourceUrls: Set<string>) {
  if (!activeSourceUrls.size) return true;
  if (!match) return false;
  if (match.source_type !== "vbl") return true;
  const sourceUrl = normalizeVblSourceUrl(match.bracket_url);
  return Boolean(sourceUrl && activeSourceUrls.has(sourceUrl));
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}
