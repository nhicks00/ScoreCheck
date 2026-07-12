export type AppEnv = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  adminSecret: string;
  publicSiteUrl: string;
  /** @deprecated Not the source of event identity. The DB-active event
   * (getActiveEvent / selectActiveEvent) decides the current event. Retained
   * only for seed tooling and setup export. */
  defaultEventSlug: string;
  /** @deprecated Not the source of event identity — see defaultEventSlug. */
  eventName: string;
  courtCount: number;
  timezone: string;
  mediamtxWhepBaseUrl: string;
  mediamtxHlsBaseUrl: string;
  mediamtxReadUser: string;
  mediamtxReadPass: string;
  mediamtxRtmpIngestBase: string;
  /** YouTube Data API v3 key — used for the live-chat monitor reader when
   * OAuth is not configured. Works for reading PUBLIC live chats. */
  youtubeApiKey: string;
  /** YouTube OAuth client id — preferred over the API key when the full
   * clientId/clientSecret/refreshToken trio is present. */
  youtubeClientId: string;
  youtubeClientSecret: string;
  youtubeRefreshToken: string;
  /** Master switch for the worker's live-chat polling. Off by default so the
   * feature is inert (no quota spend) until an operator opts in. */
  youtubeChatEnabled: boolean;
  livekitCommentaryUrl: string;
};

export function getEnv(): AppEnv {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    adminSecret: process.env.ADMIN_SECRET ?? "",
    publicSiteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
    // Deprecated for event identity (see AppEnv). The DB-active event is the
    // single source of truth; these remain only for seed/setup tooling.
    defaultEventSlug: process.env.NEXT_PUBLIC_DEFAULT_EVENT_SLUG ?? "avp-denver",
    eventName: process.env.NEXT_PUBLIC_EVENT_NAME ?? "AVP Denver Open",
    courtCount: numberEnv("NEXT_PUBLIC_COURT_COUNT", 8),
    timezone: process.env.NEXT_PUBLIC_DEFAULT_TIMEZONE ?? "America/Denver",
    mediamtxWhepBaseUrl: process.env.MEDIAMTX_WHEP_BASE_URL ?? "",
    mediamtxHlsBaseUrl: process.env.MEDIAMTX_HLS_BASE_URL ?? "",
    mediamtxReadUser: process.env.MEDIAMTX_READ_USER ?? "",
    mediamtxReadPass: process.env.MEDIAMTX_READ_PASS ?? "",
    mediamtxRtmpIngestBase: process.env.MEDIAMTX_RTMP_INGEST_BASE ?? "",
    youtubeApiKey: process.env.YOUTUBE_API_KEY ?? "",
    youtubeClientId: process.env.YOUTUBE_CLIENT_ID ?? "",
    youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET ?? "",
    youtubeRefreshToken: process.env.YOUTUBE_REFRESH_TOKEN ?? "",
    youtubeChatEnabled: boolEnv("YOUTUBE_CHAT_ENABLED", false),
    livekitCommentaryUrl: process.env.NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL ?? ""
  };
}

export function missingEnvKeys(): string[] {
  const env = getEnv();
  return [
    ["NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.supabaseAnonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey],
    ["ADMIN_SECRET", env.adminSecret]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

export function assertConfigured(): AppEnv {
  const missing = missingEnvKeys();
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return getEnv();
}

export function assertSupabaseConfigured(): AppEnv {
  const env = getEnv();
  const missing = [
    ["NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.supabaseAnonKey],
    ["SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey]
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Missing required Supabase environment variables: ${missing.join(", ")}`);
  }
  return env;
}

export function publicOrigin(fallbackOrigin?: string): string {
  const configured = getEnv().publicSiteUrl.trim().replace(/\/$/, "");
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      if (configured.includes(".")) {
        try {
          return new URL(`https://${configured}`).origin;
        } catch {
          // Fall through to request origin/default.
        }
      }
    }
  }
  return (fallbackOrigin || "http://localhost:3000").replace(/\/$/, "");
}

export function requestOrigin(origin?: string | null): string {
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      // Fall through to configured public origin.
    }
  }
  return publicOrigin();
}

export function videoMissingEnvKeys(): string[] {
  const env = getEnv();
  if (env.mediamtxWhepBaseUrl || env.mediamtxHlsBaseUrl) return [];
  return ["MEDIAMTX_WHEP_BASE_URL", "MEDIAMTX_HLS_BASE_URL"];
}

function numberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  console.warn(`Invalid numeric value for ${key}: ${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw == null || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
