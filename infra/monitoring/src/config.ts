import { z } from "zod";
import { AGENT_ROLES, type AgentRole } from "./contracts.js";

const port = z.coerce.number().int().min(1).max(65_535);
const interval = z.coerce.number().int().min(1_000).max(300_000);

export type AgentConfig = ReturnType<typeof loadAgentConfig>;
export type ServiceConfig = ReturnType<typeof loadServiceConfig>;

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env) {
  const schema = z.object({
    MONITOR_AGENT_ID: safeIdSchema,
    MONITOR_AGENT_ROLE: z.enum(AGENT_ROLES),
    MONITOR_AGENT_TOKEN: z.string().min(24),
    MONITOR_AGENT_BIND: z.string().default("127.0.0.1"),
    MONITOR_AGENT_PORT: port.default(9108),
    MONITOR_AGENT_INTERVAL_MS: interval.default(5_000),
    MONITOR_AGENT_CONTAINERS: z.string().default(""),
    MONITOR_AGENT_COURTS: z.string().default(""),
    MONITOR_DISK_PATH: z.string().default("/"),
    FFMPEG_PROGRESS_DIR: z.string().default(""),
    DOCKER_API_URL: safeHttpUrl.optional(),
    MEDIAMTX_API_URL: optionalHttpUrl,
    MEDIAMTX_METRICS_URL: optionalHttpUrl,
    LIVEKIT_METRICS_URL: optionalHttpUrl,
    EGRESS_METRICS_URL: optionalHttpUrl,
    EGRESS_HEALTH_URL: optionalHttpUrl,
    MONITOR_EGRESS_MAX_WEB_REQUESTS: z.coerce.number().int().min(1).max(32).default(1),
    MONITOR_CONTENT_ANALYZER_COURTS: z.string().default(""),
    MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: optionalRtspUrl,
    MONITOR_CONTENT_ANALYZER_FFMPEG_PATH: safeExecutablePath.default("/usr/bin/ffmpeg"),
    MONITOR_CONTENT_ANALYZER_FFPROBE_PATH: safeExecutablePath.default("/usr/bin/ffprobe")
  });
  const parsed = schema.parse(env);
  const assignedCourts = parseCourtList(parsed.MONITOR_AGENT_COURTS, "MONITOR_AGENT_COURTS");
  const contentAnalyzerCourts = parseCourtList(parsed.MONITOR_CONTENT_ANALYZER_COURTS, "MONITOR_CONTENT_ANALYZER_COURTS");
  if (contentAnalyzerCourts.length > 0) {
    if (parsed.MONITOR_AGENT_ROLE !== "compositor") throw new Error("Camera-content analysis may run only on compositor agents.");
    if (!parsed.MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL) throw new Error("Camera-content analysis requires MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL.");
    if (contentAnalyzerCourts.some((court) => !assignedCourts.includes(court))) {
      throw new Error("Camera-content analyzer courts must be owned by the compositor agent.");
    }
  } else if (parsed.MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL) {
    throw new Error("MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL requires at least one analyzer court.");
  }
  return {
    agentId: parsed.MONITOR_AGENT_ID,
    role: parsed.MONITOR_AGENT_ROLE,
    token: parsed.MONITOR_AGENT_TOKEN,
    bind: parsed.MONITOR_AGENT_BIND,
    port: parsed.MONITOR_AGENT_PORT,
    intervalMs: parsed.MONITOR_AGENT_INTERVAL_MS,
    containers: parsed.MONITOR_AGENT_CONTAINERS.split(",").map((value) => value.trim()).filter(Boolean).map((value) => safeIdSchema.parse(value)),
    assignedCourts,
    diskPath: parsed.MONITOR_DISK_PATH,
    ffmpegProgressDir: parsed.FFMPEG_PROGRESS_DIR.trim() || null,
    dockerApiUrl: parsed.DOCKER_API_URL ?? null,
    mediamtxApiUrl: parsed.MEDIAMTX_API_URL ? parsed.MEDIAMTX_API_URL.replace(/\/+$/, "") : null,
    mediamtxMetricsUrl: parsed.MEDIAMTX_METRICS_URL ?? null,
    livekitMetricsUrl: parsed.LIVEKIT_METRICS_URL ?? null,
    egressMetricsUrl: parsed.EGRESS_METRICS_URL ?? null,
    egressHealthUrl: parsed.EGRESS_HEALTH_URL ?? null,
    egressMaxWebRequests: parsed.MONITOR_EGRESS_MAX_WEB_REQUESTS,
    contentAnalyzerCourts,
    contentAnalyzerRtspBaseUrl: parsed.MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL?.replace(/\/+$/, "") ?? null,
    contentAnalyzerFfmpegPath: parsed.MONITOR_CONTENT_ANALYZER_FFMPEG_PATH,
    contentAnalyzerFfprobePath: parsed.MONITOR_CONTENT_ANALYZER_FFPROBE_PATH
  };
}

function parseCourtList(raw: string, field: string): number[] {
  const courts = raw.split(",").map((value) => value.trim()).filter(Boolean).map(Number);
  if (courts.some((court) => !Number.isInteger(court) || court < 1 || court > 8)) throw new Error(`${field} must contain court numbers 1-8.`);
  return [...new Set(courts)].sort((left, right) => left - right);
}

export type AgentTarget = {
  id: string;
  role: AgentRole;
  url: string;
  token: string;
  assignedCourts: number[];
};

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const schema = z.object({
    MONITOR_API_TOKEN: z.string().min(24),
    ALERTMANAGER_WEBHOOK_TOKEN: z.string().min(24),
    ALERTMANAGER_INTERNAL_URL: safeHttpUrl.default("http://alertmanager:9093"),
    PROMETHEUS_INTERNAL_URL: safeHttpUrl.default("http://prometheus:9090"),
    MONITOR_BROWSER_HEARTBEAT_SECRET: z.string().min(32),
    MONITOR_BROWSER_ALLOWED_ORIGINS: z.string().default("https://score.beachvolleyballmedia.com"),
    MONITOR_AGENT_TARGETS: z.string().default(""),
    MONITOR_SERVICE_BIND: z.string().default("127.0.0.1"),
    MONITOR_SERVICE_PORT: port.default(9110),
    MONITOR_SERVICE_INTERVAL_MS: interval.default(5_000),
    MONITOR_COURT_COUNT: z.coerce.number().int().min(1).max(8).default(8),
    HEALTHCHECKS_BASELINE_PING_URL: optionalHttpsUrl,
    HEALTHCHECKS_BASELINE_CHECK_ID: z.preprocess(emptyStringToUndefined, z.string().uuid().optional()),
    HEALTHCHECKS_ACTIVE_PING_URL: optionalHttpsUrl,
    HEALTHCHECKS_API_KEY: z.string().default(""),
    HEALTHCHECKS_ACTIVE_CHECK_ID: z.preprocess(emptyStringToUndefined, z.string().uuid().optional()),
    HEALTHCHECKS_BASELINE_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
    HEALTHCHECKS_ACTIVE_INTERVAL_MS: interval.default(60_000),
    HEALTHCHECKS_CHANNEL_AUDIT_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
    SUPABASE_URL: optionalHttpsUrl,
    SUPABASE_SERVICE_ROLE_KEY: z.preprocess(emptyStringToUndefined, z.string().min(20).optional()),
    MONITOR_PUBLIC_HOST: z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/),
    MONITOR_DASHBOARD_URL: optionalHttpsUrl,
    PUSHOVER_APP_TOKEN: z.string().default(""),
    PUSHOVER_USER_KEY: z.string().default(""),
    NOTIFICATION_STATUS_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
    YOUTUBE_API_KEY: z.string().default(""),
    YOUTUBE_CLIENT_ID: z.string().default(""),
    YOUTUBE_CLIENT_SECRET: z.string().default(""),
    YOUTUBE_REFRESH_TOKEN: z.string().default(""),
    YOUTUBE_MONITOR_INTERVAL_MS: z.coerce.number().int().min(30_000).max(300_000).default(60_000)
  });
  const parsed = schema.parse(env);
  if (Boolean(parsed.SUPABASE_URL) !== Boolean(parsed.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured together.");
  }
  const oauthValues = [parsed.YOUTUBE_CLIENT_ID, parsed.YOUTUBE_CLIENT_SECRET, parsed.YOUTUBE_REFRESH_TOKEN].filter((value) => value.trim());
  if (oauthValues.length !== 0 && oauthValues.length !== 3) throw new Error("YouTube OAuth monitoring requires client id, client secret, and refresh token together.");
  const pushoverValues = [parsed.PUSHOVER_APP_TOKEN, parsed.PUSHOVER_USER_KEY].filter((value) => value.trim());
  if (pushoverValues.length !== 0 && pushoverValues.length !== 2) throw new Error("Pushover monitoring requires both app token and user key.");
  const deadManValues = [
    parsed.HEALTHCHECKS_BASELINE_PING_URL,
    parsed.HEALTHCHECKS_BASELINE_CHECK_ID,
    parsed.HEALTHCHECKS_ACTIVE_PING_URL,
    parsed.HEALTHCHECKS_ACTIVE_CHECK_ID,
    parsed.HEALTHCHECKS_API_KEY
  ]
    .filter((value) => String(value ?? "").trim());
  if (deadManValues.length !== 0 && deadManValues.length !== 5) {
    throw new Error("Healthchecks dead-man monitoring requires both ping URLs, both check ids, and the write API key together.");
  }
  return {
    token: parsed.MONITOR_API_TOKEN,
    alertmanagerWebhookToken: parsed.ALERTMANAGER_WEBHOOK_TOKEN,
    alertmanagerInternalUrl: parsed.ALERTMANAGER_INTERNAL_URL.replace(/\/+$/, ""),
    prometheusInternalUrl: parsed.PROMETHEUS_INTERNAL_URL.replace(/\/+$/, ""),
    browserHeartbeatSecret: parsed.MONITOR_BROWSER_HEARTBEAT_SECRET,
    browserAllowedOrigins: parseOrigins(parsed.MONITOR_BROWSER_ALLOWED_ORIGINS),
    targets: parseAgentTargets(parsed.MONITOR_AGENT_TARGETS),
    bind: parsed.MONITOR_SERVICE_BIND,
    port: parsed.MONITOR_SERVICE_PORT,
    intervalMs: parsed.MONITOR_SERVICE_INTERVAL_MS,
    courtCount: parsed.MONITOR_COURT_COUNT,
    healthchecksBaselinePingUrl: parsed.HEALTHCHECKS_BASELINE_PING_URL ?? null,
    healthchecksBaselineCheckId: parsed.HEALTHCHECKS_BASELINE_CHECK_ID ?? null,
    healthchecksActivePingUrl: parsed.HEALTHCHECKS_ACTIVE_PING_URL ?? null,
    healthchecksApiKey: parsed.HEALTHCHECKS_API_KEY.trim() || null,
    healthchecksActiveCheckId: parsed.HEALTHCHECKS_ACTIVE_CHECK_ID ?? null,
    healthchecksBaselineIntervalMs: parsed.HEALTHCHECKS_BASELINE_INTERVAL_MS,
    healthchecksActiveIntervalMs: parsed.HEALTHCHECKS_ACTIVE_INTERVAL_MS,
    healthchecksChannelAuditIntervalMs: parsed.HEALTHCHECKS_CHANNEL_AUDIT_INTERVAL_MS,
    supabaseUrl: parsed.SUPABASE_URL ?? null,
    supabaseServiceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY ?? null,
    monitorDashboardUrl: parsed.MONITOR_DASHBOARD_URL ?? "https://score.beachvolleyballmedia.com/admin/monitor",
    pushoverAppToken: parsed.PUSHOVER_APP_TOKEN.trim() || null,
    pushoverUserKey: parsed.PUSHOVER_USER_KEY.trim() || null,
    notificationStatusIntervalMs: parsed.NOTIFICATION_STATUS_INTERVAL_MS,
    youtubeApiKey: parsed.YOUTUBE_API_KEY.trim() || null,
    youtubeClientId: parsed.YOUTUBE_CLIENT_ID.trim() || null,
    youtubeClientSecret: parsed.YOUTUBE_CLIENT_SECRET.trim() || null,
    youtubeRefreshToken: parsed.YOUTUBE_REFRESH_TOKEN.trim() || null,
    youtubeMonitorIntervalMs: parsed.YOUTUBE_MONITOR_INTERVAL_MS
  };
}

function parseOrigins(raw: string): string[] {
  const origins = raw.split(",").map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin);
  if (origins.length === 0 || origins.length > 10) throw new Error("MONITOR_BROWSER_ALLOWED_ORIGINS must contain 1-10 origins.");
  return [...new Set(origins)];
}

const optionalRtspUrl = z.preprocess(emptyStringToUndefined, z.string().url().transform((value, context) => {
  const parsed = new URL(value);
  if (parsed.protocol !== "rtsp:" || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    context.addIssue({ code: "custom", message: "Camera-content analyzer base URL must be a credential-free RTSP origin." });
    return z.NEVER;
  }
  return parsed.toString();
}).optional());

const safeExecutablePath = z.string().trim().min(1).max(512).refine((value) => !/[\r\n\0]/.test(value));

export function parseAgentTargets(raw: string): AgentTarget[] {
  if (!raw.trim()) return [];
  const targets = raw.split(",").map((entry) => {
    const [id, roleValue, url, token, courtList, ...extra] = entry.split("|").map((value) => value.trim());
    const role = z.enum(AGENT_ROLES).parse(roleValue);
    if (extra.length || !id || !role || !url || !token) throw new Error("Invalid MONITOR_AGENT_TARGETS entry.");
    if (courtList == null) throw new Error("MONITOR_AGENT_TARGETS must include an explicit court-assignment field.");
    const assignedCourts = parseTargetCourtList(courtList);
    if (role === "compositor" && assignedCourts.length === 0) throw new Error("Compositor targets must own at least one court.");
    if (role !== "compositor" && assignedCourts.length > 0) throw new Error("Only compositor targets may own courts.");
    return {
      id: safeIdSchema.parse(id),
      role,
      url: safeHttpUrl.parse(url).replace(/\/+$/, ""),
      token: z.string().min(24).parse(token),
      assignedCourts
    };
  });
  if (new Set(targets.map((target) => target.id)).size !== targets.length) throw new Error("MONITOR_AGENT_TARGETS contains duplicate agent identifiers.");
  const assignedCourts = targets.flatMap((target) => target.assignedCourts);
  if (new Set(assignedCourts).size !== assignedCourts.length) throw new Error("MONITOR_AGENT_TARGETS assigns a court to more than one compositor.");
  return targets;
}

function parseTargetCourtList(raw: string): number[] {
  if (!raw) return [];
  const courts = raw.split("+").map((value) => Number(value.trim()));
  if (courts.some((court) => !Number.isInteger(court) || court < 1 || court > 8)) throw new Error("Target court assignments must contain court numbers 1-8 joined with '+'.");
  return [...new Set(courts)].sort((left, right) => left - right);
}

const safeIdSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:-]+$/);
const safeHttpUrl = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const safeHttpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:");
const optionalHttpUrl = z.preprocess(emptyStringToUndefined, safeHttpUrl.optional());
const optionalHttpsUrl = z.preprocess(emptyStringToUndefined, safeHttpsUrl.optional());

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}
