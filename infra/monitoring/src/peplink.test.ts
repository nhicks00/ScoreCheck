import { describe, expect, it, vi } from "vitest";
import type { PeplinkConfig } from "./config.js";
import { PeplinkCollector } from "./peplink.js";

const nowMs = Date.parse("2026-08-07T01:00:00.000Z");
const config: PeplinkConfig = {
  required: true,
  configured: true,
  clientId: "a".repeat(32),
  clientSecret: "b".repeat(32),
  organizationId: "org123",
  groupId: 3,
  deviceId: 9,
  productCode: "MAX-BR1-PRO-5GK-T-PRM",
  hardwareVersion: "3",
  firmwareVersion: "8.6.0 build 6450",
  speedFusionProfileName: "SFC-SFO",
  cameraSsid: "BVM",
  wans: [
    { id: 1, name: "WAN", required: true },
    { id: 2, name: "Cellular", required: true }
  ],
  pollIntervalMs: 30_000
};

describe("Peplink collector", () => {
  it("stays not applicable without a commissioned router", async () => {
    const request = vi.fn();
    const collector = new PeplinkCollector({ ...config, required: false, configured: false }, request as typeof fetch);
    await collector.refresh(nowMs);
    expect(collector.current()).toMatchObject({ state: "NOT_APPLICABLE", configured: false, apiReachable: null });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports current Peplink identity, WAN, cellular, client, resource, and SpeedFusion state", async () => {
    const request = healthyRequest();
    const collector = new PeplinkCollector(config, request as typeof fetch);
    await collector.refresh(nowMs);
    await collector.refresh(nowMs + 30_000);
    const snapshot = collector.current();
    expect(snapshot).toMatchObject({
      state: "HEALTHY",
      apiReachable: true,
      identity: {
        productCode: "MAX-BR1-PRO-5GK-T-PRM",
        hardwareVersion: "3",
        firmwareVersion: "8.6.0 build 6450",
        online: true
      },
      resources: { cpuUtilizationPct: 25, memoryUtilizationPct: 40 },
      speedFusion: {
        profileName: "SFC-SFO",
        connected: true,
        transport: "UDP",
        usageMb: 4,
        quotaMb: 1_048_572,
        linksAvailable: true,
        links: expect.arrayContaining([expect.objectContaining({
          name: "WAN",
          state: "ACTIVE",
          rttMs: 53,
          transmitBitrateBps: 800_000,
          transmitPacketLossPct: 1,
          transmitFecPct: 20
        })])
      },
      clients: {
        connected: 3,
        cameraWlanSsid: "BVM",
        cameraWlanConnected: 2
      },
      problems: []
    });
    expect(snapshot.wans).toHaveLength(2);
    expect(snapshot.wans[1]).toMatchObject({ name: "Cellular", required: true, connected: true, carrier: "T-Mobile", technology: "5G SA", signalLevel: 5 });
    expect(snapshot.wans[1]?.bands[0]).toEqual({ name: "5G Band n41", channelWidth: "100 MHz", rssiDbm: -74, rsrpDbm: -83, rsrqDb: -10 });
    expect(snapshot.clients?.cameraWlanDevices).toEqual(expect.arrayContaining([expect.objectContaining({
      macAddress: "00:00:00:00:00:01",
      ipAddress: "192.168.50.10",
      signalDbm: -58,
      signalLevel: 4,
      downloadKbps: 12,
      uploadKbps: 3_100
    })]));
    expect(request).toHaveBeenCalledTimes(13);
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/api/oauth2/token"))).toHaveLength(1);
  });

  it("fails closed on required WAN, hardware, firmware, resource, and SpeedFusion drift", async () => {
    const request = healthyRequest({
      device: { product_code: "WRONG", fw_ver: "8.5.4 build 6264", periph_status: { cpu_load: { percentage: 92 }, memory_usage: [{ percentage: 91 }] } },
      firmware: { "1": { version: "8.5.4 build 6264", bootable: true, inUse: true }, order: [1] },
      wan: { "2": { message: "No Service", enable: true } },
      pepVpn: { profile: { "60000": { name: "SFC-SFO", status: "DISCONNECTED", speedfusionConnectProtect: true }, order: [60000] }, peer: [] }
    });
    const collector = new PeplinkCollector(config, request as typeof fetch);
    await collector.refresh(nowMs);
    expect(collector.current().state).toBe("CRITICAL");
    expect(collector.current().problems).toEqual(expect.arrayContaining([
      "Peplink hardware identity does not match the commissioned router.",
      "Peplink firmware is not 8.6.0 build 6450.",
      "Cellular is not connected.",
      "SFC-SFO is not connected.",
      "Peplink CPU utilization is at least 90%.",
      "Peplink memory utilization is at least 90%."
    ]));
  });

  it("fails closed when a connected required WAN is not active in SpeedFusion", async () => {
    const collector = new PeplinkCollector(config, healthyRequest({
      tunnel: tunnelResponse({ cellularState: "REMOTE_FAILURE" })
    }) as typeof fetch);
    await collector.refresh(nowMs);
    expect(collector.current()).toMatchObject({
      state: "CRITICAL",
      problems: ["Cellular is not active in the SFC-SFO tunnel (REMOTE_FAILURE)."]
    });
  });

  it("marks current data unavailable and retains only freshness evidence after an API failure", async () => {
    let fail = false;
    const healthy = healthyRequest();
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (fail) return new Response(null, { status: 401 });
      return healthy(...args);
    });
    const collector = new PeplinkCollector(config, request as typeof fetch);
    await collector.refresh(nowMs);
    fail = true;
    await collector.refresh(nowMs + 30_000);
    expect(collector.current()).toMatchObject({
      state: "CRITICAL",
      apiReachable: false,
      identity: null,
      wans: [],
      lastSuccessAt: "2026-08-07T01:00:00.000Z",
      lastFailureAt: "2026-08-07T01:00:30.000Z"
    });
    expect(JSON.stringify(collector.current())).not.toContain(config.clientSecret);
  });

  it("keeps current router telemetry when a transient client omits its connection type", async () => {
    const request = healthyRequest({ clients: [
      { mac: "00:00:00:00:00:09", active: true, ip: "192.168.50.90", essid: "BVM" }
    ] });
    const collector = new PeplinkCollector(config, request as typeof fetch);
    await collector.refresh(nowMs);
    expect(collector.current()).toMatchObject({
      state: "HEALTHY",
      apiReachable: true,
      clients: {
        connected: 1,
        cameraWlanConnected: 1,
        cameraWlanDevices: [{ connectionType: "unknown", ipAddress: "192.168.50.90" }]
      }
    });
  });

  it("refreshes the cached InControl token after its declared expiry", async () => {
    const request = healthyRequest();
    const collector = new PeplinkCollector(config, request as typeof fetch);
    await collector.refresh(nowMs);
    await collector.refresh(nowMs + 30_000);
    await collector.refresh(nowMs + 172_800_000);
    expect(request.mock.calls.filter(([input]) => String(input).endsWith("/api/oauth2/token"))).toHaveLength(2);
  });

  it("keeps current router telemetry when detailed tunnel counters are unavailable", async () => {
    const collector = new PeplinkCollector(config, healthyRequest({ tunnel: {} }) as typeof fetch);
    await collector.refresh(nowMs);
    expect(collector.current()).toMatchObject({
      state: "DEGRADED",
      apiReachable: true,
      speedFusion: { connected: true, linksAvailable: false, links: [] },
      problems: ["SpeedFusion link telemetry is unavailable."]
    });
  });
});

function healthyRequest(overrides: {
  device?: Record<string, unknown>;
  firmware?: Record<string, unknown>;
  wan?: Record<string, Record<string, unknown>>;
  pepVpn?: Record<string, unknown>;
  tunnel?: unknown;
  clients?: unknown[];
} = {}) {
  let tunnelCalls = 0;
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/oauth2/token")) {
      expect(String(init?.body)).toContain("grant_type=client_credentials");
      return json({ access_token: "token-".padEnd(32, "x"), expires_in: 172_799 });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-xxxxxxxxxxxxxxxxxxxxxxxxxx");
    if (url.endsWith("/rest/o/org123/g/3/d/9")) {
      return json({ resp_code: "SUCCESS", data: {
        id: 9,
        name: "scorecheck-event-router",
        status: "online",
        onlineStatus: "ONLINE",
        client_count: 3,
        fw_ver: "8.6.0 build 6450",
        uptime: 3_600,
        hardware_version: "3",
        product_code: "MAX-BR1-PRO-5GK-T-PRM",
        product_name: "Peplink MAX BR1 Pro 5G",
        periph_status: { cpu_load: { percentage: 25 }, memory_usage: [{ percentage: 40 }] },
        sf_cloud_license_local: { rate_mbps: 200, quota_mb: 1_048_572, usage_mb: 4, expiry_date: "2027-08-03T00:00:00", suspend: false },
        ...overrides.device
      } });
    }
    if (url.endsWith("/devapi/info.firmware")) {
      return deviceApi(overrides.firmware ?? { "1": { version: "8.6.0 build 6450", bootable: true, inUse: true }, order: [1] });
    }
    if (url.endsWith("/devapi/status.wan.connection")) {
      const wan = {
        "1": { name: "WAN", message: "Connected", enable: true, uptime: 3_500, priority: 1, type: "ethernet" },
        "2": { name: "Cellular", message: "Connected to T-Mobile", enable: true, uptime: 3_400, priority: 1, type: "cellular", cellular: { dataTechnology: "5G SA", carrier: { name: "T-Mobile" }, signalLevel: 5, rat: [{ band: [{ name: "5G Band n41", channelWidth: "100 MHz", signal: { rssi: -74, rsrp: -83, rsrq: -10 } }] }] } },
        order: [1, 2]
      } as Record<string, unknown>;
      for (const [id, value] of Object.entries(overrides.wan ?? {})) wan[id] = { ...(wan[id] as object), ...value };
      return deviceApi(wan);
    }
    if (url.includes("/devapi/status.pepvpn?") && url.includes("tunnelOption=60000-1")) {
      tunnelCalls += 1;
      return deviceApi(overrides.tunnel ?? tunnelResponse({ sample: tunnelCalls }));
    }
    if (url.includes("/devapi/status.pepvpn?")) {
      return deviceApi(overrides.pepVpn ?? {
        profile: { "60000": { name: "SFC-SFO", status: "CONNECTED", speedfusionConnectProtect: true }, order: [60000] },
        peer: [{ profileId: 60000, peerId: "60000-1", name: "SFC-SFO-022", status: "CONNECTED", dataUseTcp: false, latencyDiffCutoff: 500 }]
      });
    }
    if (url.endsWith("/devapi/status.client?activeOnly=yes&outputWeight=full")) {
      return deviceApi({ list: overrides.clients ?? [
        { mac: "00:00:00:00:00:01", ip: "192.168.50.10", active: true, connectionType: "wireless", essid: "BVM", signalStrength: { value: -58, unit: "dBm" }, signal: { level: 4 }, speed: { download: 12, upload: 3_100, unit: "kbps" } },
        { mac: "00:00:00:00:00:02", active: true, connectionType: "wireless", essid: "BVM" },
        { mac: "00:00:00:00:00:03", active: true, connectionType: "ethernet" }
      ] });
    }
    return new Response(null, { status: 404 });
  });
}

function tunnelResponse({ sample = 1, cellularState = "ACTIVE" }: { sample?: number; cellularState?: string } = {}) {
  const offset = sample - 1;
  const counters = (byte: number, forward: number, loss: number, fec: number) => ({
    byte: [byte + offset * 3_000_000],
    packet: {
      forward: [forward + offset * 5_940],
      loss: [loss + offset * 60],
      fec: [fec + offset * 1_485]
    }
  });
  return { tunnel: { order: ["60000-1"], "60000-1": { wan: {
    order: [1, 2],
    "1": { name: "WAN", state: "ACTIVE", rtt: 53, transmit: counters(10_000_000, 9_900, 100, 2_475) },
    "2": { name: "Cellular", state: cellularState, rtt: cellularState === "ACTIVE" ? 88 : 0, transmit: counters(8_000_000, 7_920, 80, 1_980) }
  } } } };
}

function deviceApi(response: unknown): Response {
  return json({ resp_code: "SUCCESS", data: { stat: "ok", response } });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
