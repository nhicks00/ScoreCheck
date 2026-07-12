import { describe, expect, it } from "vitest";
import { loadAgentConfig, loadServiceConfig, parseAgentTargets } from "./config.js";

describe("monitoring configuration", () => {
  it("parses bounded agent targets", () => {
    expect(parseAgentTargets("preview|mediamtx|http://10.0.0.2:9108|abcdefghijklmnopqrstuvwxyz")).toEqual([{
      id: "preview",
      role: "mediamtx",
      url: "http://10.0.0.2:9108",
      token: "abcdefghijklmnopqrstuvwxyz"
    }]);
  });

  it("rejects malformed and short-token targets", () => {
    expect(() => parseAgentTargets("preview|mediamtx|http://10.0.0.2:9108|short")).toThrow();
    expect(() => parseAgentTargets("preview|invalid|http://10.0.0.2:9108|abcdefghijklmnopqrstuvwxyz")).toThrow();
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
      HEALTHCHECKS_PING_URL: "",
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    });
    expect(service.healthchecksPingUrl).toBeNull();
    expect(service.supabaseUrl).toBeNull();
    expect(service.browserAllowedOrigins).toEqual(["https://score.beachvolleyballmedia.com"]);
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
});
