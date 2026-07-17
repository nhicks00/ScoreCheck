import { setTimeout as delay } from "node:timers/promises";

const API = "https://www.googleapis.com/youtube/v3";
const OAUTH = "https://oauth2.googleapis.com/token";
const COURT_RANGE = new Set(Array.from({ length: 8 }, (_, index) => index + 1));
const MARKER = /^\[scorecheck-rehearsal:[a-zA-Z0-9-]{8,80}:court-[1-8]\]$/;
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRequestsExceedRateLimit"]);
const RATE_LIMIT_DELAYS_MS = [
  5_000, 10_000, 20_000, 40_000, 80_000, 120_000,
  180_000, 240_000, 300_000, 300_000, 300_000, 300_000
];

export class YouTubeRehearsalProvider {
  constructor({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch, now = () => new Date(), sleep = delay }) {
    this.clientId = requiredCredential(clientId, "YouTube client id");
    this.clientSecret = requiredCredential(clientSecret, "YouTube client secret");
    this.refreshToken = requiredCredential(refreshToken, "YouTube refresh token");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.accessToken = null;
  }

  async ensureStream({ court, marker }) {
    validateCourtMarker(court, marker);
    const existing = await this.findStream({ court, marker });
    const stream = existing ?? await this.#request("POST", "/liveStreams?part=id,snippet,cdn,status,contentDetails", {
      snippet: { title: `ScoreCheck TEST ${marker}`, description: marker },
      cdn: { ingestionType: "rtmp", resolution: "720p", frameRate: "30fps" },
      contentDetails: { isReusable: false }
    });
    return existing ?? normalizeStream(stream, court, marker);
  }

  async ensureBroadcast({ court, marker }) {
    validateCourtMarker(court, marker);
    const existing = await this.findBroadcast({ court, marker });
    const scheduledStartTime = new Date(this.now().getTime() + 10 * 60_000).toISOString();
    const broadcast = existing ?? await this.#request("POST", "/liveBroadcasts?part=id,snippet,status,contentDetails", {
      snippet: { title: `ScoreCheck TEST ${marker}`, description: marker, scheduledStartTime },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
      contentDetails: {
        monitorStream: { enableMonitorStream: false },
        enableEmbed: true,
        enableDvr: true,
        recordFromStart: true,
        latencyPreference: "low",
        enableAutoStart: false,
        enableAutoStop: false
      }
    });
    return existing ?? normalizeBroadcast(broadcast, court, marker);
  }

  async findStream({ court, marker }) {
    validateCourtMarker(court, marker);
    const matches = (await this.#list("liveStreams", "id,snippet,cdn,status,contentDetails")).filter((item) => item.snippet?.description === marker);
    if (matches.length > 1) throw new Error(`YouTube returned multiple rehearsal streams for Camera ${court}`);
    return matches.length ? normalizeStream(matches[0], court, marker) : null;
  }

  async findBroadcast({ court, marker }) {
    validateCourtMarker(court, marker);
    const matches = (await this.#list("liveBroadcasts", "id,snippet,status,contentDetails")).filter((item) => item.snippet?.description === marker);
    if (matches.length > 1) throw new Error(`YouTube returned multiple rehearsal broadcasts for Camera ${court}`);
    return matches.length ? normalizeBroadcast(matches[0], court, marker) : null;
  }

  async bind({ broadcastId, streamId }) {
    validateProviderId(broadcastId, "broadcast id");
    validateProviderId(streamId, "stream id");
    await this.#request("POST", `/liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}&part=id,contentDetails`);
    return this.#waitForProviderRead({
      read: () => this.getBroadcast(broadcastId),
      accepted: (current) => current.boundStreamId === streamId,
      description: "YouTube rehearsal broadcast did not retain its exact stream binding"
    });
  }

  async getStream(streamId) {
    validateProviderId(streamId, "stream id");
    const page = await this.#request("GET", `/liveStreams?part=id,snippet,cdn,status,contentDetails&id=${encodeURIComponent(streamId)}`);
    if (!Array.isArray(page.items) || page.items.length !== 1) throw new ProviderNotFoundError("YouTube rehearsal stream was not found");
    return normalizeStream(page.items[0], null, null, { allowAnyMarker: true });
  }

  async getBroadcast(broadcastId) {
    validateProviderId(broadcastId, "broadcast id");
    const page = await this.#request("GET", `/liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(broadcastId)}`);
    if (!Array.isArray(page.items) || page.items.length !== 1) throw new ProviderNotFoundError("YouTube rehearsal broadcast was not found");
    return normalizeBroadcast(page.items[0], null, null, { allowAnyMarker: true });
  }

  async transition(broadcastId, status) {
    validateProviderId(broadcastId, "broadcast id");
    if (!new Set(["testing", "live", "complete"]).has(status)) throw new Error("YouTube rehearsal transition status is invalid");
    const value = await this.#request("POST", `/liveBroadcasts/transition?broadcastStatus=${status}&id=${encodeURIComponent(broadcastId)}&part=id,status,contentDetails,snippet`);
    return normalizeBroadcast(value, null, null, { allowAnyMarker: true });
  }

  async waitFor({ streamId, broadcastId, streamStatus, broadcastStatus, timeoutMs = 180_000, intervalMs = 2_000 }) {
    const startedAt = Date.now();
    let last;
    while (Date.now() - startedAt <= timeoutMs) {
      try {
        const [stream, broadcast] = await Promise.all([this.getStream(streamId), this.getBroadcast(broadcastId)]);
        last = { stream, broadcast };
        if ((!streamStatus || stream.streamStatus === streamStatus) && (!broadcastStatus || broadcast.lifecycleStatus === broadcastStatus)) return last;
      } catch (error) {
        if (!(error instanceof ProviderNotFoundError)) throw error;
      }
      await this.sleep(intervalMs);
    }
    throw new Error(`YouTube rehearsal status did not converge (stream=${last?.stream.streamStatus ?? "unknown"}, broadcast=${last?.broadcast.lifecycleStatus ?? "unknown"})`);
  }

  async #waitForProviderRead({ read, accepted, description, attempts = 30, intervalMs = 1_000 }) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const current = await read();
        if (accepted(current)) return current;
      } catch (error) {
        if (!(error instanceof ProviderNotFoundError)) throw error;
      }
      if (attempt < attempts) await this.sleep(intervalMs);
    }
    throw new Error(`${description} after ${attempts} bounded checks`);
  }

  async deleteBroadcast(broadcastId) {
    return this.#delete(`/liveBroadcasts?id=${encodeURIComponent(broadcastId)}`);
  }

  async deleteStream(streamId) {
    return this.#delete(`/liveStreams?id=${encodeURIComponent(streamId)}`);
  }

  async #delete(path) {
    try {
      await this.#request("DELETE", path);
      return { absent: true };
    } catch (error) {
      if (error instanceof ProviderNotFoundError) return { absent: true };
      throw error;
    }
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

function normalizeStream(value, court, marker, { allowAnyMarker = false } = {}) {
  const description = value?.snippet?.description;
  if (!value?.id || typeof description !== "string" || (!allowAnyMarker && description !== marker) || (allowAnyMarker && !MARKER.test(description))) {
    throw new Error(`YouTube rehearsal stream identity is invalid${court ? ` for Camera ${court}` : ""}`);
  }
  if (value.contentDetails?.isReusable !== false || value.cdn?.ingestionType !== "rtmp" || value.cdn?.resolution !== "720p" || value.cdn?.frameRate !== "30fps") {
    throw new Error(`YouTube rehearsal stream profile is invalid${court ? ` for Camera ${court}` : ""}`);
  }
  const ingestion = value.cdn?.ingestionInfo;
  if (typeof ingestion?.streamName !== "string" || !ingestion.streamName || typeof ingestion.rtmpsIngestionAddress !== "string" || !ingestion.rtmpsIngestionAddress.startsWith("rtmps://")) {
    throw new Error(`YouTube rehearsal stream ingestion identity is invalid${court ? ` for Camera ${court}` : ""}`);
  }
  return {
    id: String(value.id),
    marker: description,
    streamName: ingestion.streamName,
    rtmpsIngestionAddress: ingestion.rtmpsIngestionAddress,
    streamStatus: value.status?.streamStatus ?? null,
    healthStatus: value.status?.healthStatus?.status ?? null,
    configurationIssues: (value.status?.healthStatus?.configurationIssues ?? []).map((entry) => entry.type).filter(Boolean)
  };
}

function normalizeBroadcast(value, court, marker, { allowAnyMarker = false } = {}) {
  const description = value?.snippet?.description;
  if (!value?.id || typeof description !== "string" || (!allowAnyMarker && description !== marker) || (allowAnyMarker && !MARKER.test(description))) {
    throw new Error(`YouTube rehearsal broadcast identity is invalid${court ? ` for Camera ${court}` : ""}`);
  }
  if (value.status?.privacyStatus !== "unlisted" || value.contentDetails?.enableAutoStart !== false || value.contentDetails?.enableAutoStop !== false || value.contentDetails?.monitorStream?.enableMonitorStream !== false) {
    throw new Error(`YouTube rehearsal broadcast safety settings are invalid${court ? ` for Camera ${court}` : ""}`);
  }
  return {
    id: String(value.id),
    marker: description,
    privacyStatus: value.status.privacyStatus,
    lifecycleStatus: value.status.lifeCycleStatus ?? null,
    recordingStatus: value.status.recordingStatus ?? null,
    boundStreamId: value.contentDetails.boundStreamId ?? null,
    watchUrl: `https://www.youtube.com/watch?v=${value.id}`
  };
}

function validateCourtMarker(court, marker) {
  if (!COURT_RANGE.has(court) || !MARKER.test(marker) || !marker.endsWith(`:court-${court}]`)) throw new Error("YouTube rehearsal court marker is invalid");
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
