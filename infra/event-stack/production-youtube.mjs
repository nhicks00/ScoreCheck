#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { loadProtectedEnv } from "./stack-deployer.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const API = "https://www.googleapis.com/youtube/v3";
const OAUTH = "https://oauth2.googleapis.com/token";
const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRequestsExceedRateLimit"]);
const RATE_LIMIT_DELAYS_MS = Object.freeze([5_000, 10_000, 20_000, 40_000, 80_000, 120_000, 180_000, 240_000, 300_000]);

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const environment = await loadProtectedEnv(options.credentialsEnv);
  const provider = new ProductionYouTubeProvider({
    clientId: required(environment.YOUTUBE_CLIENT_ID, "YouTube client id"),
    clientSecret: required(environment.YOUTUBE_CLIENT_SECRET, "YouTube client secret"),
    refreshToken: required(environment.YOUTUBE_REFRESH_TOKEN, "YouTube refresh token")
  });
  const result = await prepareProductionYouTube({ ...options, provider });
  process.stdout.write(`${JSON.stringify(redactDestinations(result), null, 2)}\n`);
}

export class ProductionYouTubeProvider {
  constructor({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch, sleep = delay, now = () => Date.now() }) {
    this.clientId = required(clientId, "YouTube client id");
    this.clientSecret = required(clientSecret, "YouTube client secret");
    this.refreshToken = required(refreshToken, "YouTube refresh token");
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async ensureVariableStreamPool() {
    const existing = await this.listAll("liveStreams", "id,snippet,cdn,status,contentDetails");
    const streams = {};
    for (const court of COURTS) {
      const title = productionStreamTitle(court);
      const matches = existing.filter((item) => item.snippet?.title === title);
      if (matches.length > 1) throw new Error(`YouTube contains more than one production stream titled ${title}`);
      const value = matches[0] ?? await this.request("POST", "/liveStreams?part=id,snippet,cdn,status,contentDetails", {
        snippet: { title, description: `Reusable ScoreCheck Camera ${court} production stream. Variable profile accepts admitted 1080p30 or 1080p60 output.` },
        cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
        contentDetails: { isReusable: true }
      });
      if (!matches.length) existing.push(value);
      streams[court] = normalizeProductionStream(value, court, { requireIdle: true });
    }
    const ids = Object.values(streams).map((entry) => entry.id);
    const names = Object.values(streams).map((entry) => entry.streamName);
    if (new Set(ids).size !== 8 || new Set(names).size !== 8) throw new Error("production YouTube stream identities are not unique");
    return streams;
  }

  async prepareBroadcast({ event, court, streamId, scheduledStartTime }) {
    validateEvent(event);
    validateCourt(court);
    validateProviderId(streamId, "stream id");
    const title = productionBroadcastTitle(event, court);
    const broadcasts = await this.listAll("liveBroadcasts", "id,snippet,status,contentDetails");
    const matches = broadcasts.filter((item) => item.snippet?.title === title && item.status?.lifeCycleStatus !== "complete");
    if (matches.length > 1) throw new Error(`YouTube contains more than one incomplete production broadcast titled ${title}`);
    const value = matches[0] ?? await this.request("POST", "/liveBroadcasts?part=id,snippet,status,contentDetails", {
      snippet: {
        title,
        description: `Unlisted ScoreCheck production-realistic soak for Camera ${court}.`,
        scheduledStartTime
      },
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
    const broadcast = await this.enforceManualBroadcastLifecycle(value, event, court);
    await this.request("POST", `/liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(streamId)}&part=id,contentDetails`);
    return { ...broadcast, streamId };
  }

  async enforceManualBroadcastLifecycle(value, event = null, court = null) {
    const current = normalizeProductionBroadcast(value, event, court, { allowAutoStart: true });
    if (current.lifeCycleStatus !== "ready") throw new Error(`Camera ${current.court} production YouTube broadcast is not ready for manual lifecycle control`);
    if (current.autoStart === false) return current;
    const contentDetails = {
      ...value.contentDetails,
      monitorStream: { ...value.contentDetails?.monitorStream, enableMonitorStream: false },
      enableAutoStart: false,
      enableAutoStop: false
    };
    const updated = await this.request("PUT", "/liveBroadcasts?part=id,contentDetails", { id: current.id, contentDetails });
    return normalizeProductionBroadcast({ ...value, ...updated, contentDetails: updated?.contentDetails ?? contentDetails }, event, court);
  }

  async enforceManualBroadcastLifecycleById(id) {
    validateProviderId(id, "broadcast id");
    const page = await this.request("GET", `/liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(id)}`);
    if (!Array.isArray(page.items) || page.items.length !== 1) throw new Error("production YouTube broadcast was not found");
    return this.enforceManualBroadcastLifecycle(page.items[0]);
  }

  async getStream(id) {
    validateProviderId(id, "stream id");
    const page = await this.request("GET", `/liveStreams?part=id,snippet,cdn,status,contentDetails&id=${encodeURIComponent(id)}`);
    if (!Array.isArray(page.items) || page.items.length !== 1) throw new Error("production YouTube stream was not found");
    return normalizeProductionStream(page.items[0]);
  }

  async getBroadcast(id) {
    validateProviderId(id, "broadcast id");
    const page = await this.request("GET", `/liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(id)}`);
    if (!Array.isArray(page.items) || page.items.length !== 1) throw new Error("production YouTube broadcast was not found");
    return normalizeProductionBroadcast(page.items[0]);
  }

  async transitionBroadcast(id, status) {
    validateProviderId(id, "broadcast id");
    if (!new Set(["testing", "live", "complete"]).has(status)) throw new Error("YouTube broadcast transition is invalid");
    return this.request("POST", `/liveBroadcasts/transition?id=${encodeURIComponent(id)}&broadcastStatus=${status}&part=id,snippet,status,contentDetails`);
  }

  async listAll(resource, part) {
    const items = [];
    let pageToken = null;
    const seen = new Set();
    for (let page = 0; page < 100; page += 1) {
      const suffix = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const value = await this.request("GET", `/${resource}?part=${part}&mine=true&maxResults=50${suffix}`);
      if (!Array.isArray(value.items)) throw new Error(`YouTube ${resource} response is invalid`);
      items.push(...value.items);
      pageToken = typeof value.nextPageToken === "string" && value.nextPageToken ? value.nextPageToken : null;
      if (!pageToken) return items;
      if (seen.has(pageToken)) throw new Error(`YouTube ${resource} pagination repeated`);
      seen.add(pageToken);
    }
    throw new Error(`YouTube ${resource} pagination exceeded the safety limit`);
  }

  async request(method, path, body = undefined) {
    for (let attempt = 0; attempt <= RATE_LIMIT_DELAYS_MS.length; attempt += 1) {
      try { return await this.requestOnce(method, path, body); }
      catch (error) {
        if (!(error instanceof YouTubeProviderError) || !RATE_LIMIT_REASONS.has(error.reason) || attempt === RATE_LIMIT_DELAYS_MS.length) throw error;
        await this.sleep(RATE_LIMIT_DELAYS_MS[attempt]);
      }
    }
    throw new Error("YouTube request retry loop exited unexpectedly");
  }

  async requestOnce(method, path, body = undefined) {
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000)
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = payload?.error?.errors?.[0]?.reason ?? payload?.error?.status ?? "unknown";
      throw new YouTubeProviderError(`YouTube ${method} ${path.split("?")[0]} failed with HTTP ${response.status} (${reason})`, response.status, reason);
    }
    return payload;
  }

  async token() {
    if (this.accessToken && this.now() + 60_000 < this.accessTokenExpiresAt) return this.accessToken;
    const response = await this.fetchImpl(OAUTH, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: this.refreshToken, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(20_000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token || !Number.isFinite(payload.expires_in) || payload.expires_in <= 60) throw new YouTubeProviderError(`YouTube OAuth refresh failed with HTTP ${response.status}`, response.status);
    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = this.now() + payload.expires_in * 1_000;
    return this.accessToken;
  }
}

export async function prepareProductionYouTube({ provider, event, activeCameras, output, now = () => Date.now() }) {
  validateEvent(event);
  validateActiveCameras(activeCameras);
  const root = normalizedAbsolute(output, "production YouTube output");
  if (await exists(root)) {
    const existing = await readProductionDestinations(join(root, "destinations.json"), { event, activeCameras, allowAutoStart: true });
    let changed = false;
    for (const court of activeCameras) {
      if (existing.broadcasts[court].autoStart === false) continue;
      const broadcast = await provider.enforceManualBroadcastLifecycleById(existing.broadcasts[court].id);
      existing.broadcasts[court] = { ...existing.broadcasts[court], ...broadcast, streamId: existing.streams[court].id };
      changed = true;
    }
    const value = validateProductionDestinations(existing, { event, activeCameras });
    if (changed) await writeDestinationFiles(root, value);
    return value;
  }
  await assertProtectedParent(root);
  const temporary = `${root}.preparing-${process.pid}-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    const streams = await provider.ensureVariableStreamPool();
    const scheduledStartTime = new Date(now() + 10 * 60_000).toISOString();
    const broadcasts = {};
    for (const court of activeCameras) broadcasts[court] = await provider.prepareBroadcast({ event, court, streamId: streams[court].id, scheduledStartTime });
    const value = {
      schemaVersion: 1,
      event,
      createdAt: new Date(now()).toISOString(),
      activeCameras,
      streams,
      broadcasts
    };
    validateProductionDestinations(value, { event, activeCameras });
    await writeDestinationFiles(temporary, value);
    await rename(temporary, root);
    await chmod(root, 0o700);
    return value;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function readProductionDestinations(path, expected = {}) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("production YouTube destinations must be a mode-0600 protected file");
  const value = JSON.parse(await readFile(path, "utf8"));
  return validateProductionDestinations(value, expected);
}

export function validateProductionDestinations(value, { event = value?.event, activeCameras = value?.activeCameras, allowAutoStart = false } = {}) {
  if (!value || value.schemaVersion !== 1 || value.event !== event || !Array.isArray(value.activeCameras)) throw new Error("production YouTube destinations contract is invalid");
  validateEvent(event);
  validateActiveCameras(activeCameras);
  if (JSON.stringify(value.activeCameras) !== JSON.stringify(activeCameras)) throw new Error("production YouTube active camera set changed");
  const streams = COURTS.map((court) => normalizeProductionStream(value.streams?.[court], court, { requireIdle: false }));
  if (new Set(streams.map((stream) => stream.id)).size !== COURTS.length || new Set(streams.map((stream) => stream.streamName)).size !== COURTS.length) {
    throw new Error("production YouTube stream identities are not unique");
  }
  for (const court of activeCameras) {
    const broadcast = normalizeProductionBroadcast(value.broadcasts?.[court], event, court, { allowAutoStart });
    if (broadcast.streamId !== value.streams[court].id) throw new Error(`Camera ${court} broadcast is bound to the wrong production stream`);
  }
  if (Object.keys(value.broadcasts ?? {}).map(Number).some((court) => !activeCameras.includes(court))) throw new Error("production YouTube destinations contain an inactive-camera broadcast");
  return value;
}

async function writeDestinationFiles(root, value) {
  await writeProtectedJson(join(root, "destinations.json"), value);
  await writeProtectedJson(join(root, "destinations.redacted.json"), redactDestinations(value));
}

async function writeProtectedJson(path, value) {
  const temporary = `${path}.writing-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

export function normalizeProductionStream(value, expectedCourt = null, { requireIdle = false } = {}) {
  const title = value?.title ?? value?.snippet?.title;
  const match = typeof title === "string" ? /^ScoreCheck Production Camera ([1-8]) Auto Stream$/.exec(title) : null;
  const court = value?.court ?? (match ? Number(match[1]) : null);
  if (!value?.id || !court || (expectedCourt !== null && court !== expectedCourt) || title !== productionStreamTitle(court)) throw new Error("production YouTube stream identity is invalid");
  const cdn = value.cdn ?? value;
  if ((value.isReusable ?? value.contentDetails?.isReusable) !== true || cdn.ingestionType !== "rtmp" || cdn.resolution !== "variable" || cdn.frameRate !== "variable") throw new Error(`Camera ${court} production YouTube stream is not reusable variable-profile RTMP`);
  const ingestion = cdn.ingestionInfo ?? value;
  const streamName = ingestion.streamName;
  const rtmpsIngestionAddress = ingestion.rtmpsIngestionAddress;
  const rtmpsBackupIngestionAddress = ingestion.rtmpsBackupIngestionAddress;
  if (typeof streamName !== "string" || !streamName
    || typeof rtmpsIngestionAddress !== "string" || !rtmpsIngestionAddress.startsWith("rtmps://")
    || typeof rtmpsBackupIngestionAddress !== "string" || !rtmpsBackupIngestionAddress.startsWith("rtmps://")
    || rtmpsBackupIngestionAddress === rtmpsIngestionAddress) {
    throw new Error(`Camera ${court} production YouTube primary/backup ingestion identity is invalid`);
  }
  const streamStatus = value.streamStatus ?? value.status?.streamStatus ?? null;
  if (requireIdle && !new Set(["inactive", "ready"]).has(streamStatus)) throw new Error(`Camera ${court} production YouTube stream is not idle`);
  return {
    id: String(value.id), court, title, isReusable: true, ingestionType: "rtmp", resolution: "variable", frameRate: "variable",
    streamName, rtmpsIngestionAddress, rtmpsBackupIngestionAddress, streamStatus,
    healthStatus: value.healthStatus ?? value.status?.healthStatus?.status ?? null,
    configurationIssues: value.configurationIssues ?? (value.status?.healthStatus?.configurationIssues ?? []).map((entry) => entry.type).filter(Boolean)
  };
}

export function normalizeProductionBroadcast(value, expectedEvent = null, expectedCourt = null, { allowAutoStart = false } = {}) {
  const title = value?.title ?? value?.snippet?.title;
  const match = typeof title === "string" ? /^ScoreCheck ([a-z0-9-]+) - Camera ([1-8])$/.exec(title) : null;
  const event = value?.event ?? match?.[1] ?? null;
  const court = value?.court ?? (match ? Number(match[2]) : null);
  if (!value?.id || !event || !court || (expectedEvent !== null && event !== expectedEvent) || (expectedCourt !== null && court !== expectedCourt) || title !== productionBroadcastTitle(event, court)) throw new Error("production YouTube broadcast identity is invalid");
  const privacyStatus = value.privacyStatus ?? value.status?.privacyStatus ?? null;
  const autoStart = value.autoStart ?? value.contentDetails?.enableAutoStart ?? null;
  const autoStop = value.autoStop ?? value.contentDetails?.enableAutoStop ?? null;
  if (privacyStatus !== "unlisted" || (!allowAutoStart && autoStart !== false) || autoStop !== false) throw new Error(`Camera ${court} production YouTube broadcast safety settings are invalid`);
  return {
    id: String(value.id), event, court, title, watchUrl: value.watchUrl ?? `https://www.youtube.com/watch?v=${value.id}`,
    privacyStatus, autoStart, autoStop, lifeCycleStatus: value.lifeCycleStatus ?? value.status?.lifeCycleStatus ?? null,
    recordingStatus: value.recordingStatus ?? value.status?.recordingStatus ?? null,
    streamId: value.streamId ?? value.contentDetails?.boundStreamId ?? null
  };
}

export function redactDestinations(value) {
  return {
    ...value,
    streams: Object.fromEntries(Object.entries(value.streams ?? {}).map(([court, stream]) => [court, { ...stream, streamName: "<redacted>" }]))
  };
}

export function productionStreamTitle(court) {
  validateCourt(court);
  return `ScoreCheck Production Camera ${court} Auto Stream`;
}

export function productionBroadcastTitle(event, court) {
  validateEvent(event);
  validateCourt(court);
  return `ScoreCheck ${event} - Camera ${court}`;
}

function parseArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (argv[0] !== "prepare") throw new Error("first argument must be prepare");
  const options = { credentialsEnv: null, event: null, activeCameras: null, output: null };
  const mapping = new Map([["--credentials-env", "credentialsEnv"], ["--event", "event"], ["--active-cameras", "activeCameras"], ["--output", "output"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const raw = argv[++index];
    if (!key || !raw || raw.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    options[key] = key === "activeCameras" ? parseCourtList(raw) : key.endsWith("Env") || key === "output" ? normalizedAbsolute(raw, flag) : raw;
  }
  if (!options.credentialsEnv || !options.event || !options.activeCameras || !options.output) throw new Error("--credentials-env, --event, --active-cameras, and --output are required");
  return options;
}

function parseCourtList(value) {
  const courts = value.split(",").map(Number);
  validateActiveCameras(courts);
  return courts;
}

function validateActiveCameras(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((court) => !Number.isInteger(court) || court < 1 || court > 8) || new Set(value).size !== value.length || value.some((court, index) => index > 0 && court <= value[index - 1])) throw new Error("active cameras must be a unique ascending list from 1 through 8");
}

function validateCourt(court) {
  if (!Number.isInteger(court) || court < 1 || court > 8) throw new Error("YouTube camera must be from 1 through 8");
}

function validateEvent(value) {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?$/.test(value)) throw new Error("production YouTube event must be a lowercase slug");
}

function validateProviderId(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{3,100}$/.test(value)) throw new Error(`YouTube ${label} is invalid`);
}

function required(value, label) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${label} is required`);
  return value.trim();
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

async function assertProtectedParent(path) {
  const information = await stat(dirname(path));
  if (!information.isDirectory() || (information.mode & 0o077) !== 0) throw new Error("production YouTube output parent must be mode 0700 or stricter");
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function usage() {
  process.stdout.write("Usage: node infra/event-stack/production-youtube.mjs prepare --credentials-env /PROTECTED/provider.env --event SLUG --active-cameras 1,2,3,4,5,6 --output /PROTECTED/YOUTUBE-DIRECTORY\n");
}

export class YouTubeProviderError extends Error {
  constructor(message, status, reason = "unknown") { super(message); this.status = status; this.reason = reason; }
}
