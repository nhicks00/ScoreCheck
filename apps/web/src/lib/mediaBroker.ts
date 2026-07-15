import { getEnv } from "./env";
import { CommunityWitnessError } from "./communityWitness";

const MAX_SDP_BYTES = 128 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const PREVIEW_PATH_PATTERN = /^court([1-9][0-9]*)_preview$/;

export type CommunityMediaUpstreamConfig = {
  baseUrl: URL;
  authorization: string;
};

export type CommunityMediaBrokerConfig = CommunityMediaUpstreamConfig & {
  maxPerCourt: number;
  maxTotal: number;
};

export type WhepOfferResult = {
  answerSdp: string;
  upstreamResourceUrl: string;
  upstreamAffinityCookie: string | null;
};

export class CommunityMediaOpenedResourceError extends CommunityWitnessError {
  readonly openedResource: Pick<WhepOfferResult, "upstreamResourceUrl" | "upstreamAffinityCookie">;

  constructor(
    error: CommunityWitnessError,
    openedResource: Pick<WhepOfferResult, "upstreamResourceUrl" | "upstreamAffinityCookie">
  ) {
    super(error.message, error.status, error.code);
    this.name = "CommunityMediaOpenedResourceError";
    this.openedResource = openedResource;
  }
}

export function communityMediaBrokerConfig(): CommunityMediaBrokerConfig {
  const upstream = communityMediaUpstreamConfig();
  const env = getEnv();
  const originHostname = configuredHostname(env.mediamtxWhepBaseUrl);
  if (!originHostname || originHostname === upstream.baseUrl.hostname.toLowerCase()) {
    throw new CommunityWitnessError(
      "Community video edge must be verifiably isolated from the MediaMTX origin",
      503,
      "MEDIA_NOT_CONFIGURED"
    );
  }
  if (env.communityMediaMaxPerCourt < 1
    || env.communityMediaMaxTotal < 1
    || env.communityMediaMaxPerCourt > env.communityMediaMaxTotal) {
    throw new CommunityWitnessError("Community video capacity is not configured", 503, "MEDIA_CAPACITY_NOT_CONFIGURED");
  }

  return {
    ...upstream,
    maxPerCourt: env.communityMediaMaxPerCourt,
    maxTotal: env.communityMediaMaxTotal
  };
}

export function communityMediaUpstreamConfig(): CommunityMediaUpstreamConfig {
  const env = getEnv();
  const base = env.communityMediaWhepBaseUrl.trim().replace(/\/+$/, "");
  const readUser = env.communityMediaReadUser.trim();
  if (!base || !readUser || !env.communityMediaReadPass.trim()) {
    throw new CommunityWitnessError("Community video is not configured", 503, "MEDIA_NOT_CONFIGURED");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    throw new CommunityWitnessError("Community video edge URL is invalid", 503, "MEDIA_NOT_CONFIGURED");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname);
  if (baseUrl.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && loopback)) {
    throw new CommunityWitnessError("Community video edge must use HTTPS", 503, "MEDIA_NOT_CONFIGURED");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new CommunityWitnessError("Community video edge URL must not contain credentials or parameters", 503, "MEDIA_NOT_CONFIGURED");
  }
  return {
    baseUrl,
    authorization: `Basic ${Buffer.from(`${readUser}:${env.communityMediaReadPass}`, "utf8").toString("base64")}`
  };
}

export function normalizeCommunityPreviewPath(courtNumber: number, configuredPath?: string | null): string {
  const fallback = `court${courtNumber}_preview`;
  const path = (configuredPath?.trim() || fallback).replace(/^\/+|\/+$/g, "");
  const match = PREVIEW_PATH_PATTERN.exec(path);
  if (!Number.isInteger(courtNumber) || courtNumber < 1 || !match || Number(match[1]) !== courtNumber) {
    throw new CommunityWitnessError("Community preview path is not permitted", 503, "MEDIA_PATH_NOT_PERMITTED");
  }
  return path;
}

export function communityWhepOfferUrl(config: CommunityMediaUpstreamConfig, previewPath: string): URL {
  if (!PREVIEW_PATH_PATTERN.test(previewPath)) {
    throw new CommunityWitnessError("Community preview path is not permitted", 503, "MEDIA_PATH_NOT_PERMITTED");
  }
  const basePath = config.baseUrl.pathname.replace(/\/+$/, "");
  const url = new URL(config.baseUrl);
  url.pathname = `${basePath}/${previewPath}/whep`.replace(/\/{2,}/g, "/");
  return url;
}

export function validateCommunityRequestOrigin(requestUrl: string, origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

export async function readBoundedSdp(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/sdp") {
    throw new CommunityWitnessError("WHEP requires application/sdp", 415, "INVALID_MEDIA_TYPE");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SDP_BYTES) {
    throw new CommunityWitnessError("WHEP offer is too large", 413, "MEDIA_BODY_TOO_LARGE");
  }
  const sdp = await readBoundedText(request.body, MAX_SDP_BYTES, () => (
    new CommunityWitnessError("WHEP offer is empty or too large", 413, "MEDIA_BODY_TOO_LARGE")
  ));
  if (!sdp.trim()) {
    throw new CommunityWitnessError("WHEP offer is empty or too large", 413, "MEDIA_BODY_TOO_LARGE");
  }
  return sdp;
}

export async function openUpstreamWhep(input: {
  config: CommunityMediaUpstreamConfig;
  previewPath: string;
  offerSdp: string;
}): Promise<WhepOfferResult> {
  const offerUrl = communityWhepOfferUrl(input.config, input.previewPath);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(offerUrl, {
      method: "POST",
      headers: {
        authorization: input.config.authorization,
        "content-type": "application/sdp"
      },
      body: input.offerSdp,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    });
    if (response.status !== 201) {
      throw new CommunityWitnessError("Community video edge did not admit playback", response.status === 429 ? 429 : 502, "MEDIA_UPSTREAM_REJECTED");
    }
    const location = response.headers.get("location");
    const upstreamResourceUrl = validateUpstreamResourceUrl(location, offerUrl, input.config);
    let upstreamAffinityCookie: string | null = null;
    try {
      upstreamAffinityCookie = affinityCookie(response.headers.get("set-cookie"));
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SDP_BYTES) {
        throw new CommunityWitnessError("Community video edge returned an invalid answer", 502, "MEDIA_UPSTREAM_INVALID");
      }
      const answerSdp = await readBoundedText(response.body, MAX_SDP_BYTES, () => (
        new CommunityWitnessError("Community video edge returned an invalid answer", 502, "MEDIA_UPSTREAM_INVALID")
      ));
      if (!answerSdp.trim()) {
        throw new CommunityWitnessError("Community video edge returned an invalid answer", 502, "MEDIA_UPSTREAM_INVALID");
      }
      return { answerSdp, upstreamResourceUrl, upstreamAffinityCookie };
    } catch (error) {
      const normalized = error instanceof CommunityWitnessError
        ? error
        : new CommunityWitnessError("Community video edge returned an invalid answer", 502, "MEDIA_UPSTREAM_INVALID");
      throw new CommunityMediaOpenedResourceError(normalized, {
        upstreamResourceUrl,
        upstreamAffinityCookie
      });
    }
  } catch (error) {
    if (error instanceof CommunityWitnessError) throw error;
    throw new CommunityWitnessError("Community video edge could not be reached", 502, "MEDIA_UPSTREAM_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
}

export async function releaseUpstreamWhepResource(input: {
  config: CommunityMediaUpstreamConfig;
  upstreamResourceUrl: string | null;
  upstreamAffinityCookie: string | null;
}): Promise<void> {
  if (!input.upstreamResourceUrl) return;
  const resourceUrl = validateStoredUpstreamResourceUrl(input.upstreamResourceUrl, input.config);
  const headers: Record<string, string> = { authorization: input.config.authorization };
  if (input.upstreamAffinityCookie) headers.cookie = validateStoredAffinityCookie(input.upstreamAffinityCookie);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(resourceUrl, {
      method: "DELETE",
      headers,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal
    });
    if (![200, 204, 404, 410].includes(response.status)) {
      throw new CommunityWitnessError("Community video resource cleanup failed", 502, "MEDIA_CLEANUP_FAILED");
    }
  } catch (error) {
    if (error instanceof CommunityWitnessError) throw error;
    throw new CommunityWitnessError("Community video resource cleanup failed", 502, "MEDIA_CLEANUP_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

function validateUpstreamResourceUrl(
  location: string | null,
  requestUrl: URL,
  config: CommunityMediaUpstreamConfig
): string {
  if (!location || location.length > 4096 || /[\r\n]/.test(location)) {
    throw new CommunityWitnessError("Community video edge returned an invalid resource", 502, "MEDIA_UPSTREAM_INVALID");
  }
  let resource: URL;
  try {
    resource = new URL(location, requestUrl);
  } catch {
    throw new CommunityWitnessError("Community video edge returned an invalid resource", 502, "MEDIA_UPSTREAM_INVALID");
  }
  if (resource.origin !== config.baseUrl.origin
    || resource.username
    || resource.password
    || resource.search
    || resource.hash) {
    throw new CommunityWitnessError("Community video edge returned an unsafe resource", 502, "MEDIA_UPSTREAM_INVALID");
  }
  const offerPath = requestUrl.pathname.replace(/\/+$/, "");
  const relativePath = resource.pathname.slice(offerPath.length + 1);
  if (!resource.pathname.startsWith(`${offerPath}/`)
    || !/^[A-Za-z0-9._~-]+$/.test(relativePath)) {
    throw new CommunityWitnessError("Community video edge returned an out-of-scope resource", 502, "MEDIA_UPSTREAM_INVALID");
  }
  return resource.toString();
}

function validateStoredUpstreamResourceUrl(
  location: string,
  config: CommunityMediaUpstreamConfig
): string {
  if (location.length > 4096 || /[\r\n]/.test(location)) {
    throw new CommunityWitnessError("Community video edge returned an invalid resource", 502, "MEDIA_UPSTREAM_INVALID");
  }
  let resource: URL;
  try {
    resource = new URL(location);
  } catch {
    throw new CommunityWitnessError("Community video edge returned an invalid resource", 502, "MEDIA_UPSTREAM_INVALID");
  }
  if (resource.origin !== config.baseUrl.origin
    || resource.username
    || resource.password
    || resource.search
    || resource.hash) {
    throw new CommunityWitnessError("Community video edge returned an unsafe resource", 502, "MEDIA_UPSTREAM_INVALID");
  }
  const basePath = config.baseUrl.pathname.replace(/\/+$/, "");
  const relativePath = resource.pathname.slice(basePath.length).replace(/^\/+/, "");
  if (!resource.pathname.startsWith(`${basePath}/`)
    || !/^court[1-9][0-9]*_preview\/whep\/[A-Za-z0-9._~-]+$/.test(relativePath)) {
    throw new CommunityWitnessError("Community video edge returned an out-of-scope resource", 502, "MEDIA_UPSTREAM_INVALID");
  }
  return resource.toString();
}

function configuredHostname(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function affinityCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const pair = setCookie.split(";", 1)[0]?.trim() ?? "";
  return pair ? validateStoredAffinityCookie(pair) : null;
}

function validateStoredAffinityCookie(value: string): string {
  if (value.length > 2048 || /[\r\n;,]/.test(value) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\s;]+$/.test(value)) {
    throw new CommunityWitnessError("Community video edge returned an invalid affinity cookie", 502, "MEDIA_UPSTREAM_INVALID");
  }
  return value;
}

async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  invalid: () => CommunityWitnessError
): Promise<string> {
  if (!body) throw invalid();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw invalid();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
