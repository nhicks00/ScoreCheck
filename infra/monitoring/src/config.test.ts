import { describe, expect, it } from "vitest";
import { loadAgentConfig, loadServiceConfig, parseAgentTargets } from "./config.js";

describe("monitoring configuration", () => {
  it("parses bounded agent targets", () => {
    expect(parseAgentTargets("preview|mediamtx|http://10.0.0.2:9108|abcdefghijklmnopqrstuvwxyz|")).toEqual([{
      id: "preview",
      role: "mediamtx",
      url: "http://10.0.0.2:9108",
      token: "abcdefghijklmnopqrstuvwxyz",
      assignedCourts: []
    }]);
    expect(parseAgentTargets("compositor-a|compositor|http://10.0.0.3:9108|abcdefghijklmnopqrstuvwxyz|2+1")[0]?.assignedCourts).toEqual([1, 2]);
  });

  it("rejects malformed and short-token targets", () => {
    expect(() => parseAgentTargets("preview|mediamtx|http://10.0.0.2:9108|short")).toThrow();
    expect(() => parseAgentTargets("preview|invalid|http://10.0.0.2:9108|abcdefghijklmnopqrstuvwxyz")).toThrow();
    expect(() => parseAgentTargets("preview|mediamtx|http://10.0.0.2:9108|abcdefghijklmnopqrstuvwxyz")).toThrow();
    expect(() => parseAgentTargets("preview|mediamtx|http://10.0.0.2:9108|abcdefghijklmnopqrstuvwxyz|1")).toThrow();
    expect(() => parseAgentTargets("compositor-a|compositor|http://10.0.0.3:9108|abcdefghijklmnopqrstuvwxyz|")).toThrow();
    expect(() => parseAgentTargets("compositor-a|compositor|http://10.0.0.3:9108|abcdefghijklmnopqrstuvwxyz|1,2")).toThrow();
    expect(() => parseAgentTargets("compositor-a|compositor|http://10.0.0.3:9108|abcdefghijklmnopqrstuvwxyz|1,compositor-b|compositor|http://10.0.0.4:9108|zyxwvutsrqponmlkjihgfedcba|1")).toThrow();
  });

  it("treats empty optional URLs and provider values as unset", () => {
    const agent = loadAgentConfig({
      MONITOR_AGENT_ID: "agent",
      MONITOR_AGENT_ROLE: "mediamtx",
      MONITOR_AGENT_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      LIVEKIT_METRICS_URL: "",
      EGRESS_METRICS_URL: ""
    });
    expect(agent.livekitMetricsUrl).toBeNull();
    expect(agent.egressMetricsUrl).toBeNull();
    expect(agent.egressSupervisorStatePath).toBeNull();
    expect(agent.programWarmerStatePath).toBeNull();
    expect(agent.egressMaxWebRequests).toBe(1);

    const service = loadServiceConfig({
      MONITOR_API_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      ALERTMANAGER_WEBHOOK_TOKEN: "zyxwvutsrqponmlkjihgfedcba",
      MONITOR_BROWSER_HEARTBEAT_SECRET: "browser-heartbeat-secret-that-is-long-enough",
      MONITOR_PUBLIC_HOST: "monitor.example.test",
      HEALTHCHECKS_BASELINE_PING_URL: "",
      HEALTHCHECKS_BASELINE_CHECK_ID: "",
      HEALTHCHECKS_ACTIVE_PING_URL: "",
      HEALTHCHECKS_API_KEY: "",
      HEALTHCHECKS_ACTIVE_CHECK_ID: "",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    });
    expect(service.healthchecksBaselinePingUrl).toBeNull();
    expect(service.healthchecksBaselineCheckId).toBeNull();
    expect(service.healthchecksActivePingUrl).toBeNull();
    expect(service.healthchecksApiKey).toBeNull();
    expect(service.healthchecksActiveCheckId).toBeNull();
    expect(service.supabaseUrl).toBeNull();
    expect(service.browserAllowedOrigins).toEqual(["https://score.beachvolleyballmedia.com"]);
    expect(service.intervalMs).toBe(1_000);
  });

  it("requires the complete Healthchecks lifecycle and channel-audit configuration as one unit", () => {
    const base = {
      MONITOR_API_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      ALERTMANAGER_WEBHOOK_TOKEN: "zyxwvutsrqponmlkjihgfedcba",
      MONITOR_BROWSER_HEARTBEAT_SECRET: "browser-heartbeat-secret-that-is-long-enough",
      MONITOR_PUBLIC_HOST: "monitor.example.test"
    };
    expect(() => loadServiceConfig({
      ...base,
      HEALTHCHECKS_ACTIVE_PING_URL: "https://hc-ping.com/active"
    })).toThrow(/both ping URLs, both check ids, and the write API key/);
    const parsed = loadServiceConfig({
      ...base,
      HEALTHCHECKS_BASELINE_PING_URL: "https://hc-ping.com/baseline",
      HEALTHCHECKS_BASELINE_CHECK_ID: "120650f2-ed19-479c-933e-b0df1246ba81",
      HEALTHCHECKS_ACTIVE_PING_URL: "https://hc-ping.com/active",
      HEALTHCHECKS_API_KEY: "healthchecks-write-key",
      HEALTHCHECKS_ACTIVE_CHECK_ID: "220650f2-ed19-479c-933e-b0df1246ba81"
    });
    expect(parsed.healthchecksBaselineCheckId).toBe("120650f2-ed19-479c-933e-b0df1246ba81");
    expect(parsed.healthchecksActiveCheckId).toBe("220650f2-ed19-479c-933e-b0df1246ba81");
    expect(parsed.healthchecksChannelAuditIntervalMs).toBe(300_000);
  });

  it("keeps UniFi optional until the three real access points are commissioned", () => {
    const base = {
      MONITOR_API_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      ALERTMANAGER_WEBHOOK_TOKEN: "zyxwvutsrqponmlkjihgfedcba",
      MONITOR_BROWSER_HEARTBEAT_SECRET: "browser-heartbeat-secret-that-is-long-enough",
      MONITOR_PUBLIC_HOST: "monitor.example.test"
    };
    expect(loadServiceConfig(base).unifi).toMatchObject({ required: false, configured: false, accessPoints: [] });
    expect(() => loadServiceConfig({ ...base, MONITOR_UNIFI_REQUIRED: "true" })).toThrow(/requires its API key/);
    expect(() => loadServiceConfig({ ...base, MONITOR_UNIFI_API_KEY: "partial" })).toThrow(/requires its API key/);
  });

  it("requires and parses the complete commissioned Peplink contract", () => {
    const base = {
      MONITOR_API_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      ALERTMANAGER_WEBHOOK_TOKEN: "zyxwvutsrqponmlkjihgfedcba",
      MONITOR_BROWSER_HEARTBEAT_SECRET: "browser-heartbeat-secret-that-is-long-enough",
      MONITOR_PUBLIC_HOST: "monitor.example.test"
    };
    expect(loadServiceConfig(base).peplink).toMatchObject({ required: false, configured: false, wans: [] });
    expect(() => loadServiceConfig({ ...base, MONITOR_PEPLINK_REQUIRED: "true" })).toThrow(/not configured/);
    const configured = {
      ...base,
      MONITOR_PEPLINK_REQUIRED: "true",
      MONITOR_PEPLINK_CLIENT_ID: "a".repeat(32),
      MONITOR_PEPLINK_CLIENT_SECRET: "b".repeat(32),
      MONITOR_PEPLINK_ORGANIZATION_ID: "org123",
      MONITOR_PEPLINK_GROUP_ID: "3",
      MONITOR_PEPLINK_DEVICE_ID: "9",
      MONITOR_PEPLINK_PRODUCT_CODE: "MAX-BR1-PRO-5GK-T-PRM",
      MONITOR_PEPLINK_HARDWARE_VERSION: "3",
      MONITOR_PEPLINK_FIRMWARE_VERSION: "8.6.0 build 6450",
      MONITOR_PEPLINK_SPEEDFUSION_PROFILE_NAME: "SFC-SFO",
      MONITOR_PEPLINK_CAMERA_SSID: "BVM",
      MONITOR_PEPLINK_WANS_JSON: JSON.stringify([
        { id: 1, name: "WAN", required: true },
        { id: 2, name: "Cellular", required: true }
      ])
    };
    expect(loadServiceConfig(configured).peplink).toMatchObject({
      required: true,
      configured: true,
      groupId: 3,
      deviceId: 9,
      productCode: "MAX-BR1-PRO-5GK-T-PRM",
      firmwareVersion: "8.6.0 build 6450",
      wans: [{ id: 1, name: "WAN", required: true }, { id: 2, name: "Cellular", required: true }]
    });
    expect(() => loadServiceConfig({ ...configured, MONITOR_PEPLINK_CLIENT_SECRET: "" })).toThrow(/complete InControl/);
    expect(() => loadServiceConfig({ ...configured, MONITOR_PEPLINK_FIRMWARE_VERSION: "8.5.4 build 6264" })).toThrow(/8.6.0 build 6450/);
    expect(() => loadServiceConfig({ ...configured, MONITOR_PEPLINK_WANS_JSON: "[]" })).toThrow(/valid WAN bindings/);
  });

  it("parses exactly three unique commissioned UniFi access points", () => {
    const base = {
      MONITOR_API_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      ALERTMANAGER_WEBHOOK_TOKEN: "zyxwvutsrqponmlkjihgfedcba",
      MONITOR_BROWSER_HEARTBEAT_SECRET: "browser-heartbeat-secret-that-is-long-enough",
      MONITOR_PUBLIC_HOST: "monitor.example.test",
      MONITOR_UNIFI_REQUIRED: "true",
      MONITOR_UNIFI_API_KEY: "unifi-api-key",
      MONITOR_UNIFI_BASE_URL: "https://unifi.example.test/proxy/network/integration/v1/",
      MONITOR_UNIFI_SITE_ID: "10000000-0000-4000-8000-000000000001"
    };
    const accessPoints = [1, 2, 3].map((number) => ({
      name: `UK Ultra ${number}`,
      deviceId: `20000000-0000-4000-8000-00000000000${number}`,
      macAddress: `00:11:22:33:44:0${number}`
    }));
    const parsed = loadServiceConfig({ ...base, MONITOR_UNIFI_ACCESS_POINTS_JSON: JSON.stringify(accessPoints) });
    expect(parsed.unifi).toMatchObject({ required: true, configured: true, baseUrl: "https://unifi.example.test/proxy/network/integration/v1", accessPoints });
    expect(() => loadServiceConfig({ ...base, MONITOR_UNIFI_ACCESS_POINTS_JSON: JSON.stringify(accessPoints.slice(0, 2)) })).toThrow();
    expect(() => loadServiceConfig({ ...base, MONITOR_UNIFI_ACCESS_POINTS_JSON: JSON.stringify([accessPoints[0], accessPoints[0], accessPoints[2]]) })).toThrow(/unique/);
    expect(() => loadServiceConfig({ ...base, MONITOR_UNIFI_BASE_URL: "http://unifi.example.test/proxy/network/integration/v1", MONITOR_UNIFI_ACCESS_POINTS_JSON: JSON.stringify(accessPoints) })).toThrow(/credential-free HTTPS/);
    expect(() => loadServiceConfig({ ...base, MONITOR_UNIFI_BASE_URL: "https://unifi.example.test/network/default", MONITOR_UNIFI_ACCESS_POINTS_JSON: JSON.stringify(accessPoints) })).toThrow(/integration API URL/);
  });

  it("requires a complete, bounded network-switch contract", () => {
    const base = {
      MONITOR_API_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      ALERTMANAGER_WEBHOOK_TOKEN: "zyxwvutsrqponmlkjihgfedcba",
      MONITOR_BROWSER_HEARTBEAT_SECRET: "browser-heartbeat-secret-that-is-long-enough",
      MONITOR_PUBLIC_HOST: "monitor.example.test"
    };
    expect(loadServiceConfig(base).networkSwitch).toMatchObject({ required: false, configured: false, ports: [] });
    expect(() => loadServiceConfig({ ...base, MONITOR_NETWORK_SWITCH_REQUIRED: "true" })).toThrow(/not configured/);
    const ports = [
      { id: "1", name: "UK Ultra 1", role: "access_point", expected: true },
      { id: "9", name: "Peplink LAN 2", role: "router_uplink", expected: true }
    ];
    const configured = {
      ...base,
      MONITOR_NETWORK_SWITCH_REQUIRED: "true",
      MONITOR_NETWORK_SWITCH_EXPORTER_URL: "http://snmp-exporter:9116/",
      MONITOR_NETWORK_SWITCH_TARGET: "192.168.50.2",
      MONITOR_NETWORK_SWITCH_MODEL: "POE-SWR612GM-SOLAR",
      MONITOR_NETWORK_SWITCH_FIRMWARE_VERSION: "V200SP10251021",
      MONITOR_NETWORK_SWITCH_PORTS_JSON: JSON.stringify(ports)
    };
    expect(loadServiceConfig(configured).networkSwitch).toMatchObject({
      required: true,
      configured: true,
      exporterUrl: "http://snmp-exporter:9116",
      target: "192.168.50.2",
      ports
    });
    expect(loadServiceConfig({ ...configured, MONITOR_NETWORK_SWITCH_TARGET: "10.120.0.3:1161" }).networkSwitch.target).toBe("10.120.0.3:1161");
    expect(() => loadServiceConfig({ ...configured, MONITOR_NETWORK_SWITCH_TARGET: "http://192.168.50.2" })).toThrow(/hostname or IPv4/);
    expect(() => loadServiceConfig({ ...configured, MONITOR_NETWORK_SWITCH_TARGET: "10.120.0.3:65536" })).toThrow(/hostname or IPv4/);
    expect(() => loadServiceConfig({ ...configured, MONITOR_NETWORK_SWITCH_EXPORTER_URL: "https://snmp-exporter:9116" })).toThrow(/internal HTTP origin/);
    expect(() => loadServiceConfig({ ...configured, MONITOR_NETWORK_SWITCH_PORTS_JSON: JSON.stringify([ports[0], ports[0]]) })).toThrow(/unique/);
  });

  it("normalizes API base URLs without a trailing slash", () => {
    const agent = loadAgentConfig({
      MONITOR_AGENT_ID: "agent",
      MONITOR_AGENT_ROLE: "mediamtx",
      MONITOR_AGENT_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      MEDIAMTX_API_URL: "http://127.0.0.1:9997/"
    });
    expect(agent.mediamtxApiUrl).toBe("http://127.0.0.1:9997");
  });

  it("normalizes bounded compositor court assignments", () => {
    const agent = loadAgentConfig({
      MONITOR_AGENT_ID: "compositor-a",
      MONITOR_AGENT_ROLE: "compositor",
      MONITOR_AGENT_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      MONITOR_AGENT_COURTS: "2,1,2"
    });
    expect(agent.assignedCourts).toEqual([1, 2]);
    expect(() => loadAgentConfig({
      MONITOR_AGENT_ID: "compositor-a",
      MONITOR_AGENT_ROLE: "compositor",
      MONITOR_AGENT_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      MONITOR_AGENT_COURTS: "9"
    })).toThrow();
  });

  it("binds camera-content analyzers to owned compositor courts and a credential-free RTSP origin", () => {
    const base = {
      MONITOR_AGENT_ID: "compositor-a",
      MONITOR_AGENT_ROLE: "compositor",
      MONITOR_AGENT_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      MONITOR_AGENT_COURTS: "1,2"
    };
    const parsed = loadAgentConfig({
      ...base,
      MONITOR_CONTENT_ANALYZER_COURTS: "2",
      MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: "rtsp://10.0.0.2:8554/"
    });
    expect(parsed.contentAnalyzerCourts).toEqual([2]);
    expect(parsed.contentAnalyzerRtspBaseUrl).toBe("rtsp://10.0.0.2:8554");
    expect(() => loadAgentConfig({ ...base, MONITOR_CONTENT_ANALYZER_COURTS: "3", MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: "rtsp://10.0.0.2:8554" })).toThrow(/must be owned/);
    expect(() => loadAgentConfig({ ...base, MONITOR_CONTENT_ANALYZER_COURTS: "1" })).toThrow(/requires MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL/);
    expect(() => loadAgentConfig({ ...base, MONITOR_CONTENT_ANALYZER_COURTS: "1", MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: "rtsp://user:pass@10.0.0.2:8554" })).toThrow();
    expect(() => loadAgentConfig({ ...base, MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: "rtsp://10.0.0.2:8554" })).toThrow(/requires at least one analyzer court/);
    expect(() => loadAgentConfig({ ...base, MONITOR_AGENT_ROLE: "commentary", MONITOR_CONTENT_ANALYZER_COURTS: "1", MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: "rtsp://10.0.0.2:8554" })).toThrow(/only on compositor/);
  });

  it("bounds the compositor web Egress ceiling", () => {
    const base = {
      MONITOR_AGENT_ID: "compositor-a",
      MONITOR_AGENT_ROLE: "compositor",
      MONITOR_AGENT_TOKEN: "abcdefghijklmnopqrstuvwxyz"
    };
    expect(loadAgentConfig({ ...base, MONITOR_EGRESS_MAX_WEB_REQUESTS: "2" }).egressMaxWebRequests).toBe(2);
    expect(() => loadAgentConfig({ ...base, MONITOR_EGRESS_MAX_WEB_REQUESTS: "0" })).toThrow();
  });

  it("accepts only a bounded absolute Egress supervisor state path", () => {
    const base = {
      MONITOR_AGENT_ID: "compositor-a",
      MONITOR_AGENT_ROLE: "compositor",
      MONITOR_AGENT_TOKEN: "abcdefghijklmnopqrstuvwxyz"
    };
    expect(loadAgentConfig({ ...base, EGRESS_SUPERVISOR_STATE_PATH: "/monitoring/egress-supervisor/state.json" }).egressSupervisorStatePath)
      .toBe("/monitoring/egress-supervisor/state.json");
    expect(() => loadAgentConfig({ ...base, EGRESS_SUPERVISOR_STATE_PATH: "relative/state.json" })).toThrow();
    expect(() => loadAgentConfig({ ...base, EGRESS_SUPERVISOR_STATE_PATH: "/monitoring/../state.json" })).toThrow();
    expect(loadAgentConfig({ ...base, PROGRAM_WARMER_STATE_PATH: "/monitoring/program-warmer/state.json" }).programWarmerStatePath)
      .toBe("/monitoring/program-warmer/state.json");
    expect(() => loadAgentConfig({ ...base, PROGRAM_WARMER_STATE_PATH: "relative/state.json" })).toThrow();
  });
});
