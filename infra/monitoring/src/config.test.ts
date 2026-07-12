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

    const service = loadServiceConfig({
      MONITOR_API_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      ALERTMANAGER_WEBHOOK_TOKEN: "zyxwvutsrqponmlkjihgfedcba",
      MONITOR_BROWSER_HEARTBEAT_SECRET: "browser-heartbeat-secret-that-is-long-enough",
      MONITOR_PUBLIC_HOST: "monitor.example.test",
      HEALTHCHECKS_BASELINE_PING_URL: "",
      HEALTHCHECKS_ACTIVE_PING_URL: "",
      HEALTHCHECKS_API_KEY: "",
      HEALTHCHECKS_ACTIVE_CHECK_ID: "",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    });
    expect(service.healthchecksBaselinePingUrl).toBeNull();
    expect(service.healthchecksActivePingUrl).toBeNull();
    expect(service.healthchecksApiKey).toBeNull();
    expect(service.healthchecksActiveCheckId).toBeNull();
    expect(service.supabaseUrl).toBeNull();
    expect(service.browserAllowedOrigins).toEqual(["https://score.beachvolleyballmedia.com"]);
  });

  it("requires active Healthchecks lifecycle credentials as one unit", () => {
    const base = {
      MONITOR_API_TOKEN: "abcdefghijklmnopqrstuvwxyz",
      ALERTMANAGER_WEBHOOK_TOKEN: "zyxwvutsrqponmlkjihgfedcba",
      MONITOR_BROWSER_HEARTBEAT_SECRET: "browser-heartbeat-secret-that-is-long-enough",
      MONITOR_PUBLIC_HOST: "monitor.example.test"
    };
    expect(() => loadServiceConfig({
      ...base,
      HEALTHCHECKS_ACTIVE_PING_URL: "https://hc-ping.com/active"
    })).toThrow(/ping URL, write API key, and check id/);
    expect(loadServiceConfig({
      ...base,
      HEALTHCHECKS_ACTIVE_PING_URL: "https://hc-ping.com/active",
      HEALTHCHECKS_API_KEY: "healthchecks-write-key",
      HEALTHCHECKS_ACTIVE_CHECK_ID: "220650f2-ed19-479c-933e-b0df1246ba81"
    }).healthchecksActiveCheckId).toBe("220650f2-ed19-479c-933e-b0df1246ba81");
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
});
