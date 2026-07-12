import os from "node:os";
import { statfs } from "node:fs/promises";
import type { AgentConfig } from "./config.js";
import { agentSnapshotSchema, MONITORING_CONTRACT_VERSION, type AgentSnapshot, type MediaPathSnapshot } from "./contracts.js";
import { collectDockerServices } from "./docker.js";
import { parseMediaPath, type ByteSample } from "./media.js";

type CollectionError = AgentSnapshot["collectionErrors"][number];
type MediaMtxListResponse = { items?: unknown[] };

export class AgentCollector {
  private readonly previousBytes = new Map<string, ByteSample>();

  constructor(private readonly config: AgentConfig) {}

  async collect(): Promise<AgentSnapshot> {
    const startedAt = performance.now();
    const errors = new Set<CollectionError>();
    const sampledAtMs = Date.now();

    const [disk, services, frameErrors, mediaPaths] = await Promise.all([
      collectDisk(this.config.diskPath).catch(() => {
        errors.add("HOST_DISK_UNAVAILABLE");
        return { total: null, free: null };
      }),
      collectDockerServices(this.config.containers, this.config.dockerApiUrl).catch(() => {
        errors.add("DOCKER_UNAVAILABLE");
        return [];
      }),
      this.collectFrameErrors(errors),
      this.collectMediaPaths(errors, sampledAtMs)
    ]);

    await Promise.all([
      probeMetricsEndpoint(this.config.livekitMetricsUrl, "LIVEKIT_METRICS_UNAVAILABLE", errors),
      probeMetricsEndpoint(this.config.egressMetricsUrl, "EGRESS_METRICS_UNAVAILABLE", errors),
      probeHttpEndpoint(this.config.egressHealthUrl, "EGRESS_METRICS_UNAVAILABLE", errors)
    ]);

    const pathsWithErrors = mediaPaths.map((path) => ({
      ...path,
      frameErrors: frameErrors.get(path.name) ?? path.frameErrors
    }));

    return agentSnapshotSchema.parse({
      version: MONITORING_CONTRACT_VERSION,
      agentId: this.config.agentId,
      role: this.config.role,
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
      mediaPaths: pathsWithErrors
    });
  }

  private async collectMediaPaths(errors: Set<CollectionError>, sampledAtMs: number): Promise<MediaPathSnapshot[]> {
    if (!this.config.mediamtxApiUrl) return [];
    try {
      const response = await fetchJson<MediaMtxListResponse>(`${this.config.mediamtxApiUrl}/v3/paths/list`);
      const nextSamples = new Map<string, ByteSample>();
      const paths: MediaPathSnapshot[] = [];
      for (const row of response.items ?? []) {
        if (!row || typeof row !== "object") continue;
        const name = "name" in row && typeof row.name === "string" ? row.name : "";
        const parsed = parseMediaPath(row, this.previousBytes.get(name) ?? null, sampledAtMs);
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

async function probeMetricsEndpoint(url: string | null, error: CollectionError, errors: Set<CollectionError>) {
  if (!url) return;
  try {
    await fetchText(url);
  } catch {
    errors.add(error);
  }
}

async function probeHttpEndpoint(url: string | null, error: CollectionError, errors: Set<CollectionError>) {
  if (!url) return;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) throw new Error("Endpoint unavailable.");
  } catch {
    errors.add(error);
  }
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
