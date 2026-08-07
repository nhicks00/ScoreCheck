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
    EGRESS_SUPERVISOR_STATE_PATH: optionalAbsolutePath,
    PROGRAM_WARMER_STATE_PATH: optionalAbsolutePath,
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
    egressSupervisorStatePath: parsed.EGRESS_SUPERVISOR_STATE_PATH ?? null,
    programWarmerStatePath: parsed.PROGRAM_WARMER_STATE_PATH ?? null,
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
    MONITOR_SERVICE_INTERVAL_MS: interval.default(1_000),
    MONITOR_LOCAL_OUTBOX_PATH: z.string().trim().min(1).max(512).default("/var/lib/scorecheck-monitoring/incident-outbox.json")
      .refine((value) => value.startsWith("/") && !/[\r\n\0]/.test(value) && !value.split("/").includes("..")),
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
    YOUTUBE_MONITOR_INTERVAL_MS: z.coerce.number().int().min(30_000).max(300_000).default(60_000),
    MONITOR_PEPLINK_REQUIRED: z.enum(["true", "false"]).default("false"),
    MONITOR_PEPLINK_CLIENT_ID: z.string().default(""),
    MONITOR_PEPLINK_CLIENT_SECRET: z.string().default(""),
    MONITOR_PEPLINK_ORGANIZATION_ID: z.string().default(""),
    MONITOR_PEPLINK_GROUP_ID: z.string().default(""),
    MONITOR_PEPLINK_DEVICE_ID: z.string().default(""),
    MONITOR_PEPLINK_PRODUCT_CODE: z.string().default(""),
    MONITOR_PEPLINK_HARDWARE_VERSION: z.string().default(""),
    MONITOR_PEPLINK_FIRMWARE_VERSION: z.string().default(""),
    MONITOR_PEPLINK_SPEEDFUSION_PROFILE_NAME: z.string().default(""),
    MONITOR_PEPLINK_CAMERA_SSID: z.string().default(""),
    MONITOR_PEPLINK_WANS_JSON: z.string().default(""),
    MONITOR_PEPLINK_POLL_INTERVAL_MS: z.coerce.number().int().min(15_000).max(300_000).default(30_000),
    MONITOR_UNIFI_REQUIRED: z.enum(["true", "false"]).default("false"),
    MONITOR_UNIFI_API_KEY: z.string().default(""),
    MONITOR_UNIFI_BASE_URL: z.string().default(""),
    MONITOR_UNIFI_SITE_ID: z.string().default(""),
    MONITOR_UNIFI_ACCESS_POINTS_JSON: z.string().default(""),
    MONITOR_UNIFI_POLL_INTERVAL_MS: z.coerce.number().int().min(15_000).max(300_000).default(30_000),
    MONITOR_NETWORK_SWITCH_REQUIRED: z.enum(["true", "false"]).default("false"),
    MONITOR_NETWORK_SWITCH_EXPORTER_URL: z.string().default(""),
    MONITOR_NETWORK_SWITCH_TARGET: z.string().default(""),
    MONITOR_NETWORK_SWITCH_MODEL: z.string().default(""),
    MONITOR_NETWORK_SWITCH_FIRMWARE_VERSION: z.string().default(""),
    MONITOR_NETWORK_SWITCH_PORTS_JSON: z.string().default(""),
    MONITOR_NETWORK_SWITCH_POLL_INTERVAL_MS: z.coerce.number().int().min(15_000).max(300_000).default(30_000)
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
  const unifi = parseUniFiConfig(parsed);
  const peplink = parsePeplinkConfig(parsed);
  const networkSwitch = parseNetworkSwitchConfig(parsed);
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
    localOutboxPath: parsed.MONITOR_LOCAL_OUTBOX_PATH,
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
    youtubeMonitorIntervalMs: parsed.YOUTUBE_MONITOR_INTERVAL_MS,
    peplink,
    unifi,
    networkSwitch
  };
}

export type PeplinkWanBinding = {
  id: number;
  name: string;
  required: boolean;
};

export type PeplinkConfig = {
  required: boolean;
  configured: boolean;
  clientId: string | null;
  clientSecret: string | null;
  organizationId: string | null;
  groupId: number | null;
  deviceId: number | null;
  productCode: string | null;
  hardwareVersion: string | null;
  firmwareVersion: string | null;
  speedFusionProfileName: string | null;
  cameraSsid: string | null;
  wans: PeplinkWanBinding[];
  pollIntervalMs: number;
};

function parsePeplinkConfig(parsed: {
  MONITOR_PEPLINK_REQUIRED: "true" | "false";
  MONITOR_PEPLINK_CLIENT_ID: string;
  MONITOR_PEPLINK_CLIENT_SECRET: string;
  MONITOR_PEPLINK_ORGANIZATION_ID: string;
  MONITOR_PEPLINK_GROUP_ID: string;
  MONITOR_PEPLINK_DEVICE_ID: string;
  MONITOR_PEPLINK_PRODUCT_CODE: string;
  MONITOR_PEPLINK_HARDWARE_VERSION: string;
  MONITOR_PEPLINK_FIRMWARE_VERSION: string;
  MONITOR_PEPLINK_SPEEDFUSION_PROFILE_NAME: string;
  MONITOR_PEPLINK_CAMERA_SSID: string;
  MONITOR_PEPLINK_WANS_JSON: string;
  MONITOR_PEPLINK_POLL_INTERVAL_MS: number;
}): PeplinkConfig {
  const required = parsed.MONITOR_PEPLINK_REQUIRED === "true";
  const raw = {
    clientId: parsed.MONITOR_PEPLINK_CLIENT_ID.trim(),
    clientSecret: parsed.MONITOR_PEPLINK_CLIENT_SECRET.trim(),
    organizationId: parsed.MONITOR_PEPLINK_ORGANIZATION_ID.trim(),
    groupId: parsed.MONITOR_PEPLINK_GROUP_ID.trim(),
    deviceId: parsed.MONITOR_PEPLINK_DEVICE_ID.trim(),
    productCode: parsed.MONITOR_PEPLINK_PRODUCT_CODE.trim(),
    hardwareVersion: parsed.MONITOR_PEPLINK_HARDWARE_VERSION.trim(),
    firmwareVersion: parsed.MONITOR_PEPLINK_FIRMWARE_VERSION.trim(),
    speedFusionProfileName: parsed.MONITOR_PEPLINK_SPEEDFUSION_PROFILE_NAME.trim(),
    cameraSsid: parsed.MONITOR_PEPLINK_CAMERA_SSID.trim(),
    wans: parsed.MONITOR_PEPLINK_WANS_JSON.trim()
  };
  const configuredValues = Object.values(raw).filter(Boolean).length;
  if (configuredValues === 0) {
    if (required) throw new Error("Required Peplink monitoring is not configured.");
    return {
      required,
      configured: false,
      clientId: null,
      clientSecret: null,
      organizationId: null,
      groupId: null,
      deviceId: null,
      productCode: null,
      hardwareVersion: null,
      firmwareVersion: null,
      speedFusionProfileName: null,
      cameraSsid: null,
      wans: [],
      pollIntervalMs: parsed.MONITOR_PEPLINK_POLL_INTERVAL_MS
    };
  }
  if (configuredValues !== Object.keys(raw).length) throw new Error("Peplink monitoring requires its complete InControl, identity, SpeedFusion, camera WLAN, and WAN contract together.");
  if (!/^[A-Za-z0-9_-]{24,}$/.test(raw.clientId) || !/^[A-Za-z0-9_-]{24,}$/.test(raw.clientSecret)) {
    throw new Error("Peplink InControl client credentials are invalid.");
  }
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(raw.organizationId)) throw new Error("Peplink organization id is invalid.");
  const groupId = z.coerce.number().int().positive().parse(raw.groupId);
  const deviceId = z.coerce.number().int().positive().parse(raw.deviceId);
  if (raw.productCode !== "MAX-BR1-PRO-5GK-T-PRM") throw new Error("Peplink product code must match the commissioned MAX BR1 Pro 5G HW3.");
  if (raw.hardwareVersion !== "3") throw new Error("Peplink hardware version must be 3.");
  if (raw.firmwareVersion !== "8.6.0 build 6450") throw new Error("Peplink firmware must be the commissioned 8.6.0 build 6450 release.");
  if (!/^[A-Za-z0-9_. -]{1,80}$/.test(raw.speedFusionProfileName)) throw new Error("Peplink SpeedFusion profile name is invalid.");
  if (raw.cameraSsid.length > 32 || /[\r\n\0]/.test(raw.cameraSsid)) throw new Error("Peplink camera SSID is invalid.");
  let wans: PeplinkWanBinding[];
  try {
    wans = z.array(z.object({
      id: z.number().int().positive().max(64),
      name: z.string().trim().min(1).max(80),
      required: z.boolean()
    }).strict()).min(1).max(16).parse(JSON.parse(raw.wans));
  } catch {
    throw new Error("MONITOR_PEPLINK_WANS_JSON must contain valid WAN bindings.");
  }
  if (new Set(wans.map((wan) => wan.id)).size !== wans.length || new Set(wans.map((wan) => wan.name)).size !== wans.length) {
    throw new Error("Peplink WAN ids and names must be unique.");
  }
  return {
    required,
    configured: true,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    organizationId: raw.organizationId,
    groupId,
    deviceId,
    productCode: raw.productCode,
    hardwareVersion: raw.hardwareVersion,
    firmwareVersion: raw.firmwareVersion,
    speedFusionProfileName: raw.speedFusionProfileName,
    cameraSsid: raw.cameraSsid,
    wans,
    pollIntervalMs: parsed.MONITOR_PEPLINK_POLL_INTERVAL_MS
  };
}

export type NetworkSwitchPortBinding = {
  id: string;
  name: string;
  role: "access_point" | "router_uplink" | "other";
  expected: boolean;
};

export type NetworkSwitchConfig = {
  required: boolean;
  configured: boolean;
  exporterUrl: string | null;
  target: string | null;
  model: string | null;
  firmwareVersion: string | null;
  ports: NetworkSwitchPortBinding[];
  pollIntervalMs: number;
};

function parseNetworkSwitchConfig(parsed: {
  MONITOR_NETWORK_SWITCH_REQUIRED: "true" | "false";
  MONITOR_NETWORK_SWITCH_EXPORTER_URL: string;
  MONITOR_NETWORK_SWITCH_TARGET: string;
  MONITOR_NETWORK_SWITCH_MODEL: string;
  MONITOR_NETWORK_SWITCH_FIRMWARE_VERSION: string;
  MONITOR_NETWORK_SWITCH_PORTS_JSON: string;
  MONITOR_NETWORK_SWITCH_POLL_INTERVAL_MS: number;
}): NetworkSwitchConfig {
  const required = parsed.MONITOR_NETWORK_SWITCH_REQUIRED === "true";
  const raw = {
    exporterUrl: parsed.MONITOR_NETWORK_SWITCH_EXPORTER_URL.trim(),
    target: parsed.MONITOR_NETWORK_SWITCH_TARGET.trim(),
    model: parsed.MONITOR_NETWORK_SWITCH_MODEL.trim(),
    firmwareVersion: parsed.MONITOR_NETWORK_SWITCH_FIRMWARE_VERSION.trim(),
    ports: parsed.MONITOR_NETWORK_SWITCH_PORTS_JSON.trim()
  };
  const configuredValues = Object.values(raw).filter(Boolean).length;
  if (configuredValues === 0) {
    if (required) throw new Error("Required network-switch monitoring is not configured.");
    return {
      required,
      configured: false,
      exporterUrl: null,
      target: null,
      model: null,
      firmwareVersion: null,
      ports: [],
      pollIntervalMs: parsed.MONITOR_NETWORK_SWITCH_POLL_INTERVAL_MS
    };
  }
  if (configuredValues !== Object.keys(raw).length) throw new Error("Network-switch monitoring requires exporter URL, target, model, firmware, and port bindings together.");
  const exporterUrl = parseInternalExporterUrl(raw.exporterUrl);
  if (!/^(?:(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+|(?:\d{1,3}\.){3}\d{1,3})(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?$/.test(raw.target) || raw.target.length > 259) {
    throw new Error("MONITOR_NETWORK_SWITCH_TARGET must be a hostname or IPv4 address with an optional valid port.");
  }
  let ports: NetworkSwitchPortBinding[];
  try {
    ports = z.array(z.object({
      id: z.string().regex(/^(?:[1-9]|1[0-2])$/),
      name: z.string().trim().min(1).max(80),
      role: z.enum(["access_point", "router_uplink", "other"]),
      expected: z.boolean()
    }).strict()).min(1).max(12).parse(JSON.parse(raw.ports));
  } catch {
    throw new Error("MONITOR_NETWORK_SWITCH_PORTS_JSON must contain valid port bindings for ports 1-12.");
  }
  if (new Set(ports.map((portBinding) => portBinding.id)).size !== ports.length) throw new Error("Network-switch port ids must be unique.");
  return {
    required,
    configured: true,
    exporterUrl,
    target: raw.target,
    model: raw.model,
    firmwareVersion: raw.firmwareVersion,
    ports,
    pollIntervalMs: parsed.MONITOR_NETWORK_SWITCH_POLL_INTERVAL_MS
  };
}

function parseInternalExporterUrl(raw: string): string {
  const value = new URL(raw);
  if (value.protocol !== "http:" || value.username || value.password || value.search || value.hash || !["", "/"].includes(value.pathname)) {
    throw new Error("MONITOR_NETWORK_SWITCH_EXPORTER_URL must be a credential-free internal HTTP origin.");
  }
  return value.toString().replace(/\/+$/, "");
}

export type UniFiAccessPointBinding = {
  name: string;
  deviceId: string;
  macAddress: string;
  expected: boolean;
};

export type UniFiConfig = {
  required: boolean;
  configured: boolean;
  apiKey: string | null;
  baseUrl: string | null;
  siteId: string | null;
  accessPoints: UniFiAccessPointBinding[];
  pollIntervalMs: number;
};

function parseUniFiConfig(parsed: {
  MONITOR_UNIFI_REQUIRED: "true" | "false";
  MONITOR_UNIFI_API_KEY: string;
  MONITOR_UNIFI_BASE_URL: string;
  MONITOR_UNIFI_SITE_ID: string;
  MONITOR_UNIFI_ACCESS_POINTS_JSON: string;
  MONITOR_UNIFI_POLL_INTERVAL_MS: number;
}): UniFiConfig {
  const required = parsed.MONITOR_UNIFI_REQUIRED === "true";
  const raw = {
    apiKey: parsed.MONITOR_UNIFI_API_KEY.trim(),
    baseUrl: parsed.MONITOR_UNIFI_BASE_URL.trim(),
    siteId: parsed.MONITOR_UNIFI_SITE_ID.trim(),
    accessPoints: parsed.MONITOR_UNIFI_ACCESS_POINTS_JSON.trim()
  };
  const configuredValues = Object.values(raw).filter(Boolean).length;
  if (configuredValues === 0 && !required) {
    return {
      required,
      configured: false,
      apiKey: null,
      baseUrl: null,
      siteId: null,
      accessPoints: [],
      pollIntervalMs: parsed.MONITOR_UNIFI_POLL_INTERVAL_MS
    };
  }
  if (configuredValues !== 4) throw new Error("UniFi monitoring requires its API key, base URL, site id, and access-point bindings together.");
  const baseUrl = parseUniFiBaseUrl(raw.baseUrl);
  const uuid = z.string().uuid();
  const siteId = uuid.parse(raw.siteId);
  let value: unknown;
  try {
    value = JSON.parse(raw.accessPoints);
  } catch {
    throw new Error("MONITOR_UNIFI_ACCESS_POINTS_JSON must be valid JSON.");
  }
  const bindingSchema = z.object({
    name: z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9_. -]+$/),
    deviceId: uuid,
    macAddress: z.string().trim().toLowerCase().regex(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/),
    expected: z.boolean()
  }).strict();
  const accessPoints = z.array(bindingSchema).length(3).parse(value);
  if (new Set(accessPoints.map((entry) => entry.name)).size !== accessPoints.length
    || new Set(accessPoints.map((entry) => entry.deviceId)).size !== accessPoints.length
    || new Set(accessPoints.map((entry) => entry.macAddress)).size !== accessPoints.length) {
    throw new Error("UniFi access-point names, device ids, and MAC addresses must be unique.");
  }
  if (!accessPoints.some((entry) => entry.expected)) throw new Error("UniFi monitoring requires at least one expected access point.");
  return {
    required,
    configured: true,
    apiKey: raw.apiKey,
    baseUrl,
    siteId,
    accessPoints,
    pollIntervalMs: parsed.MONITOR_UNIFI_POLL_INTERVAL_MS
  };
}

function parseUniFiBaseUrl(raw: string): string {
  const value = new URL(raw);
  if (value.protocol !== "https:" || value.username || value.password || value.search || value.hash
    || value.pathname.replace(/\/+$/, "") !== "/proxy/network/integration/v1") {
    throw new Error("MONITOR_UNIFI_BASE_URL must be a credential-free HTTPS UniFi Network integration API URL.");
  }
  return value.toString().replace(/\/+$/, "");
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
const optionalAbsolutePath = z.preprocess(emptyStringToUndefined, z.string().trim().min(1).max(512)
  .refine((value) => value.startsWith("/") && !/[\r\n\0]/.test(value) && !value.split("/").includes(".."))
  .optional());

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
