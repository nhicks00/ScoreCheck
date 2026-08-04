import { describe, expect, it, vi } from "vitest";
import type { UniFiConfig } from "./config.js";
import { UniFiCollector } from "./unifi.js";

const nowMs = Date.parse("2026-08-04T18:00:00.000Z");
const accessPoints = [1, 2, 3].map((number) => ({
  name: `scorecheck-ap-${number}`,
  deviceId: `20000000-0000-4000-8000-00000000000${number}`,
  macAddress: `00:11:22:33:44:0${number}`
}));

const config: UniFiConfig = {
  required: true,
  configured: true,
  apiKey: "protected-api-key",
  hostId: "900A6F003011:123456789",
  siteId: "10000000-0000-4000-8000-000000000001",
  accessPoints,
  pollIntervalMs: 30_000
};

describe("UniFi collector", () => {
  it("stays not applicable without a commissioned site", async () => {
    const request = vi.fn();
    const collector = new UniFiCollector({ ...config, required: false, configured: false, apiKey: null, hostId: null, siteId: null, accessPoints: [] }, request as typeof fetch);
    await collector.refresh(nowMs);
    expect(collector.current()).toMatchObject({ state: "NOT_APPLICABLE", configured: false, apiReachable: null });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports healthy APs, radio statistics, and client-to-AP associations", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("protected-api-key");
      const url = String(input);
      if (url.endsWith("/devices?offset=0&limit=200")) return json({ data: accessPoints.map(device), totalCount: 3 });
      if (url.endsWith("/clients?offset=0&limit=200")) return json({
        data: [{ id: "30000000-0000-4000-8000-000000000001", name: "Camera 1", macAddress: "aa:bb:cc:dd:ee:01", ipAddress: "192.168.50.101", type: "WIRELESS", uplinkDeviceId: accessPoints[0]?.deviceId }],
        totalCount: 1
      });
      if (url.includes("/statistics/latest")) return json(statistics());
      return new Response(null, { status: 404 });
    });
    const collector = new UniFiCollector(config, request as typeof fetch);
    await collector.refresh(nowMs);
    const snapshot = collector.current();
    expect(snapshot).toMatchObject({ state: "HEALTHY", apiReachable: true, onlineAccessPoints: 3, connectedClients: 1, problems: [] });
    expect(snapshot.accessPoints[0]?.radios).toEqual([{ frequencyGHz: 5, txRetriesPct: 4 }]);
    expect(snapshot.clients[0]).toMatchObject({ name: "Camera 1", uplinkDeviceId: accessPoints[0]?.deviceId });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("fails the AP state for missing identity and degrades on high Wi-Fi retries", async () => {
    const wrongMac = { ...accessPoints[0]!, macAddress: "00:11:22:33:44:ff" };
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/devices?offset=0&limit=200")) return json({ data: [device(wrongMac), device(accessPoints[1]!), device(accessPoints[2]!)], totalCount: 3 });
      if (url.endsWith("/clients?offset=0&limit=200")) return json({ data: [], totalCount: 0 });
      if (url.includes(accessPoints[1]!.deviceId)) return json(statistics(40));
      return json(statistics());
    });
    const collector = new UniFiCollector(config, request as typeof fetch);
    await collector.refresh(nowMs);
    expect(collector.current().state).toBe("CRITICAL");
    expect(collector.current().problems).toContain("scorecheck-ap-1 identity does not match its commissioned MAC address.");
    expect(collector.current().problems).toContain("scorecheck-ap-2 is retransmitting too much Wi-Fi traffic.");
  });

  it("reports sanitized API failure without discarding prior AP evidence", async () => {
    let fail = false;
    const request = vi.fn(async (input: string | URL | Request) => {
      if (fail) return new Response(null, { status: 401 });
      const url = String(input);
      if (url.endsWith("/devices?offset=0&limit=200")) return json({ data: accessPoints.map(device), totalCount: 3 });
      if (url.endsWith("/clients?offset=0&limit=200")) return json({ data: [], totalCount: 0 });
      return json(statistics());
    });
    const collector = new UniFiCollector(config, request as typeof fetch);
    await collector.refresh(nowMs);
    fail = true;
    await collector.refresh(nowMs + 30_000);
    const snapshot = collector.current();
    expect(snapshot).toMatchObject({ state: "DEGRADED", apiReachable: false, onlineAccessPoints: 3 });
    expect(snapshot.problems).toEqual(["UniFi telemetry could not be read. Check Official UniFi Hosting and its API key."]);
    expect(JSON.stringify(snapshot)).not.toContain("protected-api-key");
  });
});

function device(binding: (typeof accessPoints)[number]) {
  return { id: binding.deviceId, name: binding.name, macAddress: binding.macAddress, model: "UK-Ultra", firmwareVersion: "7.0.0", ipAddress: "192.168.50.2", state: "ONLINE", features: ["accessPoint"] };
}

function statistics(txRetriesPct = 4) {
  return {
    cpuUtilizationPct: 20,
    memoryUtilizationPct: 35,
    lastHeartbeatAt: new Date(nowMs).toISOString(),
    uplink: { txRateBps: 1_000, rxRateBps: 2_000 },
    interfaces: { radios: [{ frequencyGHz: 5, txRetriesPct }] }
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
