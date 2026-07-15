import os from "node:os";
import { statfs } from "node:fs/promises";
import type { AgentConfig } from "./config.js";
import { agentSnapshotSchema, MONITORING_CONTRACT_VERSION, type AgentSnapshot, type MediaPathSnapshot } from "./contracts.js";
import { collectDockerServices } from "./docker.js";
import { MediaPathDetailCache, parseMediaPath, parseSrtTransports, type ByteSample, type MediaPathApiRow } from "./media.js";
import { collectFfmpegProgress } from "./ffmpegProgress.js";

type CollectionError = AgentSnapshot["collectionErrors"][number];
type MediaMtxListResponse = { items?: unknown[] };

export class AgentCollector {
  private readonly previousBytes = new Map<string, ByteSample>();
  private readonly mediaPathDetails = new MediaPathDetailCache();

  constructor(private readonly config: AgentConfig) {}

  async collect(): Promise<AgentSnapshot> {
    const startedAt = performance.now();
    const errors = new Set<CollectionError>();
    const sampledAtMs = Date.now();

    const [disk, services, frameErrors, mediaPaths, ffmpegBranches] = await Promise.all([
      collectDisk(this.config.diskPath).catch(() => {
        errors.add("HOST_DISK_UNAVAILABLE");
        return { total: null, free: null };
      }),
      collectDockerServices(this.config.containers, this.config.dockerApiUrl).catch(() => {
        errors.add("DOCKER_UNAVAILABLE");
        return [];
      }),
      this.collectFrameErrors(errors),
      this.collectMediaPaths(errors, sampledAtMs),
      collectFfmpegProgress(this.config.ffmpegProgressDir, sampledAtMs)
    ]);

    const [livekit, egress, egressHealthUp] = await Promise.all([
      collectLiveKit(this.config.livekitMetricsUrl, errors),
      collectEgress(this.config.egressMetricsUrl, this.config.egressMaxWebRequests, errors),
      probeEndpoint(this.config.egressHealthUrl, "EGRESS_METRICS_UNAVAILABLE", errors, false)
    ]);
    const endpoints = [
      this.config.livekitMetricsUrl ? { service: "livekit" as const, up: livekit !== null } : null,
      this.config.egressMetricsUrl ? { service: "egress-metrics" as const, up: egress !== null } : null,
      egressHealthUp == null ? null : { service: "egress-health" as const, up: egressHealthUp }
    ].filter((value): value is NonNullable<typeof value> => value !== null);

    const pathsWithErrors = mediaPaths.map((path) => ({
      ...path,
      frameErrors: frameErrors.get(path.name) ?? path.frameErrors
    }));

    return agentSnapshotSchema.parse({
      version: MONITORING_CONTRACT_VERSION,
      agentId: this.config.agentId,
      role: this.config.role,
      assignedCourts: this.config.assignedCourts,
      generatedAt: new Date(sampledAtMs).toISOString(),
      collectionDurationMs: performance.now() - startedAt,
      collectionErrors: [...errors],
      host: {
        uptimeSeconds: os.uptime(),
        load1: Math.max(0, os.loadavg()[0] ?? 0),
        memoryTotalBytes: os.totalmem(),
        memoryAvailableBytes: os.freemem(),
        diskTotalBytes: disk.total,
        diskFreeBytes: disk.free
      },
      services,
      mediaPaths: pathsWithErrors,
      ffmpegBranches,
      nativeServices: { endpoints, livekit, egress }
    });
  }

  private async collectMediaPaths(errors: Set<CollectionError>, sampledAtMs: number): Promise<MediaPathSnapshot[]> {
    if (!this.config.mediamtxApiUrl) return [];
    try {
      const response = await fetchJson<MediaMtxListResponse>(`${this.config.mediamtxApiUrl}/v3/paths/list`);
      const enrichment = await this.mediaPathDetails.enrich(response.items ?? [], (name) =>
        fetchJson<MediaPathApiRow>(`${this.config.mediamtxApiUrl}/v3/paths/get/${encodeURIComponent(name)}`), sampledAtMs);
      if (enrichment.failedPaths > 0) errors.add("MEDIAMTX_PATH_DETAILS_UNAVAILABLE");
      let srtTransports = new Map();
      if (enrichment.rows.some(hasSrtSource)) {
        try {
          srtTransports = parseSrtTransports(await fetchJson<unknown>(`${this.config.mediamtxApiUrl}/v3/srtconns/list`));
        } catch {
          errors.add("MEDIAMTX_TRANSPORT_METRICS_UNAVAILABLE");
        }
      }
      const nextSamples = new Map<string, ByteSample>();
      const paths: MediaPathSnapshot[] = [];
      for (const row of enrichment.rows) {
        if (!row || typeof row !== "object") continue;
        const name = "name" in row && typeof row.name === "string" ? row.name : "";
        const parsed = parseMediaPath(row, this.previousBytes.get(name) ?? null, sampledAtMs, 0, srtTransports.get(name) ?? null);
        if (!parsed) continue;
        paths.push(parsed.path);
        nextSamples.set(parsed.path.name, parsed.byteSample);
      }
      this.previousBytes.clear();
      for (const [key, value] of nextSamples) this.previousBytes.set(key, value);
      return paths;
    } catch {
      errors.add("MEDIAMTX_API_UNAVAILABLE");
      return [];
    }
  }

  private async collectFrameErrors(errors: Set<CollectionError>): Promise<Map<string, number>> {
    if (!this.config.mediamtxMetricsUrl) return new Map();
    try {
      const text = await fetchText(this.config.mediamtxMetricsUrl);
      return metricValuesByPath(text, "paths_inbound_frames_in_error");
    } catch {
      errors.add("MEDIAMTX_METRICS_UNAVAILABLE");
      return new Map();
    }
  }
}

function hasSrtSource(input: unknown): boolean {
  return Boolean(input && typeof input === "object"
    && "source" in input && input.source && typeof input.source === "object"
    && "type" in input.source && typeof input.source.type === "string"
    && input.source.type.toLowerCase().includes("srt"));
}

export function metricValuesByPath(text: string, metricName: string): Map<string, number> {
  const values = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${metricName}{`)) continue;
    const labelsEnd = line.indexOf("}");
    if (labelsEnd < 0) continue;
    const labels = line.slice(metricName.length + 1, labelsEnd);
    const name = parsePrometheusLabel(labels, "name") ?? parsePrometheusLabel(labels, "path");
    const value = Number(line.slice(labelsEnd + 1).trim().split(/\s+/)[0]);
    if (name && /^court[1-8]_(raw|preview|program|calibration|monitor)$/.test(name) && Number.isFinite(value) && value >= 0) {
      values.set(name, value);
    }
  }
  return values;
}

function parsePrometheusLabel(labels: string, key: string): string | null {
  const pattern = new RegExp(`(?:^|,)${key}="((?:\\\\.|[^"])*)"(?:,|$)`);
  const match = pattern.exec(labels);
  if (!match?.[1]) return null;
  return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

async function collectDisk(path: string): Promise<{ total: number; free: number }> {
  const stats = await statfs(path);
  return {
    total: Number(stats.blocks) * Number(stats.bsize),
    free: Number(stats.bavail) * Number(stats.bsize)
  };
}

async function probeEndpoint(url: string | null, error: CollectionError, errors: Set<CollectionError>, requireText: boolean): Promise<boolean | null> {
  if (!url) return null;
  try {
    if (requireText) await fetchText(url);
    else {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
      if (!response.ok) throw new Error("Endpoint unavailable.");
    }
    return true;
  } catch {
    errors.add(error);
    return false;
  }
}

async function collectLiveKit(url: string | null, errors: Set<CollectionError>) {
  if (!url) return null;
  try {
    const text = await fetchText(url);
    return {
      roomCount: Math.trunc(metricSum(text, "livekit_room_total")),
      participantCount: Math.trunc(metricSum(text, "livekit_participant_total")),
      packetsOut: metricSum(text, "livekit_node_packet_total", { type: "out" }),
      packetsDropped: metricSum(text, "livekit_node_packet_total", { type: "dropped" })
    };
  } catch {
    errors.add("LIVEKIT_METRICS_UNAVAILABLE");
    return null;
  }
}

async function collectEgress(url: string | null, maximumWebRequests: number, errors: Set<CollectionError>) {
  if (!url) return null;
  try {
    const text = await fetchText(url);
    return parseEgressMetrics(text, maximumWebRequests);
  } catch {
    errors.add("EGRESS_METRICS_UNAVAILABLE");
    return null;
  }
}

export function parseEgressMetrics(text: string, maximumWebRequests: number) {
  const idle = metricValue(text, "livekit_egress_available");
  const nativeCanAccept = metricValue(text, "livekit_egress_can_accept_request");
  if (idle == null || nativeCanAccept == null) throw new Error("Required Egress state metrics are unavailable.");
  const reportedActiveWebRequests = metricValue(text, "livekit_egress_requests", { type: "web" });
  const activeWebRequests = reportedActiveWebRequests ?? (idle > 0 ? 0 : null);
  if (activeWebRequests == null || !Number.isInteger(activeWebRequests) || activeWebRequests < 0) throw new Error("Required Egress state metrics are unavailable.");
  return {
    idle: idle > 0,
    canAcceptRequest: nativeCanAccept > 0 && activeWebRequests < maximumWebRequests,
    nativeCanAcceptRequest: nativeCanAccept > 0,
    activeWebRequests,
    maximumWebRequests,
    cgroupMemoryBytes: metricValue(text, "livekit_egress_cgroup_memory_bytes"),
    cpuLoadRatio: metricValue(text, "livekit_load_ratio", { type: "cpu" }),
    memoryLoadRatio: metricValue(text, "livekit_load_ratio", { type: "memory" })
  };
}

export function metricSum(text: string, metricName: string, requiredLabels: Record<string, string> = {}): number {
  return metricValues(text, metricName, requiredLabels).reduce((sum, value) => sum + value, 0);
}

export function metricValue(text: string, metricName: string, requiredLabels: Record<string, string> = {}): number | null {
  const values = metricValues(text, metricName, requiredLabels);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function metricValues(text: string, metricName: string, requiredLabels: Record<string, string>): number[] {
  const values: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(`${metricName}{`) && !line.startsWith(`${metricName} `)) continue;
    const labelsEnd = line.indexOf("}");
    const valueText = labelsEnd >= 0 ? line.slice(labelsEnd + 1).trim() : line.slice(metricName.length).trim();
    const labels = labelsEnd >= 0 ? line.slice(line.indexOf("{") + 1, labelsEnd) : "";
    if (Object.entries(requiredLabels).some(([key, value]) => parsePrometheusLabel(labels, key) !== value)) continue;
    const value = Number(valueText.split(/\s+/)[0]);
    if (Number.isFinite(value) && value >= 0) values.push(value);
  }
  return values;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
