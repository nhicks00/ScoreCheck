import { z } from "zod";
import type { HealthState, RouterMonitorSnapshot } from "./contracts.js";

const isoDate = z.string().datetime({ offset: true });
const safeId = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:-]+$/);
const ratio = z.number().min(0).max(1).nullable();
const boundedNumber = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);

const uplinkSchema = z.object({
  id: safeId,
  isp: z.string().trim().min(1).max(120).nullable(),
  type: z.enum(["ethernet", "wifi", "cellular", "other"]),
  connected: z.boolean(),
  transportProtocol: z.enum(["udp", "tcp", "tcp-multi", "https", "unknown"]),
  priority: z.enum(["always", "secondary", "backup", "never", "unknown"]),
  savedPriority: z.enum(["automatic", "always", "secondary", "backup", "never", "unknown"]),
  sendBps: boundedNumber,
  receiveBps: boundedNumber,
  estimatedUploadBps: boundedNumber.nullable(),
  latencyMs: z.number().nonnegative().max(60_000).nullable(),
  jitterMs: z.number().nonnegative().max(60_000).nullable(),
  lossSendRatio: ratio,
  lossReceiveRatio: ratio,
  inFlightBytes: boundedNumber.nullable(),
  inFlightWindowBytes: boundedNumber.nullable(),
  uploadCongested: z.boolean(),
  poorConnection: z.boolean(),
  slowConnection: z.boolean()
}).strict();

export const routerHeartbeatSchema = z.object({
  version: z.literal(4),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sampledAt: isoDate,
  speedify: z.object({
    state: z.enum(["CONNECTED", "LOGGED_IN", "DISCONNECTED", "UNKNOWN"]),
    softwareVersion: z.string().regex(/^\d+\.\d+\.\d+-\d+$/),
    bondingMode: z.enum(["speed", "streaming", "redundant", "unknown"]),
    transportMode: z.enum(["udp", "tcp", "tcp-multi", "https", "auto", "unknown"]),
    adapterCount: z.number().int().nonnegative().max(16),
    automaticAdapterCount: z.number().int().nonnegative().max(16),
    sendBps: boundedNumber,
    receiveBps: boundedNumber,
    estimatedUploadBps: boundedNumber.nullable(),
    latencyMs: z.number().nonnegative().max(60_000).nullable(),
    jitterMs: z.number().nonnegative().max(60_000).nullable(),
    lossSendRatio: ratio,
    lossReceiveRatio: ratio,
    uploadCongested: z.boolean(),
    badCpu: z.boolean(),
    badLatency: z.boolean(),
    badLoss: z.boolean(),
    badMemory: z.boolean(),
    readQueuePackets: z.number().int().nonnegative().nullable(),
    failoverCount: z.number().int().nonnegative().nullable()
  }).strict(),
  routing: z.object({
    srtDevice: safeId,
    rtmpDevice: safeId,
    primaryRuleCount: z.number().int().nonnegative().max(32),
    guardRuleCount: z.number().int().nonnegative().max(32),
    killSwitchActive: z.boolean(),
    cameraFlowCount: z.number().int().nonnegative().max(64)
  }).strict(),
  cameraWifi: z.object({
    interface: safeId,
    associatedClientCount: z.number().int().nonnegative().max(64).nullable(),
    minimumSignalDbm: z.number().int().min(-150).max(0).nullable()
  }).strict(),
  host: z.object({
    load1: z.number().nonnegative().max(10_000),
    cpuUsageRatio: ratio,
    memoryAvailableBytes: boundedNumber,
    speedifyRssBytes: boundedNumber,
    streamingStatsProcessCount: z.number().int().nonnegative().max(64)
  }).strict(),
  uplinks: z.array(uplinkSchema).max(8)
}).strict();

export type RouterHeartbeat = z.infer<typeof routerHeartbeatSchema>;

export class RouterHeartbeatManager {
  private latestHeartbeat: RouterHeartbeat | null = null;
  private receivedAt: string | null = null;
  private sequences = new Map<string, number>();

  accept(input: unknown, now = new Date()): RouterMonitorSnapshot {
    const heartbeat = routerHeartbeatSchema.parse(input);
    const sampleMs = Date.parse(heartbeat.sampledAt);
    if (sampleMs > now.getTime() + 5_000 || now.getTime() - sampleMs > 30_000) {
      throw new Error("Router heartbeat is outside the accepted replay window.");
    }
    const previous = this.sequences.get(heartbeat.sessionId) ?? 0;
    if (heartbeat.sequence <= previous) throw new Error("Router heartbeat sequence was replayed.");
    this.sequences.set(heartbeat.sessionId, heartbeat.sequence);
    this.latestHeartbeat = heartbeat;
    this.receivedAt = now.toISOString();
    return this.current(now.getTime());
  }

  current(nowMs = Date.now()): RouterMonitorSnapshot {
    if (!this.latestHeartbeat || !this.receivedAt) return emptyRouterSnapshot();
    const ageMs = Math.max(0, nowMs - Date.parse(this.receivedAt));
    const heartbeat = this.latestHeartbeat;
    const estimatedUploadBps = heartbeat.speedify.estimatedUploadBps;
    const uploadHeadroomBps = estimatedUploadBps == null
      ? null
      : Math.max(0, estimatedUploadBps - heartbeat.speedify.sendBps);
    return {
      state: routerState(heartbeat, ageMs),
      sampledAt: heartbeat.sampledAt,
      receivedAt: this.receivedAt,
      ageMs,
      speedify: { ...heartbeat.speedify, uploadHeadroomBps },
      routing: heartbeat.routing,
      cameraWifi: heartbeat.cameraWifi,
      host: heartbeat.host,
      uplinks: heartbeat.uplinks
    };
  }
}

export function emptyRouterSnapshot(): RouterMonitorSnapshot {
  return {
    state: "UNKNOWN",
    sampledAt: null,
    receivedAt: null,
    ageMs: null,
    speedify: null,
    routing: null,
    cameraWifi: null,
    host: null,
    uplinks: []
  };
}

function routerState(heartbeat: RouterHeartbeat, ageMs: number): HealthState {
  if (ageMs > 20_000) return "UNKNOWN";
  const routing = heartbeat.routing;
  if (heartbeat.speedify.state !== "CONNECTED"
    || routing.srtDevice !== "connectify0"
    || routing.rtmpDevice !== "connectify0"
    || routing.primaryRuleCount !== 2
    || routing.guardRuleCount !== 2
    || !routing.killSwitchActive
    || heartbeat.uplinks.some((uplink) => uplink.savedPriority === "never")) return "CRITICAL";
  const activeUplinks = heartbeat.uplinks.filter((uplink) => uplink.connected && uplink.priority !== "never");
  if (activeUplinks.length < 2
    || heartbeat.speedify.adapterCount === 0
    || heartbeat.speedify.automaticAdapterCount !== heartbeat.speedify.adapterCount
    || heartbeat.speedify.uploadCongested
    || heartbeat.speedify.badCpu
    || heartbeat.speedify.badLatency
    || heartbeat.speedify.badLoss
    || heartbeat.speedify.badMemory
    || heartbeat.host.streamingStatsProcessCount > 0
    || (heartbeat.host.cpuUsageRatio != null && heartbeat.host.cpuUsageRatio >= 0.9)
    || heartbeat.host.memoryAvailableBytes < 64 * 1024 * 1024
    || activeUplinks.some((uplink) => uplink.poorConnection || uplink.slowConnection)) return "DEGRADED";
  return "HEALTHY";
}
