import { describe, expect, it } from "vitest";
import { RouterHeartbeatManager } from "./routerHeartbeats.js";

const now = new Date("2026-07-27T22:00:10.000Z");

function heartbeat(overrides: Record<string, unknown> = {}) {
  return {
    version: 4,
    sessionId: "120650f2-ed19-479c-933e-b0df1246ba81",
    sequence: 1,
    sampledAt: "2026-07-27T22:00:09.000Z",
    speedify: {
      state: "CONNECTED",
      softwareVersion: "17.0.4-12943",
      bondingMode: "streaming",
      transportMode: "udp",
      adapterCount: 2,
      automaticAdapterCount: 2,
      sendBps: 24_000_000,
      receiveBps: 300_000,
      estimatedUploadBps: 40_000_000,
      latencyMs: 68,
      jitterMs: 4,
      lossSendRatio: 0,
      lossReceiveRatio: 0,
      uploadCongested: false,
      badCpu: false,
      badLatency: false,
      badLoss: false,
      badMemory: false,
      readQueuePackets: 0,
      failoverCount: 2
    },
    routing: {
      srtDevice: "connectify0",
      rtmpDevice: "connectify0",
      primaryRuleCount: 2,
      guardRuleCount: 2,
      killSwitchActive: true,
      cameraFlowCount: 8
    },
    cameraWifi: {
      interface: "rax0",
      associatedClientCount: 8,
      minimumSignalDbm: -68
    },
    host: {
      load1: 1.2,
      cpuUsageRatio: 0.42,
      memoryAvailableBytes: 180_000_000,
      speedifyRssBytes: 48_000_000,
      streamingStatsProcessCount: 0
    },
    uplinks: [
      uplink("eth0", "ethernet", "always", 15_000_000),
      uplink("rmnet_mhi0", "cellular", "secondary", 9_000_000)
    ],
    ...overrides
  };
}

function uplink(
  id: string,
  type: "ethernet" | "cellular",
  priority: "always" | "secondary",
  sendBps: number,
  savedPriority: "automatic" | "always" | "secondary" | "backup" | "never" | "unknown" = "automatic"
) {
  return {
    id,
    isp: id === "eth0" ? "Venue broadband" : "Venue cellular",
    type,
    connected: true,
    transportProtocol: "tcp-multi",
    priority,
    savedPriority,
    sendBps,
    receiveBps: 100_000,
    estimatedUploadBps: 20_000_000,
    latencyMs: 60,
    jitterMs: 2,
    lossSendRatio: 0,
    lossReceiveRatio: 0,
    inFlightBytes: 20_000,
    inFlightWindowBytes: 100_000,
    uploadCongested: false,
    poorConnection: false,
    slowConnection: false
  };
}

describe("router heartbeat manager", () => {
  it("accepts a healthy fail-closed bonded heartbeat and calculates headroom", () => {
    const manager = new RouterHeartbeatManager();
    expect(manager.accept(heartbeat(), now)).toMatchObject({
      state: "HEALTHY",
      speedify: { uploadHeadroomBps: 16_000_000 },
      routing: { cameraFlowCount: 8 },
      cameraWifi: { associatedClientCount: 8, minimumSignalDbm: -68 },
      host: { cpuUsageRatio: 0.42 },
      uplinks: [{ id: "eth0", transportProtocol: "tcp-multi" }, { id: "rmnet_mhi0", transportProtocol: "tcp-multi" }]
    });
  });

  it("fails critical when a camera route can bypass the bonded tunnel", () => {
    const manager = new RouterHeartbeatManager();
    const input = heartbeat();
    input.routing.srtDevice = "eth0";
    expect(manager.accept(input, now).state).toBe("CRITICAL");
  });

  it("marks congestion degraded and stale telemetry unknown", () => {
    const manager = new RouterHeartbeatManager();
    const input = heartbeat();
    input.speedify.uploadCongested = true;
    manager.accept(input, now);
    expect(manager.current(now.getTime()).state).toBe("DEGRADED");
    expect(manager.current(now.getTime() + 20_001).state).toBe("UNKNOWN");
  });

  it("marks measured CPU saturation degraded even when Speedify does not", () => {
    const input = heartbeat();
    input.host.cpuUsageRatio = 0.95;
    expect(new RouterHeartbeatManager().accept(input, now).state).toBe("DEGRADED");
  });

  it("surfaces saved adapter-policy drift separately from the working role", () => {
    const warning = heartbeat();
    warning.speedify.automaticAdapterCount = 1;
    warning.uplinks[1]!.savedPriority = "secondary";
    expect(new RouterHeartbeatManager().accept(warning, now).state).toBe("DEGRADED");

    const disabled = heartbeat();
    disabled.speedify.automaticAdapterCount = 1;
    disabled.uplinks[1]!.savedPriority = "never";
    expect(new RouterHeartbeatManager().accept(disabled, now).state).toBe("CRITICAL");
  });

  it("rejects replayed sequences, stale samples, and unbounded payload fields", () => {
    const manager = new RouterHeartbeatManager();
    manager.accept(heartbeat(), now);
    expect(() => manager.accept(heartbeat(), now)).toThrow(/replayed/i);
    expect(() => new RouterHeartbeatManager().accept(heartbeat({ sampledAt: "2026-07-27T21:59:00.000Z" }), now)).toThrow(/replay window/i);
    expect(() => new RouterHeartbeatManager().accept(heartbeat({ secret: "must-not-cross-boundary" }), now)).toThrow();
  });
});
