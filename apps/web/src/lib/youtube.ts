const CODE_PATTERN = /\bC\s*([1-8])\s*[- ]\s*([0-9]{3})\b/i;

export function normalizeVerificationCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length > 40) return null;
  const match = trimmed.match(CODE_PATTERN);
  if (!match) return null;
  const normalized = `C${match[1]}-${match[2]}`.toUpperCase();
  const withoutCode = trimmed.replace(match[0], "").trim();
  return withoutCode.length <= 4 ? normalized : null;
}

export function extractCourtNumberFromCode(code: string | null | undefined): number | null {
  const normalized = normalizeVerificationCode(code);
  if (!normalized) return null;
  const value = Number(normalized.slice(1, normalized.indexOf("-")));
  return Number.isInteger(value) && value >= 1 && value <= 8 ? value : null;
}

export function youtubeAuthorToProfile(authorDetails: Record<string, unknown> | null | undefined) {
  return {
    youtube_channel_id: text(authorDetails?.channelId),
    youtube_display_name: text(authorDetails?.displayName),
    youtube_profile_image_url: text(authorDetails?.profileImageUrl),
    youtube_author_details: authorDetails ?? {}
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
