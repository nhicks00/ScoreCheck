import express from "express";
import { Counter, Gauge, Registry } from "prom-client";
import { z } from "zod";
import { agentSnapshotSchema, type MonitorSnapshot } from "./contracts.js";
import { loadServiceConfig, type AgentTarget } from "./config.js";
import { buildMonitorSnapshot, type AgentRuntime } from "./correlator.js";
import { IncidentManager } from "./incidents.js";
import { IncidentStore } from "./incidentStore.js";
import { bearerAuth } from "./security.js";
import { BrowserHeartbeatManager } from "./browserHeartbeats.js";
import { ControlPlaneCollector } from "./controlPlane.js";
import { YouTubeCollector } from "./youtube.js";
import { NotificationDispatcher } from "./notifications.js";
import { BrowserThumbnailManager } from "./browserThumbnails.js";

const config = loadServiceConfig();
const app = express();
const registry = new Registry();
const agentFresh = new Gauge({ name: "scorecheck_monitor_agent_fresh", help: "Whether an expected host agent has reported within ten seconds.", labelNames: ["agent", "role"], registers: [registry] });
const agentPollErrors = new Counter({ name: "scorecheck_monitor_agent_poll_errors_total", help: "Agent snapshot poll errors.", labelNames: ["agent", "role"], registers: [registry] });
const snapshotGenerated = new Gauge({ name: "scorecheck_monitor_snapshot_generated_timestamp_seconds", help: "Unix timestamp of the latest monitor snapshot.", registers: [registry] });
const browserFresh = new Gauge({ name: "scorecheck_program_browser_heartbeat_fresh", help: "Whether a court program browser heartbeat was received within ten seconds.", labelNames: ["court"], registers: [registry] });
const browserFps = new Gauge({ name: "scorecheck_program_browser_frames_per_second", help: "Program browser rendered video frames per second.", labelNames: ["court"], registers: [registry] });
const browserRtt = new Gauge({ name: "scorecheck_program_browser_rtt_ms", help: "Program browser selected WebRTC candidate round-trip time in milliseconds.", labelNames: ["court"], registers: [registry] });
const browserPacketsLost = new Gauge({ name: "scorecheck_program_browser_packets_lost", help: "Program browser cumulative inbound video packets lost for the current page connection.", labelNames: ["court"], registers: [registry] });
const browserFramesDropped = new Gauge({ name: "scorecheck_program_browser_frames_dropped", help: "Program browser cumulative video frames dropped for the current page connection.", labelNames: ["court"], registers: [registry] });
const commentaryConnected = new Gauge({ name: "scorecheck_program_commentary_room_connected", help: "Whether the program browser is connected to its commentary room.", labelNames: ["court"], registers: [registry] });
const commentaryTracks = new Gauge({ name: "scorecheck_program_commentary_audio_tracks", help: "Subscribed commentary audio tracks in the program browser.", labelNames: ["court"], registers: [registry] });
const scoreRenderAligned = new Gauge({ name: "scorecheck_program_score_render_aligned", help: "Whether scorebug source and rendered DOM signatures agree.", labelNames: ["court"], registers: [registry] });
const controlPlaneFresh = new Gauge({ name: "scorecheck_control_plane_fresh", help: "Whether the latest Supabase control-plane sample is fresh.", registers: [registry] });
const courtMediaRequired = new Gauge({ name: "scorecheck_court_media_required", help: "Whether media is currently required for a court.", labelNames: ["court"], registers: [registry] });
const courtBroadcastLive = new Gauge({ name: "scorecheck_court_broadcast_live", help: "Whether a court broadcast is expected live.", labelNames: ["court"], registers: [registry] });
const courtCommentaryRequired = new Gauge({ name: "scorecheck_court_commentary_required", help: "Whether commentary is required for a court.", labelNames: ["court"], registers: [registry] });
const courtScoringLive = new Gauge({ name: "scorecheck_court_scoring_live", help: "Whether live scoring is required for a court.", labelNames: ["court"], registers: [registry] });
const scoreSourceAligned = new Gauge({ name: "scorecheck_score_source_aligned", help: "Whether canonical score, current match, and overlay state are aligned.", labelNames: ["court"], registers: [registry] });
const youtubeApiUp = new Gauge({ name: "scorecheck_youtube_api_up", help: "YouTube provider API state: 1 healthy, 0 unavailable, -1 not applicable.", registers: [registry] });
const youtubeHealthy = new Gauge({ name: "scorecheck_youtube_healthy", help: "YouTube stream health: 1 healthy, 0 unhealthy, -1 unknown or not applicable.", labelNames: ["court"], registers: [registry] });
const youtubeDegraded = new Gauge({ name: "scorecheck_youtube_degraded", help: "Whether YouTube reports a warning-level stream or configuration issue.", labelNames: ["court"], registers: [registry] });
const notificationProviderHealthy = new Gauge({ name: "scorecheck_notification_provider_healthy", help: "Notification provider state: 1 healthy, 0 failed, -1 not configured.", labelNames: ["provider"], registers: [registry] });
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
if (incidentStore) {
  try {
    incidents.hydrate(await incidentStore.loadActive());
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
  res.status(ageMs <= config.intervalMs * 3 ? 200 : 503).json({ version: 1, status: ageMs <= config.intervalMs * 3 ? "ok" : "stale", ageMs });
});
app.get("/metrics", bearerAuth(config.token), async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
app.get("/v1/snapshot", bearerAuth(config.token), (_req, res) => res.json(snapshot));
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
  browserPacketsLost.reset();
  browserFramesDropped.reset();
  commentaryConnected.reset();
  commentaryTracks.reset();
  scoreRenderAligned.reset();
  courtMediaRequired.reset();
  courtBroadcastLive.reset();
  courtCommentaryRequired.reset();
  courtScoringLive.reset();
  scoreSourceAligned.reset();
  youtubeHealthy.reset();
  youtubeDegraded.reset();
  controlPlaneFresh.set(snapshot.controlPlane.state === "HEALTHY" ? 1 : 0);
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
    scoreSourceAligned.set(labels, court.competition && court.competition.alignment.state !== "CRITICAL" && court.competition.alignment.state !== "DEGRADED" ? 1 : 0);
    youtubeHealthy.set(labels, court.youtube?.state === "HEALTHY" ? 1 : court.youtube?.state === "CRITICAL" ? 0 : -1);
    youtubeDegraded.set(labels, court.youtube?.state === "DEGRADED" ? 1 : 0);
    const ageMs = browser ? Date.now() - Date.parse(browser.receivedAt) : Number.POSITIVE_INFINITY;
    browserFresh.set(labels, ageMs <= 10_000 ? 1 : 0);
    if (!browser) continue;
    setOptionalGauge(browserFps, labels, browser.video.framesPerSecond);
    setOptionalGauge(browserRtt, labels, browser.video.rttMs);
    setOptionalGauge(browserPacketsLost, labels, browser.video.packetsLost);
    setOptionalGauge(browserFramesDropped, labels, browser.video.framesDropped);
    commentaryConnected.set(labels, browser.commentary.roomConnected ? 1 : 0);
    commentaryTracks.set(labels, browser.commentary.audioTrackCount);
    const render = browser.scoreRender;
    scoreRenderAligned.set(labels, render.loaded
      && render.connected
      && !render.domMismatchReason
      && render.sourceSignature != null
      && render.sourceSignature === render.renderedSignature ? 1 : 0);
  }
}

function currentSnapshot(): MonitorSnapshot {
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
    browserThumbnails.metadata()
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

async function pollAgent(target: AgentTarget) {
  const runtime = runtimes.get(target.id);
  if (!runtime) return;
  try {
    const response = await fetch(`${target.url}/v1/snapshot`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    runtime.snapshot = agentSnapshotSchema.parse(await response.json());
    if (runtime.snapshot.agentId !== target.id || runtime.snapshot.role !== target.role) throw new Error("Agent identity mismatch.");
    runtime.lastSeenAt = new Date().toISOString();
  } catch {
    runtime.lastErrorAt = new Date().toISOString();
    agentPollErrors.inc({ agent: target.id, role: target.role });
  }
}

async function pingDeadMan(url: string | null, name: "baseline" | "active") {
  if (!url) return;
  try {
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    console.error(`external ${name} dead-man ping failed`);
  }
}

function activeCoverageExpected(): boolean {
  return snapshot.courts.some((court) => court.expectation.coveragePhase !== "OFF"
    || court.expectation.mediaExpectation !== "OFF"
    || court.expectation.broadcastExpectation !== "OFF");
}

async function maintainNotifications() {
  try {
    const acknowledgements = await notificationDispatcher.maintain(incidents.active());
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
    await notificationDispatcher.handleChanges(changes);
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
const pollTimer = setInterval(() => void pollAll(), config.intervalMs);
pollTimer.unref();
const youtubeTimer = setInterval(() => void refreshYouTube(), 5_000);
youtubeTimer.unref();
if (config.healthchecksBaselinePingUrl) {
  void pingDeadMan(config.healthchecksBaselinePingUrl, "baseline");
  const baselineDeadManTimer = setInterval(() => void pingDeadMan(config.healthchecksBaselinePingUrl, "baseline"), config.healthchecksBaselineIntervalMs);
  baselineDeadManTimer.unref();
}
if (config.healthchecksActivePingUrl) {
  const pingActive = () => activeCoverageExpected() ? void pingDeadMan(config.healthchecksActivePingUrl, "active") : undefined;
  pingActive();
  const activeDeadManTimer = setInterval(pingActive, config.healthchecksActiveIntervalMs);
  activeDeadManTimer.unref();
}
if (incidentStore) {
  void checkpoint();
  const checkpointTimer = setInterval(() => void checkpoint(), 60_000);
  checkpointTimer.unref();
}
void reconcileAlertmanager();
const alertmanagerReconcileTimer = setInterval(() => void reconcileAlertmanager(), 30_000);
alertmanagerReconcileTimer.unref();
void maintainNotifications();
const notificationTimer = setInterval(() => void maintainNotifications(), 15_000);
notificationTimer.unref();

app.listen(config.port, config.bind, () => {
  console.log(`scorecheck-monitor-service listening on ${config.bind}:${config.port}`);
});
