import { describe, expect, it } from "vitest";
import { metricSum } from "./collectors.js";

describe("native Prometheus metric parsing", () => {
  const metrics = [
    'livekit_room_total{node_id="node",node_type="SERVER"} 2',
    'livekit_participant_total{node_id="node",node_type="SERVER"} 3',
    'livekit_node_packet_total{node_id="node",type="out"} 1200',
    'livekit_node_packet_total{node_id="node",type="dropped"} 4',
    'livekit_room_total_bucket{le="1"} 999'
  ].join("\n");

  it("selects exact metric names and bounded labels", () => {
    expect(metricSum(metrics, "livekit_room_total")).toBe(2);
    expect(metricSum(metrics, "livekit_node_packet_total", { type: "out" })).toBe(1200);
    expect(metricSum(metrics, "livekit_node_packet_total", { type: "dropped" })).toBe(4);
  });
});
