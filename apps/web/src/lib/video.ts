import { getEnv } from "./env";

export type StreamSources = {
  whepUrl: string | null;
  hlsUrl: string | null;
};

export function videoConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.mediamtxWhepBaseUrl.trim() || env.mediamtxHlsBaseUrl.trim());
}

export function courtPreviewStreamPath(courtNumber: number, dbPath?: string | null): string {
  const fromDb = normalizePath(dbPath);
  if (fromDb) return fromDb;
  const fromEnv = normalizePath(process.env[`COURT_${courtNumber}_PREVIEW_STREAM_PATH`]);
  if (fromEnv) return fromEnv;
  return `court${courtNumber}_preview`;
}

export function courtRawStreamPath(courtNumber: number): string {
  return `court${courtNumber}_raw`;
}

export function courtProgramStreamPath(courtNumber: number, dbPath?: string | null): string {
  const fromDb = normalizePath(dbPath);
  if (fromDb) return fromDb;
  const fromEnv = normalizePath(process.env[`COURT_${courtNumber}_PROGRAM_STREAM_PATH`]);
  if (fromEnv) return fromEnv;
  return `court${courtNumber}_program`;
}

export function courtStreamSources(path: string): StreamSources {
  const env = getEnv();
  const streamPath = normalizePath(path);
  if (!streamPath) return { whepUrl: null, hlsUrl: null };
  const whepBase = normalizeBase(env.mediamtxWhepBaseUrl);
  const hlsBase = normalizeBase(env.mediamtxHlsBaseUrl);
  return {
    whepUrl: whepBase ? withReadCredentials(`${whepBase}/${streamPath}/whep`) : null,
    hlsUrl: hlsBase ? withReadCredentials(`${hlsBase}/${streamPath}/index.m3u8`) : null
  };
}

function withReadCredentials(url: string): string {
  const env = getEnv();
  if (!env.mediamtxReadUser || !env.mediamtxReadPass) return url;
  const credentials = new URLSearchParams({
    user: env.mediamtxReadUser,
    pass: env.mediamtxReadPass
  });
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${credentials.toString()}`;
}

function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizePath(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^\/+|\/+$/g, "");
}
