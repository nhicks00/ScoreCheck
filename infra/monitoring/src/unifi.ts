import { z } from "zod";
import type { UniFiConfig } from "./config.js";
import type { HealthState, UniFiMonitorSnapshot } from "./contracts.js";

const pageSchema = z.object({
  data: z.array(z.unknown()),
  totalCount: z.number().int().nonnegative()
}).passthrough();

const deviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  macAddress: z.string().toLowerCase(),
  model: z.string(),
  firmwareVersion: z.string().optional(),
  ipAddress: z.string().optional(),
  state: z.string(),
  features: z.array(z.string())
}).passthrough();

const clientSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  macAddress: z.string().toLowerCase().optional(),
  ipAddress: z.string().optional(),
  type: z.string(),
  uplinkDeviceId: z.string().uuid().optional()
}).passthrough();

const statisticsSchema = z.object({
  cpuUtilizationPct: z.number().optional(),
  memoryUtilizationPct: z.number().optional(),
  lastHeartbeatAt: z.string().datetime({ offset: true }).optional(),
  uplink: z.object({
    txRateBps: z.number().nonnegative().optional(),
    rxRateBps: z.number().nonnegative().optional()
  }).passthrough().optional(),
  interfaces: z.object({
    radios: z.array(z.object({
      frequencyGHz: z.number(),
      txRetriesPct: z.number().nonnegative().optional()
    }).passthrough()).optional()
  }).passthrough()
}).passthrough();

type Fetch = typeof fetch;

export class UniFiCollector {
  readonly #config: UniFiConfig;
  readonly #fetch: Fetch;
  #nextPollAtMs = 0;
  #refreshing = false;
  #snapshot: UniFiMonitorSnapshot;

  constructor(config: UniFiConfig, fetchImplementation: Fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
    this.#snapshot = emptySnapshot(config);
  }

  current(): UniFiMonitorSnapshot {
    return structuredClone(this.#snapshot);
  }

  async refresh(nowMs = Date.now()): Promise<void> {
    if (!this.#config.configured || this.#refreshing || nowMs < this.#nextPollAtMs) return;
    this.#refreshing = true;
    this.#nextPollAtMs = nowMs + this.#config.pollIntervalMs;
    try {
      const sampledAt = new Date(nowMs).toISOString();
      const [devicePage, clientPage] = await Promise.all([
        this.#request("devices?offset=0&limit=200", pageSchema),
        this.#request("clients?offset=0&limit=200", pageSchema)
      ]);
      if (devicePage.totalCount > 200 || clientPage.totalCount > 200) throw new Error("UniFi API result exceeds the supported page size.");
      const devices = devicePage.data.map((entry) => deviceSchema.parse(entry));
      const clients = clientPage.data.map((entry) => clientSchema.parse(entry));
      const accessPoints = await Promise.all(this.#config.accessPoints.map(async (binding) => {
        const device = devices.find((entry) => entry.id === binding.deviceId);
        if (!device) return missingAccessPoint(binding);
        const statistics = device.state === "ONLINE"
          ? await this.#request(`devices/${encodeURIComponent(binding.deviceId)}/statistics/latest`, statisticsSchema)
          : null;
        return {
          name: binding.name,
          deviceId: binding.deviceId,
          macAddress: device.macAddress,
          expected: binding.expected,
          model: device.model,
          firmwareVersion: device.firmwareVersion ?? null,
          state: device.state,
          ipAddress: device.ipAddress ?? null,
          cpuUtilizationPct: statistics?.cpuUtilizationPct ?? null,
          memoryUtilizationPct: statistics?.memoryUtilizationPct ?? null,
          txRateBps: statistics?.uplink?.txRateBps ?? null,
          rxRateBps: statistics?.uplink?.rxRateBps ?? null,
          lastHeartbeatAt: statistics?.lastHeartbeatAt ?? null,
          radios: (statistics?.interfaces.radios ?? []).map((radio) => ({
            frequencyGHz: radio.frequencyGHz,
            txRetriesPct: radio.txRetriesPct ?? null
          }))
        };
      }));
      const problems = assess(accessPoints, this.#config, nowMs);
      const state = healthState(problems);
      this.#snapshot = {
        state,
        required: this.#config.required,
        configured: true,
        apiReachable: true,
        sampledAt,
        lastSuccessAt: sampledAt,
        lastFailureAt: null,
        siteId: this.#config.siteId,
        expectedAccessPoints: this.#config.accessPoints.filter((entry) => entry.expected).length,
        onlineAccessPoints: accessPoints.filter((entry) => entry.expected && entry.state === "ONLINE").length,
        connectedClients: clients.length,
        accessPoints,
        clients: clients.map((client) => ({
          id: client.id,
          name: client.name,
          macAddress: client.macAddress ?? null,
          ipAddress: client.ipAddress ?? null,
          type: client.type,
          uplinkDeviceId: client.uplinkDeviceId ?? null
        })),
        problems: problems.map((entry) => entry.message)
      };
    } catch {
      const sampledAt = new Date(nowMs).toISOString();
      this.#snapshot = {
        ...this.#snapshot,
        state: this.#snapshot.lastSuccessAt ? "DEGRADED" : "UNKNOWN",
        apiReachable: false,
        sampledAt,
        lastFailureAt: sampledAt,
        problems: ["UniFi telemetry could not be read. Check the UniFi controller and its API key."]
      };
    } finally {
      this.#refreshing = false;
    }
  }

  async #request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const config = this.#config;
    if (!config.apiKey || !config.baseUrl || !config.siteId) throw new Error("UniFi is not configured.");
    const base = `${config.baseUrl}/sites/${encodeURIComponent(config.siteId)}`;
    const response = await this.#fetch(`${base}/${path}`, {
      headers: { "X-API-Key": config.apiKey },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`UniFi API returned HTTP ${response.status}.`);
    return schema.parse(await response.json());
  }
}

type AccessPoint = UniFiMonitorSnapshot["accessPoints"][number];
type Problem = { severity: "warning" | "critical"; message: string };

function missingAccessPoint(binding: UniFiConfig["accessPoints"][number]): AccessPoint {
  return {
    name: binding.name,
    deviceId: binding.deviceId,
    macAddress: binding.macAddress,
    expected: binding.expected,
    model: null,
    firmwareVersion: null,
    state: "MISSING",
    ipAddress: null,
    cpuUtilizationPct: null,
    memoryUtilizationPct: null,
    txRateBps: null,
    rxRateBps: null,
    lastHeartbeatAt: null,
    radios: []
  };
}

function assess(accessPoints: AccessPoint[], config: UniFiConfig, nowMs: number): Problem[] {
  const problems: Problem[] = [];
  for (const accessPoint of accessPoints) {
    const binding = config.accessPoints.find((entry) => entry.deviceId === accessPoint.deviceId);
    if (binding && accessPoint.macAddress !== binding.macAddress) {
      problems.push({ severity: "critical", message: `${accessPoint.name} identity does not match its commissioned MAC address.` });
    }
    if (!accessPoint.expected) continue;
    if (accessPoint.state !== "ONLINE") {
      problems.push({ severity: "critical", message: `${accessPoint.name} is ${accessPoint.state.toLowerCase().replaceAll("_", " ")}.` });
      continue;
    }
    if (accessPoint.lastHeartbeatAt && nowMs - Date.parse(accessPoint.lastHeartbeatAt) > 120_000) {
      problems.push({ severity: "critical", message: `${accessPoint.name} is not reporting fresh status.` });
    }
    if ((accessPoint.cpuUtilizationPct ?? 0) > 90 || (accessPoint.memoryUtilizationPct ?? 0) > 90) {
      problems.push({ severity: "warning", message: `${accessPoint.name} is short on processing headroom.` });
    }
    if (accessPoint.radios.some((radio) => (radio.txRetriesPct ?? 0) > 25)) {
      problems.push({ severity: "warning", message: `${accessPoint.name} is retransmitting too much Wi-Fi traffic.` });
    }
  }
  return problems;
}

function healthState(problems: Problem[]): HealthState {
  if (problems.some((entry) => entry.severity === "critical")) return "CRITICAL";
  if (problems.length > 0) return "DEGRADED";
  return "HEALTHY";
}

function emptySnapshot(config: UniFiConfig): UniFiMonitorSnapshot {
  return {
    state: config.configured ? "UNKNOWN" : "NOT_APPLICABLE",
    required: config.required,
    configured: config.configured,
    apiReachable: null,
    sampledAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    siteId: config.siteId,
    expectedAccessPoints: config.accessPoints.filter((entry) => entry.expected).length,
    onlineAccessPoints: 0,
    connectedClients: 0,
    accessPoints: config.accessPoints.map(missingAccessPoint),
    clients: [],
    problems: config.configured ? ["UniFi telemetry has not been collected yet."] : []
  };
}
