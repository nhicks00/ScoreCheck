import { z } from "zod";
import type { PeplinkConfig } from "./config.js";
import type { HealthState, RouterMonitorSnapshot } from "./contracts.js";

type Fetch = typeof fetch;

const tokenSchema = z.object({
  access_token: z.string().min(24),
  expires_in: z.number().int().positive().max(7 * 24 * 60 * 60)
}).passthrough();
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
    latencyDiffCutoff: z.number().nonnegative().optional(),
    peerId: z.string().regex(/^[0-9]+-[0-9]+$/u).optional()
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
    connectionType: z.string().optional(),
    ip: z.string().optional(),
    name: z.string().optional(),
    essid: z.string().optional(),
    signalStrength: z.object({
      value: z.number(),
      unit: z.string().optional()
    }).optional(),
    signal: z.object({ level: z.number().int().min(0).max(5).optional() }).optional(),
    speed: z.object({
      download: z.number().nonnegative().optional(),
      upload: z.number().nonnegative().optional(),
      unit: z.string().optional()
    }).optional()
  }).passthrough()).max(512)
}).passthrough();
const tunnelResponseSchema = z.object({ tunnel: z.record(z.string(), z.unknown()) }).passthrough();
const tunnelEntrySchema = z.object({
  wan: z.record(z.string(), z.unknown())
}).passthrough();
const tunnelWanSchema = z.object({
  name: z.string(),
  state: z.string(),
  rtt: z.number().nonnegative().optional(),
  transmit: z.object({
    byte: z.array(z.number().nonnegative()),
    packet: z.object({
      forward: z.array(z.number().nonnegative()),
      loss: z.array(z.number().nonnegative()),
      fec: z.array(z.number().nonnegative())
    }).passthrough()
  }).optional()
}).passthrough();

const API_BASE = "https://api.ic.peplink.com";
const TOKEN_URL = `${API_BASE}/api/oauth2/token`;
type TunnelCounter = { transmitBytes: number; transmitForward: number; transmitLoss: number; transmitFec: number };
type TunnelCounterBaseline = { sampledAtMs: number; links: Map<string, TunnelCounter> };

export class PeplinkCollector {
  readonly #config: PeplinkConfig;
  readonly #fetch: Fetch;
  #nextPollAtMs = 0;
  #refreshing = false;
  #snapshot: RouterMonitorSnapshot;
  #tunnelBaseline: TunnelCounterBaseline | null = null;
  #accessToken: { value: string; expiresAtMs: number } | null = null;

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
      const accessToken = await this.#grantToken(nowMs);
      const device = deviceEnvelopeSchema.parse(await this.#request("device", accessToken)).data;
      const firmware = firmwareSchema.parse(await this.#deviceApi("info.firmware", accessToken));
      const wans = wanSchema.parse(await this.#deviceApi("status.wan.connection", accessToken));
      const pepVpn = pepVpnSchema.parse(await this.#deviceApi("status.pepvpn?infoType=profile%20peer%20tunnel", accessToken));
      const peerId = pepVpn.peer?.find((peer) => peer.peerId)?.peerId ?? null;
      let tunnel: z.infer<typeof tunnelResponseSchema> | null = null;
      if (peerId) {
        try {
          tunnel = tunnelResponseSchema.parse(await this.#deviceApi(`status.pepvpn?infoType=tunnel&tunnelOption=${peerId}`, accessToken));
        } catch {
          tunnel = null;
        }
      }
      const tunnelRawLinks = parseTunnelLinks(tunnel, peerId);
      const tunnelLinks = calculateTunnelLinks(tunnelRawLinks, this.#tunnelBaseline, nowMs);
      this.#tunnelBaseline = tunnel == null ? null : {
        sampledAtMs: nowMs,
        links: new Map(tunnelRawLinks.map((link) => [link.name, link]))
      };
      const clients = clientsSchema.parse(await this.#deviceApi("status.client?activeOnly=yes&outputWeight=full", accessToken));
      this.#snapshot = buildSnapshot(this.#config, { device, firmware, wans, pepVpn, tunnelLinks, tunnelLinksAvailable: tunnel != null, clients }, sampledAt);
    } catch (error) {
      if (error instanceof Error && /^(?:token_http_|api_http_401$)/u.test(error.message)) this.#accessToken = null;
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

  async #grantToken(nowMs: number): Promise<string> {
    if (this.#accessToken && nowMs + 60_000 < this.#accessToken.expiresAtMs) return this.#accessToken.value;
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
    const token = tokenSchema.parse(await response.json());
    this.#accessToken = { value: token.access_token, expiresAtMs: nowMs + token.expires_in * 1_000 };
    return token.access_token;
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
    tunnelLinks: NonNullable<RouterMonitorSnapshot["speedFusion"]>["links"];
    tunnelLinksAvailable: boolean;
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
  const cameraWlanDevices = activeClients
    .filter((client) => client.essid === cameraSsid)
    .map((client) => ({
      macAddress: client.mac,
      ipAddress: client.ip ?? null,
      name: client.name ?? null,
      connectionType: client.connectionType ?? "unknown",
      signalDbm: client.signalStrength?.value ?? null,
      signalLevel: client.signal?.level ?? null,
      downloadKbps: client.speed?.unit === "kbps" ? client.speed.download ?? null : null,
      uploadKbps: client.speed?.unit === "kbps" ? client.speed.upload ?? null : null
    }))
    .sort((left, right) => (left.ipAddress ?? left.macAddress).localeCompare(right.ipAddress ?? right.macAddress, undefined, { numeric: true }));
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
  else if (!input.tunnelLinksAvailable) problems.push({ severity: "warning", message: "SpeedFusion link telemetry is unavailable." });
  else {
    for (const binding of config.wans.filter((wan) => wan.required)) {
      const wan = wans.find((entry) => entry.id === String(binding.id));
      if (!wan?.connected) continue;
      const link = input.tunnelLinks.find((entry) => entry.name === binding.name);
      if (!link) problems.push({ severity: "critical", message: `${binding.name} is missing from the ${speedFusionProfileName} tunnel.` });
      else if (link.state !== "ACTIVE") problems.push({ severity: "critical", message: `${binding.name} is not active in the ${speedFusionProfileName} tunnel (${link.state}).` });
    }
  }
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
      suspended: input.device.sf_cloud_license_local?.suspend ?? null,
      linksAvailable: input.tunnelLinksAvailable,
      links: input.tunnelLinks
    },
    clients: {
      connected: activeClients.length,
      cameraWlanSsid: cameraSsid,
      cameraWlanConnected: cameraWlanDevices.length,
      cameraWlanDevices
    },
    wans,
    problems: problems.map((problem) => problem.message)
  };
}

type TunnelRawLink = TunnelCounter & { name: string; state: string; rttMs: number | null };

function parseTunnelLinks(tunnel: z.infer<typeof tunnelResponseSchema> | null, peerId: string | null): TunnelRawLink[] {
  if (!tunnel || !peerId) return [];
  const entry = tunnelEntrySchema.parse(tunnel.tunnel[peerId]);
  return Object.entries(entry.wan)
    .filter(([id]) => /^[0-9]+$/u.test(id))
    .map(([, value]) => tunnelWanSchema.parse(value))
    .filter((wan) => wan.state !== "WAN_DISABLED")
    .map((wan) => ({
      name: wan.name,
      state: wan.state,
      rttMs: wan.rtt ?? null,
      transmitBytes: wan.transmit?.byte[0] ?? 0,
      transmitForward: wan.transmit?.packet.forward[0] ?? 0,
      transmitLoss: wan.transmit?.packet.loss[0] ?? 0,
      transmitFec: wan.transmit?.packet.fec[0] ?? 0
    }));
}

function calculateTunnelLinks(rawLinks: TunnelRawLink[], baseline: TunnelCounterBaseline | null, sampledAtMs: number) {
  const seconds = baseline == null ? 0 : (sampledAtMs - baseline.sampledAtMs) / 1_000;
  return rawLinks.map((link) => {
    const previous = baseline?.links.get(link.name);
    const transmitBytes = previous == null ? -1 : link.transmitBytes - previous.transmitBytes;
    const transmitForward = previous == null ? -1 : link.transmitForward - previous.transmitForward;
    const transmitLoss = previous == null ? -1 : link.transmitLoss - previous.transmitLoss;
    const transmitFec = previous == null ? -1 : link.transmitFec - previous.transmitFec;
    const valid = seconds > 0 && transmitBytes >= 0 && transmitForward >= 0 && transmitLoss >= 0 && transmitFec >= 0;
    return {
      name: link.name,
      state: link.state,
      rttMs: link.rttMs,
      transmitBitrateBps: valid ? (transmitBytes * 8) / seconds : null,
      transmitPacketLossPct: valid && transmitForward + transmitLoss > 0 ? (transmitLoss * 100) / (transmitForward + transmitLoss) : null,
      transmitFecPct: valid && transmitForward + transmitFec > 0 ? (transmitFec * 100) / (transmitForward + transmitFec) : null
    };
  });
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
