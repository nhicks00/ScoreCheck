import express from "express";
import { Counter, Gauge, Registry } from "prom-client";
import { z } from "zod";
import { agentSnapshotSchema, MONITORING_CONTRACT_VERSION, STAGES, type MonitoringSilence, type MonitorSnapshot } from "./contracts.js";
import { loadServiceConfig, type AgentTarget } from "./config.js";
import { buildMonitorSnapshot, type AgentRuntime } from "./correlator.js";
import { IncidentManager } from "./incidents.js";
import { IncidentStore } from "./incidentStore.js";
import { bearerAuth } from "./security.js";
import { BrowserHeartbeatManager } from "./browserHeartbeats.js";
import { ControlPlaneCollector } from "./controlPlane.js";
import { YouTubeCollector } from "./youtube.js";
import { NotificationDispatcher } from "./notifications.js";
import { loadCourtPipelineRange, parseRangeInput } from "./rangeQueries.js";
import { BrowserThumbnailManager } from "./browserThumbnails.js";
import { activeSilences, incidentIsSilenced, silenceMatchesIncident } from "./silences.js";
import { ExternalDeadMan } from "./deadMan.js";

const config = loadServiceConfig();
const app = express();
const registry = new Registry();
const agentFresh = new Gauge({ name: "scorecheck_monitor_agent_fresh", help: "Whether an expected host agent has reported within ten seconds.", labelNames: ["agent", "role"], registers: [registry] });
const agentPollErrors = new Counter({ name: "scorecheck_monitor_agent_poll_errors_total", help: "Agent snapshot poll errors.", labelNames: ["agent", "role"], registers: [registry] });
const snapshotGenerated = new Gauge({ name: "scorecheck_monitor_snapshot_generated_timestamp_seconds", help: "Unix timestamp of the latest monitor snapshot.", registers: [registry] });
const browserFresh = new Gauge({ name: "scorecheck_program_browser_heartbeat_fresh", help: "Whether a court program browser heartbeat was received within ten seconds.", labelNames: ["court"], registers: [registry] });
const browserFps = new Gauge({ name: "scorecheck_program_browser_frames_per_second", help: "Program browser rendered video frames per second.", labelNames: ["court"], registers: [registry] });
const browserRtt = new Gauge({ name: "scorecheck_program_browser_rtt_ms", help: "Program browser selected WebRTC candidate round-trip time in milliseconds.", labelNames: ["court"], registers: [registry] });
const browserJitter = new Gauge({ name: "scorecheck_program_browser_jitter_ms", help: "Program browser inbound RTP jitter in milliseconds.", labelNames: ["court"], registers: [registry] });
const browserFreezeCount = new Gauge({ name: "scorecheck_program_browser_freeze_count", help: "Program browser cumulative WebRTC freeze count.", labelNames: ["court"], registers: [registry] });
const browserLastPacketAge = new Gauge({ name: "scorecheck_program_browser_last_packet_age_seconds", help: "Age of the most recently received video packet.", labelNames: ["court"], registers: [registry] });
const browserPacketsLost = new Gauge({ name: "scorecheck_program_browser_packets_lost", help: "Program browser cumulative inbound video packets lost for the current page connection.", labelNames: ["court"], registers: [registry] });
const browserFramesDropped = new Gauge({ name: "scorecheck_program_browser_frames_dropped", help: "Program browser cumulative video frames dropped for the current page connection.", labelNames: ["court"], registers: [registry] });
const commentaryConnected = new Gauge({ name: "scorecheck_program_commentary_room_connected", help: "Whether the program browser is connected to its commentary room.", labelNames: ["court"], registers: [registry] });
const commentaryTracks = new Gauge({ name: "scorecheck_program_commentary_audio_tracks", help: "Subscribed commentary audio tracks in the program browser.", labelNames: ["court"], registers: [registry] });
const commentaryMutedTracks = new Gauge({ name: "scorecheck_program_commentary_muted_tracks", help: "Muted subscribed commentary tracks.", labelNames: ["court"], registers: [registry] });
const commentaryClipping = new Gauge({ name: "scorecheck_program_commentary_clipped_sample_ratio", help: "Recent commentary clipped-sample ratio.", labelNames: ["court"], registers: [registry] });
const commentarySilenceAge = new Gauge({ name: "scorecheck_program_commentary_silence_age_seconds", help: "Seconds since commentary last exceeded the non-silence threshold.", labelNames: ["court"], registers: [registry] });
const commentaryPacketsLost = new Gauge({ name: "scorecheck_program_commentary_packets_lost", help: "Cumulative commentary packets lost for subscribed tracks.", labelNames: ["court"], registers: [registry] });
const commentaryPacketsReceived = new Gauge({ name: "scorecheck_program_commentary_packets_received", help: "Cumulative commentary packets received for subscribed tracks.", labelNames: ["court"], registers: [registry] });
const commentaryJitterBuffer = new Gauge({ name: "scorecheck_program_commentary_jitter_buffer_ms", help: "Recent commentary receiver jitter-buffer delay in milliseconds.", labelNames: ["court"], registers: [registry] });
const commentarySyncLocked = new Gauge({ name: "scorecheck_program_commentary_sync_locked", help: "Whether adaptive commentary synchronization is locked.", labelNames: ["court"], registers: [registry] });
const commentarySyncGap = new Gauge({ name: "scorecheck_program_commentary_sync_gap_ms", help: "Absolute target-to-applied commentary delay gap.", labelNames: ["court"], registers: [registry] });
const cameraAudioTrack = new Gauge({ name: "scorecheck_program_camera_audio_track_present", help: "Whether the camera media stream contains a live audio track.", labelNames: ["court"], registers: [registry] });
const cameraAudioClipping = new Gauge({ name: "scorecheck_program_camera_audio_clipped_sample_ratio", help: "Recent camera-audio clipped-sample ratio.", labelNames: ["court"], registers: [registry] });
const cameraAudioSilenceAge = new Gauge({ name: "scorecheck_program_camera_audio_silence_age_seconds", help: "Seconds since camera audio last exceeded the non-silence threshold.", labelNames: ["court"], registers: [registry] });
const visualFrozenDuration = new Gauge({ name: "scorecheck_program_visual_frozen_duration_seconds", help: "Duration of low inter-frame visual change while rendered frames continue.", labelNames: ["court"], registers: [registry] });
const visualBlackDuration = new Gauge({ name: "scorecheck_program_visual_black_duration_seconds", help: "Duration of a high-confidence black or covered program image.", labelNames: ["court"], registers: [registry] });
const visualDarkRatio = new Gauge({ name: "scorecheck_program_visual_dark_pixel_ratio", help: "Fraction of sampled program pixels below the dark threshold.", labelNames: ["court"], registers: [registry] });
const visualFrameDifference = new Gauge({ name: "scorecheck_program_visual_frame_difference", help: "Mean absolute luminance difference from the prior sampled frame.", labelNames: ["court"], registers: [registry] });
const scoreRenderAligned = new Gauge({ name: "scorecheck_program_score_render_aligned", help: "Whether scorebug source and rendered DOM signatures agree.", labelNames: ["court"], registers: [registry] });
const controlPlaneFresh = new Gauge({ name: "scorecheck_control_plane_fresh", help: "Whether the latest Supabase control-plane sample is fresh.", registers: [registry] });
const scoreWorkerHealthy = new Gauge({ name: "scorecheck_score_worker_healthy", help: "Score worker state: 1 healthy, 0 unavailable, -1 not applicable.", registers: [registry] });
const courtMediaRequired = new Gauge({ name: "scorecheck_court_media_required", help: "Whether media is currently required for a court.", labelNames: ["court"], registers: [registry] });
const courtBroadcastLive = new Gauge({ name: "scorecheck_court_broadcast_live", help: "Whether a court broadcast is expected live.", labelNames: ["court"], registers: [registry] });
const courtCommentaryRequired = new Gauge({ name: "scorecheck_court_commentary_required", help: "Whether commentary is required for a court.", labelNames: ["court"], registers: [registry] });
const courtScoringLive = new Gauge({ name: "scorecheck_court_scoring_live", help: "Whether live scoring is required for a court.", labelNames: ["court"], registers: [registry] });
const courtLiveMatch = new Gauge({ name: "scorecheck_court_live_match", help: "Whether the court is in the LIVE_MATCH coverage phase.", labelNames: ["court"], registers: [registry] });
const scoreSourceAligned = new Gauge({ name: "scorecheck_score_source_aligned", help: "Whether canonical score, current match, and overlay state are aligned.", labelNames: ["court"], registers: [registry] });
const youtubeApiUp = new Gauge({ name: "scorecheck_youtube_api_up", help: "YouTube provider API state: 1 healthy, 0 unavailable, -1 not applicable.", registers: [registry] });
const youtubeHealthy = new Gauge({ name: "scorecheck_youtube_healthy", help: "YouTube stream health: 1 healthy, 0 unhealthy, -1 unknown or not applicable.", labelNames: ["court"], registers: [registry] });
const youtubeDegraded = new Gauge({ name: "scorecheck_youtube_degraded", help: "Whether YouTube reports a warning-level stream or configuration issue.", labelNames: ["court"], registers: [registry] });
const notificationProviderHealthy = new Gauge({ name: "scorecheck_notification_provider_healthy", help: "Notification provider state: 1 healthy, 0 failed, -1 not configured.", labelNames: ["provider"], registers: [registry] });
const deadManCheckHealthy = new Gauge({ name: "scorecheck_external_dead_man_healthy", help: "External dead-man sender state: 1 verified, 0 failed, -1 not configured or unverified.", labelNames: ["check"], registers: [registry] });
const deadManActiveRunning = new Gauge({ name: "scorecheck_external_dead_man_active_running", help: "Active-coverage dead-man mode: 1 running, 0 intentionally paused, -1 unknown or not configured.", registers: [registry] });
const runtimes = new Map<string, AgentRuntime>(config.targets.map((target) => [target.id, {
  target,
  snapshot: null,
  lastSeenAt: null,
  lastErrorAt: null
}]));
const incidents = new IncidentManager();
const browserHeartbeats = new BrowserHeartbeatManager(config.browserHeartbeatSecret);
const browserThumbnails = new BrowserThumbnailManager(config.browserHeartbeatSecret);
const controlPlane = new ControlPlaneCollector(config.supabaseUrl, config.supabaseServiceRoleKey);
const youtubeCollector = new YouTubeCollector({
  apiKey: config.youtubeApiKey,
  clientId: config.youtubeClientId,
  clientSecret: config.youtubeClientSecret,
  refreshToken: config.youtubeRefreshToken,
  intervalMs: config.youtubeMonitorIntervalMs
});
let youtubeRefreshRunning = false;
const incidentStore = IncidentStore.create(config.supabaseUrl, config.supabaseServiceRoleKey);
const notificationDispatcher = new NotificationDispatcher(config, incidentStore);
const externalDeadMan = new ExternalDeadMan(config);
let deadManMaintenanceRunning = false;
let silences: MonitoringSilence[] = [];
if (incidentStore) {
  try {
    incidents.hydrate(await incidentStore.loadActive());
    silences = await incidentStore.loadActiveSilences();
    notificationDispatcher.hydrate(await incidentStore.latestProviderNotifications());
  } catch {
    console.error("durable monitoring state could not be loaded");
  }
}
let snapshot: MonitorSnapshot = currentSnapshot();

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.get("/healthz", (_req, res) => {
  const ageMs = Date.now() - Date.parse(snapshot.generatedAt);
  res.status(ageMs <= config.intervalMs * 3 ? 200 : 503).json({ version: MONITORING_CONTRACT_VERSION, status: ageMs <= config.intervalMs * 3 ? "ok" : "stale", ageMs });
});
app.get("/metrics", bearerAuth(config.token), async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
app.get("/v1/snapshot", bearerAuth(config.token), (_req, res) => res.json(snapshot));
app.get("/v1/range/court-pipeline", bearerAuth(config.token), async (req, res) => {
  try {
    const input = parseRangeInput({ windowSec: req.query.windowSec, stepSec: req.query.stepSec });
    res.setHeader("cache-control", "private, no-store");
    res.json(await loadCourtPipelineRange(config.prometheusInternalUrl, input));
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 502;
    res.status(status).json({ error: status === 400 ? "Invalid range query bounds." : "Monitoring history is unavailable." });
  }
});
app.options("/v1/browser-heartbeats", (req, res) => {
  const origin = allowedBrowserOrigin(req.headers.origin);
  if (!origin) {
    res.sendStatus(403);
    return;
  }
  setBrowserCors(res, origin);
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-scorecheck-court, x-scorecheck-credential-id, x-scorecheck-sequence, x-scorecheck-sampled-at");
  res.sendStatus(204);
});
app.post("/v1/browser-heartbeats", (req, res) => {
  const origin = allowedBrowserOrigin(req.headers.origin);
  if (!origin) {
    res.status(403).json({ error: "Origin is not allowed." });
    return;
  }
  setBrowserCors(res, origin);
  const token = bearerToken(req.headers.authorization);
  try {
    browserHeartbeats.accept(token, req.body);
    snapshot = currentSnapshot();
    res.sendStatus(202);
  } catch {
    res.status(400).json({ error: "Invalid browser heartbeat." });
  }
});
app.options("/v1/browser-thumbnails", (req, res) => {
  const origin = allowedBrowserOrigin(req.headers.origin);
  if (!origin) {
    res.sendStatus(403);
    return;
  }
  setBrowserCors(res, origin);
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, x-scorecheck-court, x-scorecheck-credential-id, x-scorecheck-sequence, x-scorecheck-sampled-at");
  res.sendStatus(204);
});
app.post("/v1/browser-thumbnails", express.raw({ type: "image/jpeg", limit: "96kb" }), (req, res) => {
  const origin = allowedBrowserOrigin(req.headers.origin);
  if (!origin) {
    res.status(403).json({ error: "Origin is not allowed." });
    return;
  }
  setBrowserCors(res, origin);
  try {
    browserThumbnails.accept(bearerToken(req.headers.authorization), {
      credentialId: req.headers["x-scorecheck-credential-id"],
      courtNumber: req.headers["x-scorecheck-court"],
      sequence: req.headers["x-scorecheck-sequence"],
      sampledAt: req.headers["x-scorecheck-sampled-at"]
    }, req.body);
    snapshot = currentSnapshot();
    res.sendStatus(202);
  } catch {
    res.status(400).json({ error: "Invalid browser thumbnail." });
  }
});
app.get("/v1/courts/:courtNumber/thumbnail", bearerAuth(config.token), (req, res) => {
  const courtNumber = Number(Array.isArray(req.params.courtNumber) ? req.params.courtNumber[0] : req.params.courtNumber);
  const thumbnail = Number.isInteger(courtNumber) ? browserThumbnails.get(courtNumber) : null;
  if (!thumbnail || Date.now() - Date.parse(thumbnail.receivedAt) > 45_000) {
    res.sendStatus(404);
    return;
  }
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("content-type", thumbnail.contentType);
  res.setHeader("x-scorecheck-sampled-at", thumbnail.sampledAt);
  res.send(thumbnail.body);
});
app.post("/v1/alertmanager", bearerAuth(config.alertmanagerWebhookToken), async (req, res) => {
  try {
    const changed = incidents.applyWebhook(req.body);
    snapshot = currentSnapshot();
    await persistIncidentChanges(changed);
    res.status(202).json({ accepted: changed.length });
  } catch {
    res.status(400).json({ error: "Invalid Alertmanager payload." });
  }
});
app.get("/v1/incidents/:id", bearerAuth(config.token), (req, res) => {
  const incidentId = z.string().uuid().safeParse(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!incidentId.success) {
    res.status(400).json({ error: "Invalid incident identifier." });
    return;
  }
  const incident = incidents.all().find((entry) => entry.id === incidentId.data);
  if (!incident) {
    res.status(404).json({ error: "Incident not found." });
    return;
  }
  res.json({ incident });
});
app.post("/v1/incidents/:id/acknowledge", bearerAuth(config.token), async (req, res) => {
  const incidentId = z.string().uuid().safeParse(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  const parsed = z.object({
    actor: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:@-]+$/),
    reason: z.string().trim().min(1).max(300)
  }).strict().safeParse(req.body);
  if (!incidentId.success || !parsed.success) {
    res.status(400).json({ error: "Invalid acknowledgement." });
    return;
  }
  const change = incidents.acknowledge(incidentId.data, parsed.data.actor, parsed.data.reason);
  if (!change) {
    res.status(404).json({ error: "Active incident not found." });
    return;
  }
  snapshot = currentSnapshot();
  await persistIncidentChanges([change]);
  res.json({ incident: change.incident, reason: parsed.data.reason });
});
app.post("/v1/silences", bearerAuth(config.token), async (req, res) => {
  const parsed = z.object({
    eventId: z.string().uuid().nullable().default(null),
    courtNumber: z.number().int().min(1).max(8).nullable().default(null),
    stage: z.enum(STAGES).nullable().default(null),
    issueCode: z.string().trim().min(1).max(80).regex(/^[A-Z0-9_.:-]+$/).nullable().default(null),
    reason: z.string().trim().min(3).max(300).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    actor: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:@-]+$/),
    expiresAt: z.string().datetime({ offset: true })
  }).strict().refine((value) => value.eventId != null || value.courtNumber != null || value.stage != null || value.issueCode != null, {
    message: "At least one silence scope is required."
  }).safeParse(req.body);
  if (!parsed.success || !incidentStore) {
    res.status(parsed.success ? 503 : 400).json({ error: parsed.success ? "Durable silence storage is unavailable." : "Invalid silence request." });
    return;
  }
  const now = new Date();
  const expiresAtMs = Date.parse(parsed.data.expiresAt);
  if (expiresAtMs < now.getTime() + 60_000 || expiresAtMs > now.getTime() + 24 * 60 * 60_000) {
    res.status(400).json({ error: "Silence expiry must be between one minute and 24 hours from now." });
    return;
  }
  try {
    const silence = await incidentStore.createSilence({
      eventId: parsed.data.eventId,
      courtNumber: parsed.data.courtNumber,
      stage: parsed.data.stage,
      issueCode: parsed.data.issueCode,
      reason: parsed.data.reason,
      createdBy: parsed.data.actor,
      expiresAt: parsed.data.expiresAt
    });
    silences = activeSilences([...silences, silence], now);
    for (const incident of incidents.active().filter((entry) => silenceMatchesIncident(silence, entry, now))) {
      await incidentStore.appendSilencedEvent(incident.id, silence);
      await notificationDispatcher.silence(incident, now);
    }
    snapshot = currentSnapshot();
    await incidentStore.checkpoint(snapshot);
    res.status(201).json({ silence });
  } catch {
    res.status(503).json({ error: "Silence could not be persisted." });
  }
});
app.post("/v1/provider/twilio/status", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
  const params = Object.fromEntries(Object.entries(req.body as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  try {
    const accepted = await notificationDispatcher.applyTwilioStatus(params, String(req.headers["x-twilio-signature"] ?? ""));
    res.sendStatus(accepted ? 204 : 403);
  } catch {
    res.sendStatus(503);
  }
});

async function pollAll() {
  await Promise.all([
    ...config.targets.map((target) => pollAgent(target)),
    controlPlane.refresh().catch(() => null)
  ]);
  snapshot = currentSnapshot();
  snapshotGenerated.set(Date.parse(snapshot.generatedAt) / 1_000);
  agentFresh.reset();
  for (const agent of snapshot.agents) {
    agentFresh.set({ agent: agent.agentId, role: agent.role }, agent.ageMs != null && agent.ageMs <= 10_000 ? 1 : 0);
  }
  browserFresh.reset();
  browserFps.reset();
  browserRtt.reset();
  browserJitter.reset();
  browserFreezeCount.reset();
  browserLastPacketAge.reset();
  browserPacketsLost.reset();
  browserFramesDropped.reset();
  commentaryConnected.reset();
  commentaryTracks.reset();
  commentaryMutedTracks.reset();
  commentaryClipping.reset();
  commentarySilenceAge.reset();
  commentaryPacketsLost.reset();
  commentaryPacketsReceived.reset();
  commentaryJitterBuffer.reset();
  commentarySyncLocked.reset();
  commentarySyncGap.reset();
  cameraAudioTrack.reset();
  cameraAudioClipping.reset();
  cameraAudioSilenceAge.reset();
  visualFrozenDuration.reset();
  visualBlackDuration.reset();
  visualDarkRatio.reset();
  visualFrameDifference.reset();
  scoreRenderAligned.reset();
  courtMediaRequired.reset();
  courtBroadcastLive.reset();
  courtCommentaryRequired.reset();
  courtScoringLive.reset();
  courtLiveMatch.reset();
  scoreSourceAligned.reset();
  youtubeHealthy.reset();
  youtubeDegraded.reset();
  controlPlaneFresh.set(snapshot.controlPlane.state === "HEALTHY" ? 1 : 0);
  scoreWorkerHealthy.set(snapshot.controlPlane.worker.state === "NOT_APPLICABLE" ? -1 : snapshot.controlPlane.worker.state === "HEALTHY" ? 1 : 0);
  youtubeApiUp.set(snapshot.youtube.state === "NOT_APPLICABLE" ? -1 : snapshot.youtube.state === "HEALTHY" ? 1 : 0);
  const notificationHealth = snapshot.notifications;
  notificationProviderHealthy.set({ provider: "pushover" }, providerMetric(notificationHealth.pushover));
  notificationProviderHealthy.set({ provider: "twilio_sms" }, providerMetric(notificationHealth.twilioSms));
  for (const court of snapshot.courts) {
    const labels = { court: String(court.courtNumber) };
    const browser = court.browser;
    courtMediaRequired.set(labels, court.expectation.mediaExpectation === "REQUIRED" ? 1 : 0);
    courtBroadcastLive.set(labels, court.expectation.broadcastExpectation === "LIVE" ? 1 : 0);
    courtCommentaryRequired.set(labels, court.expectation.commentaryExpectation === "REQUIRED" ? 1 : 0);
    courtScoringLive.set(labels, court.expectation.scoringExpectation === "LIVE" ? 1 : 0);
    courtLiveMatch.set(labels, court.expectation.coveragePhase === "LIVE_MATCH" ? 1 : 0);
    scoreSourceAligned.set(labels, court.competition && court.competition.alignment.state !== "CRITICAL" && court.competition.alignment.state !== "DEGRADED" ? 1 : 0);
    youtubeHealthy.set(labels, court.youtube?.state === "HEALTHY" ? 1 : court.youtube?.state === "CRITICAL" ? 0 : -1);
    youtubeDegraded.set(labels, court.youtube?.state === "DEGRADED" ? 1 : 0);
    const ageMs = browser ? Date.now() - Date.parse(browser.receivedAt) : Number.POSITIVE_INFINITY;
    browserFresh.set(labels, ageMs <= 10_000 ? 1 : 0);
    if (!browser) continue;
    setOptionalGauge(browserFps, labels, browser.video.framesPerSecond);
    setOptionalGauge(browserRtt, labels, browser.video.rttMs);
    setOptionalGauge(browserJitter, labels, browser.video.jitterMs);
    setOptionalGauge(browserFreezeCount, labels, browser.video.freezeCount);
    setOptionalGauge(browserLastPacketAge, labels, browser.video.lastPacketAgeMs == null ? null : browser.video.lastPacketAgeMs / 1_000);
    setOptionalGauge(browserPacketsLost, labels, browser.video.packetsLost);
    setOptionalGauge(browserFramesDropped, labels, browser.video.framesDropped);
    commentaryConnected.set(labels, browser.commentary.roomConnected ? 1 : 0);
    commentaryTracks.set(labels, browser.commentary.audioTrackCount);
    commentaryMutedTracks.set(labels, browser.commentary.mutedAudioTrackCount);
    commentarySyncLocked.set(labels, browser.commentary.syncStatus === "locked" ? 1 : 0);
    cameraAudioTrack.set(labels, browser.commentary.cameraTrackPresent ? 1 : 0);
    setOptionalGauge(commentaryClipping, labels, browser.commentary.clippedSampleRatio);
    setOptionalGauge(commentarySilenceAge, labels, browser.commentary.secondsSinceAudio);
    setOptionalGauge(commentaryPacketsLost, labels, browser.commentary.packetsLost);
    setOptionalGauge(commentaryPacketsReceived, labels, browser.commentary.packetsReceived);
    setOptionalGauge(commentaryJitterBuffer, labels, browser.commentary.jitterBufferMs);
    const syncGapMs = browser.commentary.targetDelayMs != null && browser.commentary.appliedDelayMs != null
      ? Math.abs(browser.commentary.targetDelayMs - browser.commentary.appliedDelayMs)
      : null;
    setOptionalGauge(commentarySyncGap, labels, syncGapMs);
    setOptionalGauge(cameraAudioClipping, labels, browser.commentary.cameraClippedSampleRatio);
    setOptionalGauge(cameraAudioSilenceAge, labels, browser.commentary.secondsSinceCameraAudio);
    visualFrozenDuration.set(labels, browser.visual.frozenDurationMs / 1_000);
    visualBlackDuration.set(labels, browser.visual.blackDurationMs / 1_000);
    setOptionalGauge(visualDarkRatio, labels, browser.visual.darkPixelRatio);
    setOptionalGauge(visualFrameDifference, labels, browser.visual.frameDifference);
    const render = browser.scoreRender;
    scoreRenderAligned.set(labels, render.loaded
      && render.connected
      && !render.domMismatchReason
      && render.sourceSignature != null
      && render.sourceSignature === render.renderedSignature ? 1 : 0);
  }
}

function currentSnapshot(): MonitorSnapshot {
  silences = activeSilences(silences);
  return buildMonitorSnapshot(
    config.targets,
    runtimes,
    config.courtCount,
    Date.now(),
    incidents.active(),
    browserHeartbeats.latest(),
    controlPlane.current(),
    youtubeCollector.current(),
    notificationDispatcher.health(),
    externalDeadMan.health(),
    browserThumbnails.metadata(),
    silences
  );
}

async function refreshYouTube() {
  if (youtubeRefreshRunning) return;
  youtubeRefreshRunning = true;
  try {
    await youtubeCollector.refresh(controlPlane.current());
    snapshot = currentSnapshot();
  } finally {
    youtubeRefreshRunning = false;
  }
}

function allowedBrowserOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const normalized = new URL(origin).origin;
    return config.browserAllowedOrigins.includes(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function setBrowserCors(res: express.Response, origin: string) {
  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "Origin");
  res.setHeader("cache-control", "no-store");
}

function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function setOptionalGauge(gauge: Gauge, labels: { court: string }, value: number | null) {
  if (value != null && Number.isFinite(value)) gauge.set(labels, value);
}

function providerMetric(provider: { configured: boolean; lastSuccessAt: string | null; lastFailureAt: string | null }): number {
  if (!provider.configured) return -1;
  if (provider.lastFailureAt) return 0;
  return provider.lastSuccessAt ? 1 : -1;
}

function updateDeadManMetrics(): void {
  const health = externalDeadMan.health();
  deadManCheckHealthy.set({ check: "baseline" }, providerMetric(health.baseline));
  deadManCheckHealthy.set({ check: "active" }, providerMetric(health.active));
  deadManActiveRunning.set(health.active.mode === "RUNNING" ? 1 : health.active.mode === "PAUSED" ? 0 : -1);
}

async function pollAgent(target: AgentTarget) {
  const runtime = runtimes.get(target.id);
  if (!runtime) return;
  try {
    const response = await fetch(`${target.url}/v1/snapshot`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const agentSnapshot = agentSnapshotSchema.parse(await response.json());
    if (agentSnapshot.agentId !== target.id || agentSnapshot.role !== target.role) throw new Error("Agent identity mismatch.");
    if (!sameCourts(agentSnapshot.assignedCourts, target.assignedCourts)) throw new Error("Agent court assignment mismatch.");
    runtime.snapshot = agentSnapshot;
    runtime.lastSeenAt = new Date().toISOString();
  } catch {
    runtime.lastErrorAt = new Date().toISOString();
    agentPollErrors.inc({ agent: target.id, role: target.role });
  }
}

function sameCourts(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((court, index) => court === right[index]);
}

function activeCoverageExpected(): boolean {
  return snapshot.courts.some((court) => court.expectation.coveragePhase !== "OFF"
    || court.expectation.mediaExpectation !== "OFF"
    || court.expectation.broadcastExpectation !== "OFF");
}

async function maintainDeadMan(): Promise<void> {
  if (deadManMaintenanceRunning) return;
  deadManMaintenanceRunning = true;
  try {
    await externalDeadMan.maintain(activeCoverageExpected());
    snapshot = currentSnapshot();
    updateDeadManMetrics();
  } finally {
    deadManMaintenanceRunning = false;
  }
}

async function maintainNotifications() {
  try {
    const acknowledgements = await notificationDispatcher.maintain(
      incidents.active(),
      new Date(),
      (incident) => incidentIsSilenced(incident, silences)
    );
    for (const acknowledgement of acknowledgements) {
      const change = incidents.acknowledge(acknowledgement.incidentId, acknowledgement.actor, acknowledgement.reason);
      if (!change) continue;
      snapshot = currentSnapshot();
      await persistIncidentChanges([change]);
    }
  } catch {
    console.error("notification maintenance failed");
  }
}

async function reconcileAlertmanager() {
  try {
    const response = await fetch(`${config.alertmanagerInternalUrl}/api/v2/alerts`, {
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const changes = incidents.reconcileActiveAlerts(await response.json());
    if (changes.length === 0) return;
    snapshot = currentSnapshot();
    await persistIncidentChanges(changes);
  } catch {
    console.error("alertmanager active-set reconciliation failed");
  }
}

async function persistIncidentChanges(changes: ReturnType<IncidentManager["applyWebhook"]>) {
  if (!incidentStore) return;
  try {
    for (const change of changes) await incidentStore.persist(change);
    await incidentStore.checkpoint(snapshot);
    await notificationDispatcher.handleChanges(
      changes,
      new Date(),
      (incident) => incidentIsSilenced(incident, silences)
    );
  } catch {
    console.error("durable incident state could not be persisted");
  }
}

async function checkpoint() {
  if (!incidentStore) return;
  try {
    await incidentStore.checkpoint(snapshot);
  } catch {
    console.error("monitor checkpoint could not be persisted");
  }
}

await pollAll();
await refreshYouTube();
await maintainDeadMan();
const pollTimer = setInterval(() => void pollAll(), config.intervalMs);
pollTimer.unref();
const youtubeTimer = setInterval(() => void refreshYouTube(), 5_000);
youtubeTimer.unref();
const deadManTimer = setInterval(() => void maintainDeadMan(), 5_000);
deadManTimer.unref();
if (incidentStore) {
  void checkpoint();
  const checkpointTimer = setInterval(() => void checkpoint(), 60_000);
  checkpointTimer.unref();
}
// Compose starts Alertmanager only after this service is healthy. The first
// interval therefore doubles as startup grace instead of logging an expected
// dependency race on every deployment.
const alertmanagerReconcileTimer = setInterval(() => void reconcileAlertmanager(), 30_000);
alertmanagerReconcileTimer.unref();
void maintainNotifications();
const notificationTimer = setInterval(() => void maintainNotifications(), 15_000);
notificationTimer.unref();

app.listen(config.port, config.bind, () => {
  console.log(`scorecheck-monitor-service listening on ${config.bind}:${config.port}`);
});
