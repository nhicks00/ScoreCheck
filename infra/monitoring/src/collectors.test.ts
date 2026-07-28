import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCollector, metricSum, metricValue, parseEgressMetrics } from "./collectors.js";
import { loadAgentConfig } from "./config.js";

describe("native Prometheus metric parsing", () => {
  const metrics = [
    'livekit_room_total{node_id="node",node_type="SERVER"} 2',
    'livekit_participant_total{node_id="node",node_type="SERVER"} 3',
    'livekit_node_packet_total{node_id="node",type="out"} 1200',
    'livekit_node_packet_total{node_id="node",type="dropped"} 4',
    'livekit_egress_available{node_id="egress"} 1',
    'livekit_load_ratio{node_id="egress",type="cpu"} 0.42',
    'livekit_room_total_bucket{le="1"} 999'
  ].join("\n");

  it("selects exact metric names and bounded labels", () => {
    expect(metricSum(metrics, "livekit_room_total")).toBe(2);
    expect(metricSum(metrics, "livekit_node_packet_total", { type: "out" })).toBe(1200);
    expect(metricSum(metrics, "livekit_node_packet_total", { type: "dropped" })).toBe(4);
    expect(metricValue(metrics, "livekit_egress_available")).toBe(1);
    expect(metricValue(metrics, "livekit_load_ratio", { type: "cpu" })).toBe(0.42);
    expect(metricValue(metrics, "missing_metric")).toBeNull();
  });

  it("enforces the configured web-request ceiling over an unsafe native admission signal", () => {
    const egressMetrics = [
      'livekit_egress_available{node_id="egress"} 0',
      'livekit_egress_can_accept_request{node_id="egress"} 1',
      'livekit_egress_requests{node_id="egress",type="web"} 1',
      'livekit_egress_cgroup_memory_bytes{node_id="egress"} 1000',
      'livekit_load_ratio{node_id="egress",type="cpu"} 0.4',
      'livekit_load_ratio{node_id="egress",type="memory"} 0.2'
    ].join("\n");

    expect(parseEgressMetrics(egressMetrics, 1)).toMatchObject({
      idle: false,
      nativeCanAcceptRequest: true,
      activeWebRequests: 1,
      maximumWebRequests: 1,
      canAcceptRequest: false
    });
    expect(parseEgressMetrics(egressMetrics, 2).canAcceptRequest).toBe(true);
    expect(() => parseEgressMetrics(egressMetrics.replace(/\nlivekit_egress_requests[^\n]+/, ""), 1)).toThrow(/Required Egress state metrics/);
    expect(parseEgressMetrics(
      egressMetrics
        .replace('livekit_egress_available{node_id="egress"} 0', 'livekit_egress_available{node_id="egress"} 1')
        .replace(/\nlivekit_egress_requests[^\n]+/, ""),
      1
    )).toMatchObject({ idle: true, activeWebRequests: 0, maximumWebRequests: 1, canAcceptRequest: true });
    expect(() => parseEgressMetrics(egressMetrics.replace('type="web"} 1', 'type="web"} 1.5'), 1)).toThrow(/Required Egress state metrics/);
    expect(() => parseEgressMetrics(egressMetrics.replace('type="web"} 1', 'type="web"} -1'), 1)).toThrow(/Required Egress state metrics/);
  });
});

describe("agent collector telemetry failures", () => {
  it("reports a configured FFmpeg progress directory that cannot be read", async () => {
    const config = loadAgentConfig({
      MONITOR_AGENT_ID: "rehearsal-ingest",
      MONITOR_AGENT_ROLE: "mediamtx",
      MONITOR_AGENT_TOKEN: "x".repeat(24),
      FFMPEG_PROGRESS_DIR: path.join(tmpdir(), `missing-scorecheck-progress-${Date.now()}`)
    });

    const snapshot = await new AgentCollector(config).collect();

    expect(snapshot.ffmpegBranches).toEqual([]);
    expect(snapshot.collectionErrors).toContain("FFMPEG_PROGRESS_UNAVAILABLE");
  });

  it("collects a strict host-exported Egress supervisor state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scorecheck-egress-supervisor-"));
    const statePath = path.join(directory, "state.json");
    try {
      await writeFile(statePath, JSON.stringify({
        schemaVersion: 1,
        generationKey: "a".repeat(64),
        missingCount: 0,
        recoveryAttempts: 1,
        status: "HEALTHY",
        detail: "The exact owned Egress is active.",
        court: 1,
        egressId: "EG_Test123",
        observedAt: "2026-07-12T18:00:00.000Z"
      }));
      const config = loadAgentConfig({
        MONITOR_AGENT_ID: "compositor-a",
        MONITOR_AGENT_ROLE: "compositor",
        MONITOR_AGENT_TOKEN: "x".repeat(24),
        EGRESS_SUPERVISOR_STATE_PATH: statePath
      });

      const snapshot = await new AgentCollector(config).collect();

      expect(snapshot.egressSupervisor).toMatchObject({ status: "HEALTHY", court: 1, egressId: "EG_Test123", recoveryAttempts: 1 });
      expect(snapshot.collectionErrors).not.toContain("EGRESS_SUPERVISOR_UNAVAILABLE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed Egress supervisor state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scorecheck-egress-supervisor-"));
    const statePath = path.join(directory, "state.json");
    try {
      await writeFile(statePath, '{"schemaVersion":1,"status":"HEALTHY"}');
      const config = loadAgentConfig({
        MONITOR_AGENT_ID: "compositor-a",
        MONITOR_AGENT_ROLE: "compositor",
        MONITOR_AGENT_TOKEN: "x".repeat(24),
        EGRESS_SUPERVISOR_STATE_PATH: statePath
      });

      const snapshot = await new AgentCollector(config).collect();

      expect(snapshot.egressSupervisor).toBeNull();
      expect(snapshot.collectionErrors).toContain("EGRESS_SUPERVISOR_UNAVAILABLE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("collects strict output-owned program-warmer state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scorecheck-program-warmer-"));
    const statePath = path.join(directory, "state.json");
    try {
      await writeFile(statePath, JSON.stringify({
        schemaVersion: 1,
        court: 1,
        status: "WARM",
        ffmpegPid: 1234,
        restartCount: 2,
        observedAt: "2026-07-12T18:00:00.000Z"
      }));
      const config = loadAgentConfig({
        MONITOR_AGENT_ID: "compositor-a",
        MONITOR_AGENT_ROLE: "compositor",
        MONITOR_AGENT_TOKEN: "x".repeat(24),
        PROGRAM_WARMER_STATE_PATH: statePath
      });

      const snapshot = await new AgentCollector(config).collect();

      expect(snapshot.programWarmer).toMatchObject({ status: "WARM", court: 1, ffmpegPid: 1234, restartCount: 2 });
      expect(snapshot.collectionErrors).not.toContain("PROGRAM_WARMER_UNAVAILABLE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on semantically malformed program-warmer state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "scorecheck-program-warmer-"));
    const statePath = path.join(directory, "state.json");
    try {
      await writeFile(statePath, JSON.stringify({
        schemaVersion: 1,
        court: 1,
        status: "WARM",
        ffmpegPid: null,
        restartCount: 2,
        observedAt: "2026-07-12T18:00:00.000Z"
      }));
      const config = loadAgentConfig({
        MONITOR_AGENT_ID: "compositor-a",
        MONITOR_AGENT_ROLE: "compositor",
        MONITOR_AGENT_TOKEN: "x".repeat(24),
        PROGRAM_WARMER_STATE_PATH: statePath
      });

      const snapshot = await new AgentCollector(config).collect();

      expect(snapshot.programWarmer).toBeNull();
      expect(snapshot.collectionErrors).toContain("PROGRAM_WARMER_UNAVAILABLE");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
