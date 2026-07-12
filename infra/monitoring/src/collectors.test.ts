import { describe, expect, it } from "vitest";
import { metricSum, metricValue } from "./collectors.js";

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
});
