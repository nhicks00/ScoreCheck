import { setTimeout as delay } from "node:timers/promises";

const API = "https://www.googleapis.com/youtube/v3";
const OAUTH = "https://oauth2.googleapis.com/token";
const COURT_RANGE = new Set(Array.from({ length: 8 }, (_, index) => index + 1));
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRequestsExceedRateLimit"]);
const RATE_LIMIT_DELAYS_MS = [
  5_000, 10_000, 20_000, 40_000, 80_000, 120_000,
  180_000, 240_000, 300_000, 300_000, 300_000, 300_000
];

export class YouTubeRehearsalProvider {
  constructor({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch, sleep = delay }) {
    this.clientId = requiredCredential(clientId, "YouTube client id");
    this.clientSecret = requiredCredential(clientSecret, "YouTube client secret");
    this.refreshToken = requiredCredential(refreshToken, "YouTube refresh token");
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.accessToken = null;
  }

  async resolvePersistentStreamPool() {
    const items = await this.#list("liveStreams", "id,snippet,cdn,status,contentDetails");
    const streams = {};
    for (const court of COURT_RANGE) {
      const title = persistentStreamTitle(court);
      const matches = items.filter((item) => item.snippet?.title === title);
      if (matches.length !== 1) {
        throw new Error(`YouTube must contain exactly one persistent rehearsal stream titled ${title}; observed ${matches.length}`);
      }
      const stream = normalizePersistentStream(matches[0], court);
      if (!new Set(["inactive", "ready"]).has(stream.streamStatus)) {
        throw new Error(`YouTube persistent rehearsal stream for Camera ${court} is not idle (status=${stream.streamStatus ?? "unknown"})`);
      }
      streams[court] = stream;
    }
    const ids = Object.values(streams).map((stream) => stream.id);
    const streamNames = Object.values(streams).map((stream) => stream.streamName);
    if (new Set(ids).size !== 8 || new Set(streamNames).size !== 8) {
      throw new Error("YouTube persistent rehearsal stream identities are not unique");
    }
    return streams;
  }

  async getStream(streamId) {
    validateProviderId(streamId, "stream id");
    const page = await this.#request("GET", `/liveStreams?part=id,snippet,cdn,status,contentDetails&id=${encodeURIComponent(streamId)}`);
    if (!Array.isArray(page.items) || page.items.length !== 1) throw new ProviderNotFoundError("YouTube rehearsal stream was not found");
    return normalizePersistentStream(page.items[0]);
  }

  async waitForStream({ streamId, streamStatus, timeoutMs = 180_000, intervalMs = 2_000 }) {
    validateProviderId(streamId, "stream id");
    if (typeof streamStatus !== "string" || !streamStatus) throw new Error("YouTube rehearsal stream status is required");
    const startedAt = Date.now();
    let last;
    while (Date.now() - startedAt <= timeoutMs) {
      try {
        last = await this.getStream(streamId);
        if (last.streamStatus === streamStatus) return last;
      } catch (error) {
        if (!(error instanceof ProviderNotFoundError)) throw error;
      }
      await this.sleep(intervalMs);
    }
    throw new Error(`YouTube rehearsal stream status did not converge (stream=${last?.streamStatus ?? "unknown"}, expected=${streamStatus})`);
  }

  async #list(resource, part) {
    const items = [];
    let pageToken = null;
    const seen = new Set();
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const suffix = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const page = await this.#request("GET", `/${resource}?part=${part}&mine=true&maxResults=50${suffix}`);
      if (!Array.isArray(page.items)) throw new Error(`YouTube ${resource} response is invalid`);
      items.push(...page.items);
      pageToken = typeof page.nextPageToken === "string" && page.nextPageToken ? page.nextPageToken : null;
      if (!pageToken) return items;
      if (seen.has(pageToken)) throw new Error(`YouTube ${resource} pagination repeated`);
      seen.add(pageToken);
    }
    throw new Error(`YouTube ${resource} pagination exceeded the safety limit`);
  }

  async #request(method, path, body = undefined) {
    for (let attempt = 0; attempt <= RATE_LIMIT_DELAYS_MS.length; attempt += 1) {
      try {
        return await this.#requestOnce(method, path, body);
      } catch (error) {
        if (!(error instanceof ProviderRequestError)
          || !RATE_LIMIT_REASONS.has(error.reason)
          || attempt === RATE_LIMIT_DELAYS_MS.length) throw error;
        await this.sleep(RATE_LIMIT_DELAYS_MS[attempt]);
      }
    }
    throw new Error("YouTube request retry loop exited unexpectedly");
  }

  async #requestOnce(method, path, body = undefined) {
    const token = await this.#token();
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000)
    });
    if (response.status === 404) throw new ProviderNotFoundError("YouTube rehearsal resource was not found");
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const reason = payload.error?.errors?.[0]?.reason ?? payload.error?.status ?? "unknown";
      throw new ProviderRequestError(`YouTube ${method} ${path.split("?")[0]} failed with HTTP ${response.status} (${reason})`, response.status, reason);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async #token() {
    if (this.accessToken) return this.accessToken;
    const response = await this.fetchImpl(OAUTH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token) {
      throw new ProviderRequestError(`YouTube OAuth refresh failed with HTTP ${response.status}`, response.status);
    }
    this.accessToken = payload.access_token;
    return this.accessToken;
  }
}

export function rehearsalMarker(generationId, court) {
  if (typeof generationId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(generationId)) throw new Error("rehearsal generation id is invalid");
  if (!COURT_RANGE.has(court)) throw new Error("rehearsal court is invalid");
  return `[scorecheck-rehearsal:${generationId}:court-${court}]`;
}

function normalizePersistentStream(value, expectedCourt = null) {
  const title = value?.snippet?.title;
  const match = typeof title === "string" ? /^ScoreCheck Court ([1-8]) Test Stream$/.exec(title) : null;
  const court = match ? Number(match[1]) : null;
  if (!value?.id || !court || (expectedCourt !== null && court !== expectedCourt)) {
    throw new Error(`YouTube persistent rehearsal stream identity is invalid${expectedCourt ? ` for Camera ${expectedCourt}` : ""}`);
  }
  if (value.contentDetails?.isReusable !== true || value.cdn?.ingestionType !== "rtmp" || value.cdn?.resolution !== "720p" || value.cdn?.frameRate !== "30fps") {
    throw new Error(`YouTube rehearsal stream profile is invalid${court ? ` for Camera ${court}` : ""}`);
  }
  const ingestion = value.cdn?.ingestionInfo;
  if (typeof ingestion?.streamName !== "string" || !ingestion.streamName || typeof ingestion.rtmpsIngestionAddress !== "string" || !ingestion.rtmpsIngestionAddress.startsWith("rtmps://")) {
    throw new Error(`YouTube rehearsal stream ingestion identity is invalid${court ? ` for Camera ${court}` : ""}`);
  }
  return {
    id: String(value.id),
    court,
    title,
    isReusable: true,
    streamName: ingestion.streamName,
    rtmpsIngestionAddress: ingestion.rtmpsIngestionAddress,
    streamStatus: value.status?.streamStatus ?? null,
    healthStatus: value.status?.healthStatus?.status ?? null,
    configurationIssues: (value.status?.healthStatus?.configurationIssues ?? []).map((entry) => entry.type).filter(Boolean)
  };
}

export function persistentStreamTitle(court) {
  if (!COURT_RANGE.has(court)) throw new Error("YouTube rehearsal court is invalid");
  return `ScoreCheck Court ${court} Test Stream`;
}

function validateProviderId(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{3,100}$/.test(value)) throw new Error(`YouTube ${label} is invalid`);
}

function requiredCredential(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${label} is required`);
  return value.trim();
}

export class ProviderNotFoundError extends Error {
  constructor(message) { super(message); this.status = 404; }
}

export class ProviderRequestError extends Error {
  constructor(message, status, reason = "unknown") { super(message); this.status = status; this.reason = reason; }
}
