import { z } from "zod";
import type { ServiceConfig } from "./config.js";
import type { DeadManPhoneChannelHealth } from "./contracts.js";

type ChannelAuditConfig = Pick<ServiceConfig,
  | "healthchecksApiKey"
  | "healthchecksBaselinePingUrl"
  | "healthchecksBaselineCheckId"
  | "healthchecksActivePingUrl"
  | "healthchecksActiveCheckId"
  | "healthchecksChannelAuditIntervalMs"
>;

const RETRY_INTERVAL_MS = 30_000;
const HEALTHCHECKS_API_BASE = "https://healthchecks.io/api/v3";
// Healthchecks exposes its Pushover integration with the API kind "po".
const PHONE_CHANNEL_KIND = "po";

const channelsSchema = z.object({
  channels: z.array(z.object({
    id: z.string().uuid(),
    kind: z.string().min(1)
  }).passthrough()).max(1_000)
}).passthrough();

const checkSchema = z.object({
  channels: z.string()
}).passthrough();

export class HealthchecksChannelAudit {
  private readonly configured: boolean;
  private state: DeadManPhoneChannelHealth["state"];
  private baselineAttached: boolean | null = null;
  private activeAttached: boolean | null = null;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastAttemptAtMs: number | null = null;

  constructor(
    private readonly config: ChannelAuditConfig,
    private readonly send: typeof fetch = fetch
  ) {
    this.configured = Boolean(
      config.healthchecksApiKey
      && config.healthchecksBaselinePingUrl
      && config.healthchecksBaselineCheckId
      && config.healthchecksActivePingUrl
      && config.healthchecksActiveCheckId
    );
    this.state = this.configured ? "UNKNOWN" : "NOT_APPLICABLE";
  }

  health(): DeadManPhoneChannelHealth {
    return {
      configured: this.configured,
      state: this.state,
      baselineAttached: this.baselineAttached,
      activeAttached: this.activeAttached,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt
    };
  }

  async maintain(now = new Date()): Promise<void> {
    if (!this.configured || !this.due(now.getTime())) return;
    this.lastAttemptAtMs = now.getTime();
    try {
      const [channels, baseline, active] = await Promise.all([
        this.get(`${HEALTHCHECKS_API_BASE}/channels/`, channelsSchema),
        this.getCheck(this.config.healthchecksBaselineCheckId as string),
        this.getCheck(this.config.healthchecksActiveCheckId as string)
      ]);
      const phoneChannelIds = new Set(
        channels.channels.filter((channel) => channel.kind === PHONE_CHANNEL_KIND).map((channel) => channel.id)
      );
      this.baselineAttached = attachedToPhone(baseline.channels, phoneChannelIds);
      this.activeAttached = attachedToPhone(active.channels, phoneChannelIds);
      this.state = this.baselineAttached && this.activeAttached ? "HEALTHY" : "DEGRADED";
      this.lastSuccessAt = now.toISOString();
      this.lastFailureAt = null;
    } catch {
      this.state = "DEGRADED";
      this.lastFailureAt = now.toISOString();
    }
  }

  private async getCheck(checkId: string) {
    return this.get(`${HEALTHCHECKS_API_BASE}/checks/${encodeURIComponent(checkId)}`, checkSchema);
  }

  private async get<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.send(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-api-key": this.config.healthchecksApiKey as string
      },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`Healthchecks channel audit failed with HTTP ${response.status}.`);
    return schema.parse(await response.json());
  }

  private due(nowMs: number): boolean {
    if (this.lastAttemptAtMs == null) return true;
    const intervalMs = this.lastFailureAt == null
      ? this.config.healthchecksChannelAuditIntervalMs
      : Math.min(this.config.healthchecksChannelAuditIntervalMs, RETRY_INTERVAL_MS);
    return nowMs - this.lastAttemptAtMs >= intervalMs;
  }
}

function attachedToPhone(rawChannelIds: string, phoneChannelIds: Set<string>): boolean {
  return rawChannelIds.split(",").map((value) => value.trim()).filter(Boolean).some((id) => phoneChannelIds.has(id));
}
