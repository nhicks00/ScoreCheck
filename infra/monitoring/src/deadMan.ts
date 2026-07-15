import type { ServiceConfig } from "./config.js";
import type { DeadManHealth } from "./contracts.js";
import { HealthchecksChannelAudit } from "./healthchecksChannelAudit.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

type DeadManConfig = Pick<ServiceConfig,
  | "healthchecksBaselinePingUrl"
  | "healthchecksBaselineCheckId"
  | "healthchecksActivePingUrl"
  | "healthchecksApiKey"
  | "healthchecksActiveCheckId"
  | "healthchecksBaselineIntervalMs"
  | "healthchecksActiveIntervalMs"
  | "healthchecksChannelAuditIntervalMs"
>;

type CheckRuntime = DeadManHealth["baseline"] & {
  lastAttemptAtMs: number | null;
};

const RETRY_INTERVAL_MS = 30_000;
const ACTIVE_RECOVERY_SETTLE_MS = 30_000;
const TEST_GATE_ALERT_HEADROOM_SECONDS = 30;
const HEALTHCHECKS_API_BASE = "https://healthchecks.io/api/v3";

export const deadManTestGateArmSchema = z.object({
  check: z.enum(["baseline", "active"]),
  durationSeconds: z.number().int().min(90).max(1_800),
  actor: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:@-]+$/),
  reason: z.string().trim().min(3).max(300).refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
}).strict();

export type DeadManTestGateArmRequest = z.infer<typeof deadManTestGateArmSchema>;
export type DeadManTestGate = {
  id: string;
  check: "baseline" | "active";
  phase: "WITHHOLDING" | "RECOVERING" | "WAITING_TO_PAUSE";
  actor: string;
  reason: string;
  armedAt: string;
  withholdFrom: string;
  expiresAt: string;
  expectedAlertAt: string;
  providerTimeoutSeconds: number;
  providerGraceSeconds: number;
  recoveryReason: "expired" | "operator_cancelled" | "coverage_started" | null;
  recoveryRequestedAt: string | null;
  recoveryPingAt: string | null;
  lastRecoveryAttemptAt: string | null;
};

const providerCheckSchema = z.object({
  timeout: z.number().int().positive(),
  grace: z.number().int().nonnegative()
}).passthrough();

export class DeadManTestGateError extends Error {
  constructor(
    public readonly code: "TEST_GATE_ALREADY_ACTIVE" | "TEST_GATE_DURATION_TOO_SHORT" | "DEAD_MAN_PROVIDER_UNAVAILABLE" | "TEST_GATE_NOT_ACTIVE" | "TEST_GATE_ENVIRONMENT_UNSAFE",
    public readonly status: 400 | 404 | 409 | 503,
    message: string
  ) {
    super(message);
  }
}

export class ExternalDeadMan {
  private readonly baseline: CheckRuntime;
  private readonly active: CheckRuntime;
  private readonly channelAudit: HealthchecksChannelAudit;
  private testGateState: DeadManTestGate | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: DeadManConfig,
    private readonly send: typeof fetch = fetch
  ) {
    this.baseline = checkRuntime(Boolean(config.healthchecksBaselinePingUrl));
    this.active = checkRuntime(Boolean(config.healthchecksActivePingUrl));
    this.channelAudit = new HealthchecksChannelAudit(config, send);
  }

  health(): DeadManHealth {
    const checks = [this.baseline, this.active].filter((check) => check.configured);
    const failed = checks.some((check) => check.lastFailureAt != null);
    const unverified = checks.some((check) => check.lastSuccessAt == null);
    const checkState = checks.length === 0 ? "NOT_APPLICABLE" : failed ? "DEGRADED" : unverified ? "UNKNOWN" : "HEALTHY";
    const phoneChannel = this.channelAudit.health();
    return {
      state: combinedState(checkState, phoneChannel.state),
      baseline: publicCheck(this.baseline),
      active: publicCheck(this.active),
      phoneChannel
    };
  }

  testGate(): DeadManTestGate | null {
    return this.testGateState ? { ...this.testGateState } : null;
  }

  async armTestGate(input: DeadManTestGateArmRequest, now = new Date()): Promise<DeadManTestGate> {
    return this.serialized(async () => {
      if (this.testGateState) {
        throw new DeadManTestGateError("TEST_GATE_ALREADY_ACTIVE", 409, "A dead-man test gate is already active.");
      }
      const contract = await this.providerContract(input.check);
      const minimumDurationSeconds = contract.timeout + contract.grace + TEST_GATE_ALERT_HEADROOM_SECONDS;
      if (input.durationSeconds < minimumDurationSeconds) {
        throw new DeadManTestGateError(
          "TEST_GATE_DURATION_TOO_SHORT",
          400,
          `Test duration must be at least ${minimumDurationSeconds} seconds for the current provider deadline.`
        );
      }
      const runtime = this.runtime(input.check);
      const pingUrl = this.pingUrl(input.check);
      if (!pingUrl || !await this.perform(runtime, "RUNNING", now, () => this.post(pingUrl))) {
        throw new DeadManTestGateError("DEAD_MAN_PROVIDER_UNAVAILABLE", 503, "The dead-man provider could not establish a fresh baseline.");
      }
      const withholdFromMs = now.getTime();
      this.testGateState = {
        id: randomUUID(),
        check: input.check,
        phase: "WITHHOLDING",
        actor: input.actor,
        reason: input.reason,
        armedAt: now.toISOString(),
        withholdFrom: now.toISOString(),
        expiresAt: new Date(withholdFromMs + input.durationSeconds * 1_000).toISOString(),
        expectedAlertAt: new Date(withholdFromMs + (contract.timeout + contract.grace) * 1_000).toISOString(),
        providerTimeoutSeconds: contract.timeout,
        providerGraceSeconds: contract.grace,
        recoveryReason: null,
        recoveryRequestedAt: null,
        recoveryPingAt: null,
        lastRecoveryAttemptAt: null
      };
      console.log(`external dead-man test gate armed id=${this.testGateState.id} check=${input.check} actor=${input.actor} expires=${this.testGateState.expiresAt} expected_alert=${this.testGateState.expectedAlertAt}`);
      return { ...this.testGateState };
    });
  }

  async cancelTestGate(now = new Date()): Promise<DeadManTestGate | null> {
    return this.serialized(async () => {
      if (!this.testGateState) {
        throw new DeadManTestGateError("TEST_GATE_NOT_ACTIVE", 404, "No dead-man test gate is active.");
      }
      this.requestRecovery("operator_cancelled", now);
      await this.maintainTestGate(false, now);
      return this.testGate();
    });
  }

  async maintain(coverageExpected: boolean, now = new Date()): Promise<void> {
    await this.serialized(async () => {
      await this.maintainTestGate(coverageExpected, now);
      const withheldCheck = this.testGateState?.check;
      await Promise.all([
        withheldCheck === "baseline" ? Promise.resolve() : this.maintainBaseline(now),
        withheldCheck === "active" ? Promise.resolve() : this.maintainActive(coverageExpected, now),
        this.channelAudit.maintain(now)
      ]);
    });
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
    // A service restart clears in-memory test state. Establishing a live ping
    // before the idle pause guarantees that an interrupted active-check test
    // recovers instead of being stranded in an ambiguous provider state.
    if (this.active.mode === "UNKNOWN") {
      if (!await this.perform(this.active, "RUNNING", now, () => this.post(pingUrl))) return;
    }
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
  ): Promise<boolean> {
    runtime.lastAttemptAtMs = now.getTime();
    try {
      await action();
      runtime.mode = successMode;
      runtime.lastSuccessAt = now.toISOString();
      runtime.lastFailureAt = null;
      return true;
    } catch {
      runtime.lastFailureAt = now.toISOString();
      return false;
    }
  }

  private async maintainTestGate(coverageExpected: boolean, now: Date): Promise<void> {
    const gate = this.testGateState;
    if (!gate) return;
    if (gate.phase === "WITHHOLDING") {
      if (coverageExpected) this.requestRecovery("coverage_started", now);
      else if (now.getTime() >= Date.parse(gate.expiresAt)) this.requestRecovery("expired", now);
      else return;
    }
    const current = this.testGateState;
    if (!current) return;
    if (current.phase === "RECOVERING") {
      if (current.recoveryReason == null) return;
      const lastAttemptAtMs = current.lastRecoveryAttemptAt == null ? null : Date.parse(current.lastRecoveryAttemptAt);
      if (lastAttemptAtMs != null && now.getTime() - lastAttemptAtMs < RETRY_INTERVAL_MS) return;
      current.lastRecoveryAttemptAt = now.toISOString();
      const recovered = await this.perform(
        this.runtime(current.check),
        "RUNNING",
        now,
        () => this.post(this.pingUrl(current.check) as string)
      );
      if (!recovered) return;
      current.recoveryPingAt = now.toISOString();
      if (current.check === "baseline" || coverageExpected) {
        this.completeTestGate(now, coverageExpected ? "coverage_started" : current.recoveryReason);
        return;
      }
      current.phase = "WAITING_TO_PAUSE";
      return;
    }
    if (current.phase !== "WAITING_TO_PAUSE") return;
    if (coverageExpected) {
      this.completeTestGate(now, "coverage_started");
      return;
    }
    if (current.recoveryPingAt == null || now.getTime() - Date.parse(current.recoveryPingAt) < ACTIVE_RECOVERY_SETTLE_MS) return;
    if (current.recoveryReason == null) return;
    const lastAttemptAtMs = current.lastRecoveryAttemptAt == null ? null : Date.parse(current.lastRecoveryAttemptAt);
    if (lastAttemptAtMs != null && now.getTime() - lastAttemptAtMs < RETRY_INTERVAL_MS) return;
    const checkId = this.config.healthchecksActiveCheckId;
    const apiKey = this.config.healthchecksApiKey;
    if (!checkId || !apiKey) return;
    current.lastRecoveryAttemptAt = now.toISOString();
    const paused = await this.perform(this.active, "PAUSED", now, () => this.post(
      `${HEALTHCHECKS_API_BASE}/checks/${encodeURIComponent(checkId)}/pause`,
      { "x-api-key": apiKey }
    ));
    if (paused) this.completeTestGate(now, current.recoveryReason);
  }

  private requestRecovery(reason: NonNullable<DeadManTestGate["recoveryReason"]>, now: Date): void {
    if (!this.testGateState || this.testGateState.phase !== "WITHHOLDING") return;
    this.testGateState.phase = "RECOVERING";
    this.testGateState.recoveryReason = reason;
    this.testGateState.recoveryRequestedAt = now.toISOString();
    console.log(`external dead-man test gate recovery requested id=${this.testGateState.id} check=${this.testGateState.check} reason=${reason}`);
  }

  private completeTestGate(now: Date, reason: NonNullable<DeadManTestGate["recoveryReason"]>): void {
    const gate = this.testGateState;
    if (!gate) return;
    console.log(`external dead-man test gate recovered id=${gate.id} check=${gate.check} reason=${reason} completed=${now.toISOString()}`);
    this.testGateState = null;
  }

  private async providerContract(check: DeadManTestGate["check"]): Promise<z.infer<typeof providerCheckSchema>> {
    const checkId = check === "baseline" ? this.config.healthchecksBaselineCheckId : this.config.healthchecksActiveCheckId;
    const apiKey = this.config.healthchecksApiKey;
    if (!checkId || !apiKey || !this.pingUrl(check)) {
      throw new DeadManTestGateError("DEAD_MAN_PROVIDER_UNAVAILABLE", 503, "The selected dead-man check is not configured.");
    }
    try {
      const response = await this.send(`${HEALTHCHECKS_API_BASE}/checks/${encodeURIComponent(checkId)}`, {
        method: "GET",
        headers: { accept: "application/json", "x-api-key": apiKey },
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return providerCheckSchema.parse(await response.json());
    } catch {
      throw new DeadManTestGateError("DEAD_MAN_PROVIDER_UNAVAILABLE", 503, "The dead-man provider contract could not be verified.");
    }
  }

  private runtime(check: DeadManTestGate["check"]): CheckRuntime {
    return check === "baseline" ? this.baseline : this.active;
  }

  private pingUrl(check: DeadManTestGate["check"]): string | null {
    return check === "baseline" ? this.config.healthchecksBaselinePingUrl : this.config.healthchecksActivePingUrl;
  }

  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
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

function combinedState(
  checkState: DeadManHealth["state"],
  phoneState: DeadManHealth["phoneChannel"]["state"]
): DeadManHealth["state"] {
  if (checkState === "DEGRADED" || phoneState === "DEGRADED") return "DEGRADED";
  if (checkState === "UNKNOWN" || phoneState === "UNKNOWN") return "UNKNOWN";
  return checkState;
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
