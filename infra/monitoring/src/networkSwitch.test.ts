import { describe, expect, it } from "vitest";
import type { NetworkSwitchConfig } from "./config.js";
import { NetworkSwitchCollector, parsePrometheusText } from "./networkSwitch.js";

const config: NetworkSwitchConfig = {
  required: true,
  configured: true,
  exporterUrl: "http://snmp-exporter:9116",
  target: "192.168.50.2",
  model: "POE-SWR612GM-SOLAR",
  firmwareVersion: "V200SP10251021",
  ports: [
    { id: "1", name: "UK Ultra 1", role: "access_point", expected: true },
    { id: "9", name: "Peplink LAN 2", role: "router_uplink", expected: true }
  ],
  pollIntervalMs: 30_000
};

describe("network switch collector", () => {
  it("parses escaped Prometheus labels without accepting malformed input", () => {
    const parsed = parsePrometheusText('ifIndex{ifAlias="UK Ultra 1",ifIndex="1"} 1\n');
    expect(parsed.get("ifIndex")?.[0]).toEqual({ labels: { ifAlias: "UK Ultra 1", ifIndex: "1" }, value: 1 });
    expect(() => parsePrometheusText('ifIndex{broken} 1\n')).toThrow(/Invalid Prometheus labels/);
  });

  it("reports commissioned links and reset-safe traffic rates", async () => {
    let sampleNumber = 0;
    const collector = new NetworkSwitchCollector(config, async (input) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("target")).toBe("192.168.50.2");
      expect(url.searchParams.get("auth")).toBe("scorecheck_linovision_v3");
      expect(url.searchParams.get("module")).toBe("system,if_mib,linovision_poe");
      return new Response(metrics(sampleNumber++));
    });

    await collector.refresh(Date.parse("2026-08-07T00:00:00.000Z"));
    expect(collector.current()).toMatchObject({
      state: "HEALTHY",
      reachable: true,
      model: "POE-SWR612GM-SOLAR",
      firmwareVersion: "V200SP10251021",
      uptimeSeconds: 1_000,
      poe: { supported: true, budgetWatts: 240, consumptionWatts: 8, remainingWatts: 232 }
    });
    expect(collector.current().ports[0]).toMatchObject({ operationalUp: true, speedMbps: 1_000, rxBps: null, poe: { deliveringPower: true, powerWatts: 3.2, limitWatts: 45 } });

    await collector.refresh(Date.parse("2026-08-07T00:00:30.000Z"));
    expect(collector.current().ports[0]).toMatchObject({ rxBps: 800, txBps: 1_600, inputErrorsPerSecond: 0, outputDiscardsPerSecond: 0 });
  });

  it("marks expected link and PoE loss critical", async () => {
    const collector = new NetworkSwitchCollector(config, async () => new Response(metrics(0, { apUp: false, apPower: false })));
    await collector.refresh(Date.parse("2026-08-07T00:00:00.000Z"));
    expect(collector.current().state).toBe("CRITICAL");
    expect(collector.current().problems).toEqual(expect.arrayContaining(["UK Ultra 1 link is down.", "UK Ultra 1 is not receiving PoE power."]));
  });

  it("fails closed without presenting cached data as reachable", async () => {
    let healthy = true;
    const collector = new NetworkSwitchCollector(config, async () => healthy ? new Response(metrics(0)) : new Response("unavailable", { status: 503 }));
    await collector.refresh(Date.parse("2026-08-07T00:00:00.000Z"));
    healthy = false;
    await collector.refresh(Date.parse("2026-08-07T00:00:30.000Z"));
    expect(collector.current()).toMatchObject({ state: "DEGRADED", reachable: false, lastSuccessAt: "2026-08-07T00:00:00.000Z", lastFailureAt: "2026-08-07T00:00:30.000Z" });
  });
});

function metrics(sampleNumber: number, state: { apUp?: boolean; apPower?: boolean } = {}): string {
  const increment = sampleNumber * 3_000;
  const apUp = state.apUp === false ? 2 : 1;
  const apPower = state.apPower === false ? 2 : 1;
  return `sysUpTime 100000
ifAdminStatus{ifIndex="1"} 1
ifOperStatus{ifIndex="1"} ${apUp}
ifHighSpeed{ifIndex="1"} 1000
ifLastChange{ifIndex="1"} 90000
ifHCInOctets{ifIndex="1"} ${1000 + increment}
ifHCOutOctets{ifIndex="1"} ${2000 + increment * 2}
ifInErrors{ifIndex="1"} 0
ifOutErrors{ifIndex="1"} 0
ifInDiscards{ifIndex="1"} 0
ifOutDiscards{ifIndex="1"} 0
ifAdminStatus{ifIndex="9"} 1
ifOperStatus{ifIndex="9"} 1
ifHighSpeed{ifIndex="9"} 1000
ifLastChange{ifIndex="9"} 90000
ifHCInOctets{ifIndex="9"} ${3000 + increment}
ifHCOutOctets{ifIndex="9"} ${4000 + increment}
ifInErrors{ifIndex="9"} 0
ifOutErrors{ifIndex="9"} 0
ifInDiscards{ifIndex="9"} 0
ifOutDiscards{ifIndex="9"} 0
linovision_poe_budget_watts 240
linovision_poe_consumption_watts 8
linovision_poe_port_configured{port="1"} 1
linovision_poe_port_limit_watts{port="1"} 45
linovision_poe_port_power_watts{port="1"} 3.2
linovision_poe_port_delivery_state{port="1"} ${apPower}
`;
}
