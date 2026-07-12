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
    MONITOR_DISK_PATH: z.string().default("/"),
    DOCKER_API_URL: safeHttpUrl.optional(),
    MEDIAMTX_API_URL: safeHttpUrl.optional(),
    MEDIAMTX_METRICS_URL: safeHttpUrl.optional(),
    LIVEKIT_METRICS_URL: safeHttpUrl.optional(),
    EGRESS_METRICS_URL: safeHttpUrl.optional(),
    EGRESS_HEALTH_URL: safeHttpUrl.optional()
  });
  const parsed = schema.parse(env);
  return {
    agentId: parsed.MONITOR_AGENT_ID,
    role: parsed.MONITOR_AGENT_ROLE,
    token: parsed.MONITOR_AGENT_TOKEN,
    bind: parsed.MONITOR_AGENT_BIND,
    port: parsed.MONITOR_AGENT_PORT,
    intervalMs: parsed.MONITOR_AGENT_INTERVAL_MS,
    containers: parsed.MONITOR_AGENT_CONTAINERS.split(",").map((value) => value.trim()).filter(Boolean).map((value) => safeIdSchema.parse(value)),
    diskPath: parsed.MONITOR_DISK_PATH,
    dockerApiUrl: parsed.DOCKER_API_URL ?? null,
    mediamtxApiUrl: parsed.MEDIAMTX_API_URL ?? null,
    mediamtxMetricsUrl: parsed.MEDIAMTX_METRICS_URL ?? null,
    livekitMetricsUrl: parsed.LIVEKIT_METRICS_URL ?? null,
    egressMetricsUrl: parsed.EGRESS_METRICS_URL ?? null,
    egressHealthUrl: parsed.EGRESS_HEALTH_URL ?? null
  };
}

export type AgentTarget = {
  id: string;
  role: AgentRole;
  url: string;
  token: string;
};

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env) {
  const schema = z.object({
    MONITOR_API_TOKEN: z.string().min(24),
    ALERTMANAGER_WEBHOOK_TOKEN: z.string().min(24),
    MONITOR_AGENT_TARGETS: z.string().default(""),
    MONITOR_SERVICE_BIND: z.string().default("127.0.0.1"),
    MONITOR_SERVICE_PORT: port.default(9110),
    MONITOR_SERVICE_INTERVAL_MS: interval.default(5_000),
    MONITOR_COURT_COUNT: z.coerce.number().int().min(1).max(8).default(8),
    HEALTHCHECKS_PING_URL: safeHttpsUrl.optional(),
    HEALTHCHECKS_INTERVAL_MS: interval.default(60_000),
    SUPABASE_URL: safeHttpsUrl.optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional()
  });
  const parsed = schema.parse(env);
  if (Boolean(parsed.SUPABASE_URL) !== Boolean(parsed.SUPABASE_SERVICE_ROLE_KEY)) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured together.");
  }
  return {
    token: parsed.MONITOR_API_TOKEN,
    alertmanagerWebhookToken: parsed.ALERTMANAGER_WEBHOOK_TOKEN,
    targets: parseAgentTargets(parsed.MONITOR_AGENT_TARGETS),
    bind: parsed.MONITOR_SERVICE_BIND,
    port: parsed.MONITOR_SERVICE_PORT,
    intervalMs: parsed.MONITOR_SERVICE_INTERVAL_MS,
    courtCount: parsed.MONITOR_COURT_COUNT,
    healthchecksPingUrl: parsed.HEALTHCHECKS_PING_URL ?? null,
    healthchecksIntervalMs: parsed.HEALTHCHECKS_INTERVAL_MS,
    supabaseUrl: parsed.SUPABASE_URL ?? null,
    supabaseServiceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY ?? null
  };
}

export function parseAgentTargets(raw: string): AgentTarget[] {
  if (!raw.trim()) return [];
  return raw.split(",").map((entry) => {
    const [id, role, url, token, ...extra] = entry.split("|").map((value) => value.trim());
    if (extra.length || !id || !role || !url || !token) throw new Error("Invalid MONITOR_AGENT_TARGETS entry.");
    return {
      id: safeIdSchema.parse(id),
      role: z.enum(AGENT_ROLES).parse(role),
      url: safeHttpUrl.parse(url).replace(/\/+$/, ""),
      token: z.string().min(24).parse(token)
    };
  });
}

const safeIdSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:-]+$/);
const safeHttpUrl = z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const safeHttpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:");
