import { z } from "zod";
import type { PeplinkConfig } from "./config.js";
import type { HealthState, RouterMonitorSnapshot } from "./contracts.js";

type Fetch = typeof fetch;

const tokenSchema = z.object({ access_token: z.string().min(24) }).passthrough();
const inControlEnvelopeSchema = z.object({
  resp_code: z.literal("SUCCESS"),
  data: z.object({ stat: z.literal("ok"), response: z.unknown() }).passthrough()
}).passthrough();
const deviceEnvelopeSchema = z.object({
  resp_code: z.literal("SUCCESS"),
  data: z.object({
    id: z.number().int().positive(),
    name: z.string(),
    status: z.string(),
    onlineStatus: z.string().optional(),
    client_count: z.number().int().nonnegative().optional(),
    fw_ver: z.string(),
    uptime: z.number().nonnegative().optional(),
    hardware_version: z.string(),
    product_code: z.string(),
    product_name: z.string(),
    periph_status: z.object({
      cpu_load: z.object({ percentage: z.number().nonnegative() }).optional(),
      memory_usage: z.array(z.object({ percentage: z.number().nonnegative() })).optional()
    }).nullable().optional(),
    sf_cloud_license_local: z.object({
      rate_mbps: z.number().nonnegative().optional(),
      expiry_date: z.string().optional(),
      suspend: z.boolean().optional(),
      quota_mb: z.number().nonnegative().optional(),
      usage_mb: z.number().nonnegative().optional()
    }).nullable().optional()
  }).passthrough()
}).passthrough();
const firmwareSchema = z.record(z.string(), z.union([
  z.object({ version: z.string(), bootable: z.boolean(), inUse: z.boolean() }).passthrough(),
  z.array(z.number())
]));
const wanSchema = z.object({
  order: z.array(z.number().int().positive())
}).catchall(z.unknown());
const wanEntrySchema = z.object({
  name: z.string(),
  message: z.string(),
  enable: z.boolean(),
  uptime: z.number().nonnegative().optional(),
  priority: z.number().int().nonnegative().optional(),
  type: z.string(),
  cellular: z.object({
    dataTechnology: z.string().optional(),
    carrier: z.object({ name: z.string().optional() }).optional(),
    signalLevel: z.number().int().min(0).max(5).optional(),
    rat: z.array(z.object({
      band: z.array(z.object({
        name: z.string(),
        channelWidth: z.string().optional(),
        signal: z.object({
          rssi: z.number().optional(),
          rsrp: z.number().optional(),
          rsrq: z.number().optional()
        }).optional()
      }))
    })).optional()
  }).optional()
}).passthrough();
const pepVpnSchema = z.object({
  profile: z.record(z.string(), z.unknown()).optional(),
  peer: z.array(z.object({
    profileId: z.number().int().positive().optional(),
    name: z.string(),
    status: z.string(),
    dataUseTcp: z.boolean().optional(),
    latencyDiffCutoff: z.number().nonnegative().optional()
  }).passthrough()).optional()
}).passthrough();
const pepVpnProfileSchema = z.object({
  name: z.string(),
  status: z.string(),
  speedfusionConnectProtect: z.boolean().optional()
}).passthrough();
const clientsSchema = z.object({
  list: z.array(z.object({
    mac: z.string(),
    active: z.boolean(),
    connectionType: z.string(),
    essid: z.string().optional()
  }).passthrough())
}).passthrough();

const API_BASE = "https://api.ic.peplink.com";
const TOKEN_URL = `${API_BASE}/api/oauth2/token`;

export class PeplinkCollector {
  readonly #config: PeplinkConfig;
  readonly #fetch: Fetch;
  #nextPollAtMs = 0;
  #refreshing = false;
  #snapshot: RouterMonitorSnapshot;

  constructor(config: PeplinkConfig, fetchImplementation: Fetch = fetch) {
    this.#config = config;
    this.#fetch = fetchImplementation;
    this.#snapshot = emptyPeplinkSnapshot(config);
  }

  current(): RouterMonitorSnapshot {
    return structuredClone(this.#snapshot);
  }

  async refresh(nowMs = Date.now()): Promise<void> {
    if (!this.#config.configured || this.#refreshing || nowMs < this.#nextPollAtMs) return;
    this.#refreshing = true;
    this.#nextPollAtMs = nowMs + this.#config.pollIntervalMs;
    const sampledAt = new Date(nowMs).toISOString();
    try {
      const accessToken = await this.#grantToken();
      const device = deviceEnvelopeSchema.parse(await this.#request("device", accessToken)).data;
      const firmware = firmwareSchema.parse(await this.#deviceApi("info.firmware", accessToken));
      const wans = wanSchema.parse(await this.#deviceApi("status.wan.connection", accessToken));
      const pepVpn = pepVpnSchema.parse(await this.#deviceApi("status.pepvpn?infoType=profile%20peer%20tunnel", accessToken));
      const clients = clientsSchema.parse(await this.#deviceApi("status.client", accessToken));
      this.#snapshot = buildSnapshot(this.#config, { device, firmware, wans, pepVpn, clients }, sampledAt);
    } catch (error) {
      this.#snapshot = {
        ...emptyPeplinkSnapshot(this.#config),
        state: this.#config.required ? "CRITICAL" : "UNKNOWN",
        apiReachable: false,
        sampledAt,
        lastSuccessAt: this.#snapshot.lastSuccessAt,
        lastFailureAt: sampledAt,
        problems: [`Peplink monitoring is unavailable (${errorCode(error)}).`]
      };
    } finally {
      this.#refreshing = false;
    }
  }

  async #grantToken(): Promise<string> {
    if (!this.#config.clientId || !this.#config.clientSecret) throw new Error("peplink_not_configured");
    const response = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        grant_type: "client_credentials"
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`token_http_${response.status}`);
    return tokenSchema.parse(await response.json()).access_token;
  }

  async #request(kind: "device" | "deviceApi", accessToken: string, endpoint?: string): Promise<unknown> {
    const { organizationId, groupId, deviceId } = this.#config;
    if (!organizationId || groupId == null || deviceId == null) throw new Error("peplink_not_configured");
    const path = kind === "device"
      ? `/rest/o/${organizationId}/g/${groupId}/d/${deviceId}`
      : `/rest/o/${organizationId}/g/${groupId}/d/${deviceId}/devapi/${endpoint}`;
    const response = await this.#fetch(`${API_BASE}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`api_http_${response.status}`);
    return response.json();
  }

  async #deviceApi(endpoint: string, accessToken: string): Promise<unknown> {
    const envelope = inControlEnvelopeSchema.parse(await this.#request("deviceApi", accessToken, endpoint));
    return envelope.data.response;
  }
}

function buildSnapshot(
  config: PeplinkConfig,
  input: {
    device: z.infer<typeof deviceEnvelopeSchema>["data"];
    firmware: z.infer<typeof firmwareSchema>;
    wans: z.infer<typeof wanSchema>;
    pepVpn: z.infer<typeof pepVpnSchema>;
    clients: z.infer<typeof clientsSchema>;
  },
  sampledAt: string
): RouterMonitorSnapshot {
  const productCode = config.productCode;
  const hardwareVersion = config.hardwareVersion;
  const firmwareVersion = config.firmwareVersion;
  const speedFusionProfileName = config.speedFusionProfileName;
  const cameraSsid = config.cameraSsid;
  if (!productCode || !hardwareVersion || !firmwareVersion || !speedFusionProfileName || !cameraSsid) {
    throw new Error("peplink_not_configured");
  }
  const activeFirmware = Object.values(input.firmware).find(isActiveFirmware);
  const profiles = Object.entries(input.pepVpn.profile ?? {})
    .filter(([key]) => key !== "order" && key !== "siteId")
    .map(([id, value]) => ({ id: Number(id), value: pepVpnProfileSchema.parse(value) }));
  const profile = profiles.find((entry) => entry.value.name === speedFusionProfileName) ?? null;
  const peer = input.pepVpn.peer?.find((entry) => entry.profileId === profile?.id) ?? null;
  const wanBindings = new Map(config.wans.map((binding) => [binding.id, binding]));
  const wans = input.wans.order.map((id) => {
    const entry = wanEntrySchema.parse(input.wans[String(id)]);
    const binding = wanBindings.get(id);
    const bands = entry.cellular?.rat?.flatMap((rat) => rat.band).map((band) => ({
      name: band.name,
      channelWidth: band.channelWidth ?? null,
      rssiDbm: band.signal?.rssi ?? null,
      rsrpDbm: band.signal?.rsrp ?? null,
      rsrqDb: band.signal?.rsrq ?? null
    })) ?? [];
    return {
      id: String(id),
      name: entry.name,
      type: wanType(entry.type),
      required: binding?.required ?? false,
      enabled: entry.enable,
      connected: entry.message.toLowerCase().startsWith("connected"),
      message: entry.message,
      priority: entry.priority ?? null,
      uptimeSeconds: entry.uptime ?? null,
      carrier: entry.cellular?.carrier?.name ?? null,
      technology: entry.cellular?.dataTechnology ?? null,
      signalLevel: entry.cellular?.signalLevel ?? null,
      bands
    } as const;
  });
  const activeClients = input.clients.list.filter((client) => client.active);
  const cameraWlanClients = activeClients.filter((client) => client.essid === cameraSsid).length;
  const memory = input.device.periph_status?.memory_usage?.[0]?.percentage ?? null;
  const speedFusionConnected = profile?.value.status === "CONNECTED" && peer?.status === "CONNECTED";
  const problems: Array<{ severity: "critical" | "warning"; message: string }> = [];
  if (input.device.status.toLowerCase() !== "online" && input.device.onlineStatus?.toUpperCase() !== "ONLINE") {
    problems.push({ severity: "critical", message: "Peplink router is offline in InControl." });
  }
  if (input.device.product_code !== productCode || input.device.hardware_version !== hardwareVersion) {
    problems.push({ severity: "critical", message: "Peplink hardware identity does not match the commissioned router." });
  }
  if (activeFirmware?.version !== firmwareVersion || input.device.fw_ver !== firmwareVersion) {
    problems.push({ severity: "warning", message: `Peplink firmware is not ${firmwareVersion}.` });
  }
  for (const binding of config.wans) {
    const wan = wans.find((entry) => entry.id === String(binding.id));
    if (!wan || wan.name !== binding.name) problems.push({ severity: "critical", message: `${binding.name} identity is unavailable.` });
    else if (binding.required && !wan.connected) problems.push({ severity: "critical", message: `${binding.name} is not connected.` });
  }
  if (!speedFusionConnected) problems.push({ severity: "critical", message: `${speedFusionProfileName} is not connected.` });
  if ((input.device.periph_status?.cpu_load?.percentage ?? 0) >= 90) problems.push({ severity: "critical", message: "Peplink CPU utilization is at least 90%." });
  else if ((input.device.periph_status?.cpu_load?.percentage ?? 0) >= 80) problems.push({ severity: "warning", message: "Peplink CPU utilization is at least 80%." });
  if ((memory ?? 0) >= 90) problems.push({ severity: "critical", message: "Peplink memory utilization is at least 90%." });
  const state: HealthState = problems.some((problem) => problem.severity === "critical")
    ? "CRITICAL"
    : problems.length ? "DEGRADED" : "HEALTHY";
  return {
    state,
    required: config.required,
    configured: true,
    apiReachable: true,
    sampledAt,
    lastSuccessAt: sampledAt,
    lastFailureAt: null,
    identity: {
      name: input.device.name,
      productName: input.device.product_name,
      productCode: input.device.product_code,
      hardwareVersion: input.device.hardware_version,
      firmwareVersion: activeFirmware?.version ?? input.device.fw_ver,
      online: input.device.status.toLowerCase() === "online" || input.device.onlineStatus?.toUpperCase() === "ONLINE",
      uptimeSeconds: input.device.uptime ?? null
    },
    resources: {
      cpuUtilizationPct: input.device.periph_status?.cpu_load?.percentage ?? null,
      memoryUtilizationPct: memory
    },
    speedFusion: {
      profileName: speedFusionProfileName,
      connected: speedFusionConnected,
      profileStatus: profile?.value.status ?? null,
      peerStatus: peer?.status ?? null,
      transport: peer == null ? null : peer.dataUseTcp ? "TCP" : "UDP",
      latencyDifferenceCutoffMs: peer?.latencyDiffCutoff ?? null,
      rateLimitMbps: input.device.sf_cloud_license_local?.rate_mbps ?? null,
      quotaMb: input.device.sf_cloud_license_local?.quota_mb ?? null,
      usageMb: input.device.sf_cloud_license_local?.usage_mb ?? null,
      expiresAt: input.device.sf_cloud_license_local?.expiry_date ?? null,
      suspended: input.device.sf_cloud_license_local?.suspend ?? null
    },
    clients: {
      connected: activeClients.length,
      cameraWlanSsid: cameraSsid,
      cameraWlanConnected: cameraWlanClients
    },
    wans,
    problems: problems.map((problem) => problem.message)
  };
}

function isActiveFirmware(value: z.infer<typeof firmwareSchema>[string]): value is { version: string; bootable: boolean; inUse: boolean } {
  return !Array.isArray(value) && value.inUse;
}

export function emptyPeplinkSnapshot(config: PeplinkConfig): RouterMonitorSnapshot {
  return {
    state: config.configured ? "UNKNOWN" : "NOT_APPLICABLE",
    required: config.required,
    configured: config.configured,
    apiReachable: null,
    sampledAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    identity: null,
    resources: null,
    speedFusion: null,
    clients: null,
    wans: [],
    problems: []
  };
}

function wanType(value: string): "ethernet" | "wifi" | "cellular" | "other" {
  if (value === "ethernet" || value === "wifi" || value === "cellular") return value;
  return "other";
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "unknown";
}
