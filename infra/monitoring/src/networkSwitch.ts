import type { NetworkSwitchConfig, NetworkSwitchPortBinding } from "./config.js";
import type { HealthState, NetworkSwitchMonitorSnapshot } from "./contracts.js";

type Fetch = typeof fetch;
type Labels = Record<string, string>;
type Sample = { labels: Labels; value: number };
type CounterSample = {
  sampledAtMs: number;
  rxOctets: number;
  txOctets: number;
  inputErrors: number;
  outputErrors: number;
  inputDiscards: number;
  outputDiscards: number;
};

const MODULES = "system,if_mib,linovision_poe";

export class NetworkSwitchCollector {
  readonly #config: NetworkSwitchConfig;
  readonly #fetch: Fetch;
  #nextPollAtMs = 0;
  #refreshing = false;
  #snapshot: NetworkSwitchMonitorSnapshot;
  #counters = new Map<string, CounterSample>();

  constructor(config: NetworkSwitchConfig, fetchImplementation: Fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
    this.#snapshot = emptySnapshot(config);
  }

  current(): NetworkSwitchMonitorSnapshot {
    return structuredClone(this.#snapshot);
  }

  async refresh(nowMs = Date.now()): Promise<void> {
    if (!this.#config.configured || this.#refreshing || nowMs < this.#nextPollAtMs) return;
    this.#refreshing = true;
    this.#nextPollAtMs = nowMs + this.#config.pollIntervalMs;
    const sampledAt = new Date(nowMs).toISOString();
    try {
      const exporterUrl = this.#config.exporterUrl;
      const target = this.#config.target;
      if (!exporterUrl || !target) throw new Error("Network switch is not configured.");
      const url = new URL("/snmp", `${exporterUrl}/`);
      url.searchParams.set("target", target);
      url.searchParams.set("auth", "scorecheck_linovision_v3");
      url.searchParams.set("module", MODULES);
      const response = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`SNMP exporter returned HTTP ${response.status}.`);
      const metrics = parsePrometheusText(await response.text());
      const scrapeError = sample(metrics, "snmp_scrape_error")?.value;
      if (scrapeError != null && scrapeError !== 0) throw new Error("SNMP scrape failed.");

      const uptimeTicks = requiredValue(metrics, "sysUpTime");
      const ports = this.#config.ports.map((binding) => this.#portSnapshot(binding, metrics, nowMs, uptimeTicks));
      const budgetWatts = optionalValue(metrics, "linovision_poe_budget_watts");
      const consumptionWatts = optionalValue(metrics, "linovision_poe_consumption_watts");
      const problems = assess(ports, budgetWatts, consumptionWatts);
      this.#snapshot = {
        state: healthState(problems),
        required: this.#config.required,
        configured: true,
        reachable: true,
        sampledAt,
        lastSuccessAt: sampledAt,
        lastFailureAt: null,
        model: this.#config.model,
        firmwareVersion: this.#config.firmwareVersion,
        uptimeSeconds: uptimeTicks / 100,
        ports,
        poe: {
          supported: budgetWatts != null && consumptionWatts != null,
          budgetWatts,
          consumptionWatts,
          remainingWatts: budgetWatts != null && consumptionWatts != null ? Math.max(0, budgetWatts - consumptionWatts) : null
        },
        problems: problems.map((problem) => problem.message)
      };
    } catch {
      this.#snapshot = {
        ...this.#snapshot,
        state: this.#snapshot.lastSuccessAt ? "DEGRADED" : "UNKNOWN",
        reachable: false,
        sampledAt,
        lastFailureAt: sampledAt,
        problems: ["PoE switch telemetry could not be read. Check the venue management tunnel and switch power."]
      };
    } finally {
      this.#refreshing = false;
    }
  }

  #portSnapshot(binding: NetworkSwitchPortBinding, metrics: Map<string, Sample[]>, nowMs: number, uptimeTicks: number): NetworkSwitchMonitorSnapshot["ports"][number] {
    const labels = { ifIndex: binding.id };
    const admin = optionalValue(metrics, "ifAdminStatus", labels);
    const operational = optionalValue(metrics, "ifOperStatus", labels);
    const speed = optionalValue(metrics, "ifHighSpeed", labels);
    const lastChangeTicks = optionalValue(metrics, "ifLastChange", labels);
    const current: CounterSample = {
      sampledAtMs: nowMs,
      rxOctets: requiredValue(metrics, "ifHCInOctets", labels),
      txOctets: requiredValue(metrics, "ifHCOutOctets", labels),
      inputErrors: requiredValue(metrics, "ifInErrors", labels),
      outputErrors: requiredValue(metrics, "ifOutErrors", labels),
      inputDiscards: requiredValue(metrics, "ifInDiscards", labels),
      outputDiscards: requiredValue(metrics, "ifOutDiscards", labels)
    };
    const previous = this.#counters.get(binding.id);
    this.#counters.set(binding.id, current);
    const configured = optionalValue(metrics, "linovision_poe_port_configured", { port: binding.id });
    const delivering = optionalValue(metrics, "linovision_poe_port_delivery_state", { port: binding.id });
    const powerWatts = optionalValue(metrics, "linovision_poe_port_power_watts", { port: binding.id });
    const limitWatts = optionalValue(metrics, "linovision_poe_port_limit_watts", { port: binding.id });
    return {
      ...binding,
      adminUp: admin == null ? null : admin === 1,
      operationalUp: operational == null ? null : operational === 1,
      speedMbps: speed,
      duplex: null,
      rxBps: rate(previous, current, "rxOctets", 8),
      txBps: rate(previous, current, "txOctets", 8),
      inputErrorsPerSecond: rate(previous, current, "inputErrors"),
      outputErrorsPerSecond: rate(previous, current, "outputErrors"),
      inputDiscardsPerSecond: rate(previous, current, "inputDiscards"),
      outputDiscardsPerSecond: rate(previous, current, "outputDiscards"),
      lastChangedAt: lastChangeTicks == null || lastChangeTicks > uptimeTicks
        ? null
        : new Date(nowMs - (uptimeTicks - lastChangeTicks) * 10).toISOString(),
      poe: binding.role === "access_point" ? {
        configured: configured == null ? null : configured === 1,
        deliveringPower: delivering == null ? null : delivering === 1,
        powerWatts,
        limitWatts,
        priority: null
      } : null
    };
  }
}

type Problem = { severity: "warning" | "critical"; message: string };

function assess(ports: NetworkSwitchMonitorSnapshot["ports"], budgetWatts: number | null, consumptionWatts: number | null): Problem[] {
  const problems: Problem[] = [];
  for (const port of ports.filter((entry) => entry.expected)) {
    if (!port.adminUp || !port.operationalUp) problems.push({ severity: "critical", message: `${port.name} link is down.` });
    if (port.role === "access_point" && port.poe?.deliveringPower !== true) problems.push({ severity: "critical", message: `${port.name} is not receiving PoE power.` });
    const errors = [port.inputErrorsPerSecond, port.outputErrorsPerSecond, port.inputDiscardsPerSecond, port.outputDiscardsPerSecond]
      .reduce<number>((total, value) => total + (value ?? 0), 0);
    if (errors > 0) problems.push({ severity: "warning", message: `${port.name} is reporting Ethernet errors or discarded packets.` });
  }
  if (budgetWatts != null && consumptionWatts != null && budgetWatts > 0 && consumptionWatts / budgetWatts >= 0.9) {
    problems.push({ severity: "warning", message: "PoE power use is above 90% of the switch budget." });
  }
  return problems;
}

function healthState(problems: Problem[]): HealthState {
  if (problems.some((problem) => problem.severity === "critical")) return "CRITICAL";
  if (problems.length > 0) return "DEGRADED";
  return "HEALTHY";
}

function emptySnapshot(config: NetworkSwitchConfig): NetworkSwitchMonitorSnapshot {
  return {
    state: config.configured ? "UNKNOWN" : "NOT_APPLICABLE",
    required: config.required,
    configured: config.configured,
    reachable: null,
    sampledAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    model: config.model,
    firmwareVersion: config.firmwareVersion,
    uptimeSeconds: null,
    ports: config.ports.map((binding) => ({
      ...binding,
      adminUp: null,
      operationalUp: null,
      speedMbps: null,
      duplex: null,
      rxBps: null,
      txBps: null,
      inputErrorsPerSecond: null,
      outputErrorsPerSecond: null,
      inputDiscardsPerSecond: null,
      outputDiscardsPerSecond: null,
      lastChangedAt: null,
      poe: binding.role === "access_point" ? { configured: null, deliveringPower: null, powerWatts: null, limitWatts: null, priority: null } : null
    })),
    poe: { supported: null, budgetWatts: null, consumptionWatts: null, remainingWatts: null },
    problems: config.configured ? ["PoE switch telemetry has not been collected yet."] : []
  };
}

function rate(previous: CounterSample | undefined, current: CounterSample, field: keyof Omit<CounterSample, "sampledAtMs">, multiplier = 1): number | null {
  if (!previous || current.sampledAtMs <= previous.sampledAtMs || current[field] < previous[field]) return null;
  return (current[field] - previous[field]) * multiplier * 1_000 / (current.sampledAtMs - previous.sampledAtMs);
}

export function parsePrometheusText(body: string): Map<string, Sample[]> {
  const metrics = new Map<string, Sample[]>();
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)(?:\s+\d+)?$/.exec(line);
    if (!match) continue;
    const name = match[1];
    const rawValue = match[3];
    if (!name || rawValue == null) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const samples = metrics.get(name) ?? [];
    samples.push({ labels: parseLabels(match[2] ?? ""), value });
    metrics.set(name, samples);
  }
  return metrics;
}

function parseLabels(raw: string): Labels {
  const labels: Labels = {};
  const expression = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"(?:,|$)/g;
  let consumed = 0;
  for (const match of raw.matchAll(expression)) {
    if (match.index !== consumed) throw new Error("Invalid Prometheus labels.");
    const name = match[1];
    const value = match[2];
    if (!name || value == null) throw new Error("Invalid Prometheus labels.");
    labels[name] = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    consumed = match.index + match[0].length;
  }
  if (consumed !== raw.length) throw new Error("Invalid Prometheus labels.");
  return labels;
}

function requiredValue(metrics: Map<string, Sample[]>, name: string, labels: Labels = {}): number {
  const value = optionalValue(metrics, name, labels);
  if (value == null) throw new Error(`Required switch metric is missing: ${name}.`);
  return value;
}

function optionalValue(metrics: Map<string, Sample[]>, name: string, labels: Labels = {}): number | null {
  return sample(metrics, name, labels)?.value ?? null;
}

function sample(metrics: Map<string, Sample[]>, name: string, labels: Labels = {}): Sample | undefined {
  return metrics.get(name)?.find((entry) => Object.entries(labels).every(([key, value]) => entry.labels[key] === value));
}
