import type { BROADCAST_EXPECTATIONS, ControlPlaneSnapshot, HealthState, YouTubeCourtSnapshot, YouTubeMonitorSnapshot } from "./contracts.js";

type YouTubeConfig = {
  apiKey: string | null;
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  intervalMs: number;
};

type AccessToken = { value: string; expiresAtMs: number };

export class YouTubeCollector {
  private accessToken: AccessToken | null = null;
  private last: YouTubeMonitorSnapshot | null = null;
  private lastAttemptAtMs = 0;

  constructor(private readonly config: YouTubeConfig) {}

  async refresh(controlPlane: ControlPlaneSnapshot | null, nowMs = Date.now()): Promise<YouTubeMonitorSnapshot> {
    if (this.last && nowMs - this.lastAttemptAtMs < this.config.intervalMs) return this.last;
    this.lastAttemptAtMs = nowMs;
    const targets = (controlPlane?.courts ?? []).filter((court) => court.expectation.broadcastExpectation !== "OFF");
    if (targets.length === 0) {
      this.last = { observedAt: new Date(nowMs).toISOString(), apiState: "NOT_APPLICABLE", courts: [] };
      return this.last;
    }

    const withVideo = targets.filter((court) => court.youtubeVideoId);
    const missing = targets.filter((court) => !court.youtubeVideoId).map((court) => ({
      ...unknownCourt(court.courtNumber, null, nowMs, "video-id-missing"),
      state: court.expectation.broadcastExpectation === "LIVE" ? "CRITICAL" as const : "DEGRADED" as const
    }));
    if (withVideo.length === 0) {
      this.last = { observedAt: new Date(nowMs).toISOString(), apiState: "UNKNOWN", courts: missing };
      return this.last;
    }

    try {
      const token = await this.authorizedToken(nowMs);
      const videoIds = withVideo.map((court) => court.youtubeVideoId as string);
      const videos = await this.listVideos(videoIds, token);
      const broadcastAndStreams = token ? await this.listBroadcastHealth(videoIds, token) : null;
      const videoById = new Map(videos.map((row) => [string(row.id), row]));
      const courts = withVideo.map((court) => assessCourt(
        court.courtNumber,
        court.youtubeVideoId as string,
        videoById.get(court.youtubeVideoId as string) ?? null,
        broadcastAndStreams,
        court.expectation.broadcastExpectation,
        nowMs
      ));
      this.last = {
        observedAt: new Date(nowMs).toISOString(),
        apiState: "HEALTHY",
        courts: [...courts, ...missing].sort((left, right) => left.courtNumber - right.courtNumber)
      };
      return this.last;
    } catch {
      this.last = {
        observedAt: new Date(nowMs).toISOString(),
        apiState: "UNKNOWN",
        courts: [...withVideo.map((court) => unknownCourt(court.courtNumber, court.youtubeVideoId, nowMs, "provider-unavailable")), ...missing]
      };
      return this.last;
    }
  }

  current(): YouTubeMonitorSnapshot | null {
    return this.last;
  }

  private async authorizedToken(nowMs: number): Promise<string | null> {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) return null;
    if (this.accessToken && this.accessToken.expiresAtMs - nowMs > 60_000) return this.accessToken.value;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
      grant_type: "refresh_token"
    });
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error("YouTube token refresh failed.");
    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string") throw new Error("YouTube token missing.");
    this.accessToken = {
      value: payload.access_token,
      expiresAtMs: nowMs + Math.max(300, Number(payload.expires_in) || 3_600) * 1_000
    };
    return this.accessToken.value;
  }

  private async listVideos(videoIds: string[], token: string | null): Promise<Record<string, unknown>[]> {
    if (!token && !this.config.apiKey) throw new Error("YouTube monitoring is not configured.");
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "id,status,liveStreamingDetails");
    url.searchParams.set("id", videoIds.slice(0, 50).join(","));
    if (!token && this.config.apiKey) url.searchParams.set("key", this.config.apiKey);
    return youtubeItems(url, token);
  }

  private async listBroadcastHealth(videoIds: string[], token: string) {
    const broadcastsUrl = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
    broadcastsUrl.searchParams.set("part", "id,status,contentDetails");
    broadcastsUrl.searchParams.set("id", videoIds.slice(0, 50).join(","));
    const broadcasts = await youtubeItems(broadcastsUrl, token);
    const streamIds = broadcasts
      .map((broadcast) => string(record(broadcast.contentDetails)?.boundStreamId))
      .filter((value): value is string => Boolean(value));
    if (streamIds.length === 0) return { broadcasts, streams: [] };

    const streamsUrl = new URL("https://www.googleapis.com/youtube/v3/liveStreams");
    streamsUrl.searchParams.set("part", "id,status");
    streamsUrl.searchParams.set("id", [...new Set(streamIds)].slice(0, 50).join(","));
    const streams = await youtubeItems(streamsUrl, token);
    return { broadcasts, streams };
  }
}

async function youtubeItems(url: URL, token: string | null): Promise<Record<string, unknown>[]> {
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`YouTube API returned ${response.status}.`);
  const payload = await response.json() as { items?: unknown };
  return Array.isArray(payload.items) ? payload.items.filter(record) : [];
}

function assessCourt(
  courtNumber: number,
  videoId: string,
  video: Record<string, unknown> | null,
  owned: { broadcasts: Record<string, unknown>[]; streams: Record<string, unknown>[] } | null,
  expectation: typeof BROADCAST_EXPECTATIONS[number],
  nowMs: number
): YouTubeCourtSnapshot {
  const broadcast = owned?.broadcasts.find((row) => string(row.id) === videoId) ?? null;
  const broadcastStatus = record(broadcast?.status);
  const contentDetails = record(broadcast?.contentDetails);
  const boundStreamId = string(contentDetails?.boundStreamId);
  const stream = boundStreamId ? owned?.streams.find((row) => string(row.id) === boundStreamId) ?? null : null;
  const streamStatus = record(stream?.status);
  const health = record(streamStatus?.healthStatus);
  const issues = Array.isArray(health?.configurationIssues)
    ? health.configurationIssues.map((issue) => string(record(issue)?.type)).filter((value): value is string => Boolean(value)).slice(0, 20)
    : [];
  const lifecycle = string(broadcastStatus?.lifeCycleStatus);
  const healthStatus = string(health?.status);
  const streamState = string(streamStatus?.streamStatus);
  const derivedIssues = [
    !video ? "video-not-found" : null,
    !broadcast ? "broadcast-not-found" : null,
    broadcast && !boundStreamId ? "bound-stream-missing" : null,
    boundStreamId && !stream ? "bound-stream-not-found" : null,
    expectation === "LIVE" && lifecycle !== "live" ? "broadcast-not-live" : null,
    expectation === "LIVE" && streamState !== "active" ? "stream-not-active" : null
  ].filter((value): value is string => Boolean(value));
  const configurationIssues = [...new Set([...derivedIssues, ...issues])].slice(0, 20);
  const hardFailure = ["bad", "noData", "revoked"].includes(healthStatus ?? "")
    || streamState === "error"
    || (expectation === "LIVE" && derivedIssues.length > 0);
  // YouTube can report informational issues while health remains "good"; only
  // "ok" and "bad" represent warning- and error-level provider health.
  const degraded = !hardFailure && (derivedIssues.length > 0 || healthStatus === "ok");
  const knownHealthy = healthStatus === "good" && (expectation !== "LIVE" || (lifecycle === "live" && streamState === "active"));
  const state: HealthState = hardFailure ? "CRITICAL" : degraded ? "DEGRADED" : knownHealthy ? "HEALTHY" : "UNKNOWN";
  return {
    courtNumber,
    videoId,
    state,
    broadcastLifecycle: lifecycle,
    streamStatus: streamState,
    healthStatus,
    configurationIssues,
    observedAt: new Date(nowMs).toISOString()
  };
}

function unknownCourt(courtNumber: number, videoId: string | null, nowMs: number, issue: string): YouTubeCourtSnapshot {
  return {
    courtNumber,
    videoId,
    state: "UNKNOWN",
    broadcastLifecycle: null,
    streamStatus: null,
    healthStatus: null,
    configurationIssues: [issue],
    observedAt: new Date(nowMs).toISOString()
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

export { assessCourt as assessYouTubeCourt };
