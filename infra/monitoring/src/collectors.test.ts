import { describe, expect, it } from "vitest";
import { metricSum, metricValue, parseEgressMetrics } from "./collectors.js";

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
