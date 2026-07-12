import type { ServiceConfig } from "./config.js";
import type { DeadManHealth } from "./contracts.js";

type DeadManConfig = Pick<ServiceConfig,
  | "healthchecksBaselinePingUrl"
  | "healthchecksActivePingUrl"
  | "healthchecksApiKey"
  | "healthchecksActiveCheckId"
  | "healthchecksBaselineIntervalMs"
  | "healthchecksActiveIntervalMs"
>;

type CheckRuntime = DeadManHealth["baseline"] & {
  lastAttemptAtMs: number | null;
};

const RETRY_INTERVAL_MS = 30_000;

export class ExternalDeadMan {
  private readonly baseline: CheckRuntime;
  private readonly active: CheckRuntime;

  constructor(
    private readonly config: DeadManConfig,
    private readonly send: typeof fetch = fetch
  ) {
    this.baseline = checkRuntime(Boolean(config.healthchecksBaselinePingUrl));
    this.active = checkRuntime(Boolean(config.healthchecksActivePingUrl));
  }

  health(): DeadManHealth {
    const checks = [this.baseline, this.active].filter((check) => check.configured);
    const failed = checks.some((check) => check.lastFailureAt != null);
    const unverified = checks.some((check) => check.lastSuccessAt == null);
    return {
      state: checks.length === 0 ? "NOT_APPLICABLE" : failed ? "DEGRADED" : unverified ? "UNKNOWN" : "HEALTHY",
      baseline: publicCheck(this.baseline),
      active: publicCheck(this.active)
    };
  }

  async maintain(coverageExpected: boolean, now = new Date()): Promise<void> {
    await Promise.all([
      this.maintainBaseline(now),
      this.maintainActive(coverageExpected, now)
    ]);
  }

  private async maintainBaseline(now: Date): Promise<void> {
    const url = this.config.healthchecksBaselinePingUrl;
    if (!url || !due(this.baseline, this.config.healthchecksBaselineIntervalMs, now.getTime())) return;
    await this.perform(this.baseline, "RUNNING", now, () => this.post(url));
  }

  private async maintainActive(coverageExpected: boolean, now: Date): Promise<void> {
    const pingUrl = this.config.healthchecksActivePingUrl;
    if (!pingUrl) return;
    if (coverageExpected) {
      if (this.active.mode === "RUNNING" && !due(this.active, this.config.healthchecksActiveIntervalMs, now.getTime())) return;
      await this.perform(this.active, "RUNNING", now, () => this.post(pingUrl));
      return;
    }
    if (this.active.mode === "PAUSED" && this.active.lastFailureAt == null) return;
    if (this.active.mode !== "RUNNING" && !due(this.active, RETRY_INTERVAL_MS, now.getTime())) return;
    const checkId = this.config.healthchecksActiveCheckId;
    const apiKey = this.config.healthchecksApiKey;
    if (!checkId || !apiKey) return;
    await this.perform(this.active, "PAUSED", now, () => this.post(
      `https://healthchecks.io/api/v3/checks/${encodeURIComponent(checkId)}/pause`,
      { "x-api-key": apiKey }
    ));
  }

  private async perform(
    runtime: CheckRuntime,
    successMode: "RUNNING" | "PAUSED",
    now: Date,
    action: () => Promise<void>
  ): Promise<void> {
    runtime.lastAttemptAtMs = now.getTime();
    try {
      await action();
      runtime.mode = successMode;
      runtime.lastSuccessAt = now.toISOString();
      runtime.lastFailureAt = null;
    } catch {
      runtime.lastFailureAt = now.toISOString();
    }
  }

  private async post(url: string, headers: Record<string, string> = {}): Promise<void> {
    const response = await this.send(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`Healthchecks request failed with HTTP ${response.status}.`);
  }
}

function checkRuntime(configured: boolean): CheckRuntime {
  return {
    configured,
    mode: configured ? "UNKNOWN" : "NOT_CONFIGURED",
    lastSuccessAt: null,
    lastFailureAt: null,
    lastAttemptAtMs: null
  };
}

function publicCheck(runtime: CheckRuntime): DeadManHealth["baseline"] {
  return {
    configured: runtime.configured,
    mode: runtime.mode,
    lastSuccessAt: runtime.lastSuccessAt,
    lastFailureAt: runtime.lastFailureAt
  };
}

function due(runtime: CheckRuntime, intervalMs: number, nowMs: number): boolean {
  if (runtime.lastAttemptAtMs == null) return true;
  const waitMs = runtime.lastFailureAt == null ? intervalMs : Math.min(intervalMs, RETRY_INTERVAL_MS);
  return nowMs - runtime.lastAttemptAtMs >= waitMs;
}
