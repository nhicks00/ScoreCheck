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
});
