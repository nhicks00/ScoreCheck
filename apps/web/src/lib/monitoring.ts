import { z } from "zod";
import { supabaseAdmin } from "./supabase";
import type { MonitorCourtPipelineRange, MonitorSilence, MonitorSnapshot, MonitorSnapshotEnvelope, MonitorStageName } from "./monitoringTypes";

const envelopeSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime({ offset: true }),
  collector: z.object({ state: z.string(), agentsExpected: z.number(), agentsFresh: z.number() }).passthrough(),
  controlPlane: z.object({ state: z.string() }).passthrough(),
  notifications: z.object({ state: z.string() }).passthrough(),
  courts: z.array(z.object({ courtNumber: z.number().int().min(1).max(8), overallState: z.string(), stages: z.array(z.unknown()) }).passthrough()).max(8),
  agents: z.array(z.object({ agentId: z.string(), state: z.string() }).passthrough()).max(32),
  incidents: z.array(z.object({ id: z.string().uuid(), status: z.string(), severity: z.string() }).passthrough()).max(200),
  silences: z.array(z.object({ id: z.string().uuid(), expiresAt: z.string().datetime({ offset: true }) }).passthrough()).max(100)
}).passthrough();

export function monitorConfigured(): boolean {
  return Boolean(monitorConnection());
}

export async function loadMonitorSnapshotWithFallback(): Promise<MonitorSnapshotEnvelope> {
  const fetchedAt = new Date().toISOString();
  try {
    return { snapshot: await loadLiveMonitorSnapshot(), source: "live", fetchedAt, monitorError: null };
  } catch {
    const db = supabaseAdmin();
    const { data, error } = await db.from("monitoring_checkpoints").select("payload").eq("scope", "global").maybeSingle();
    if (error || !data?.payload) throw new Error("Monitoring service and durable checkpoint are unavailable.");
    return {
      snapshot: parseMonitorSnapshot(data.payload),
      source: "checkpoint",
      fetchedAt,
      monitorError: "Live monitoring service unavailable; showing the last durable checkpoint."
    };
  }
}

export async function acknowledgeMonitorIncident(id: string, actor: string, reason: string): Promise<unknown> {
  const connection = requiredMonitorConnection();
  const response = await fetch(`${connection.baseUrl}/v1/incidents/${encodeURIComponent(id)}/acknowledge`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify({ actor, reason }),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 404 ? "Incident is no longer active." : "Monitor acknowledgement failed.");
  return payload;
}

export async function createMonitorSilence(input: {
  eventId: string | null;
  courtNumber: number | null;
  stage: MonitorStageName | null;
  issueCode: string | null;
  reason: string;
  actor: string;
  expiresAt: string;
}): Promise<{ silence: MonitorSilence }> {
  const connection = requiredMonitorConnection();
  const response = await fetch(`${connection.baseUrl}/v1/silences`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000)
  });
  const payload = await response.json().catch(() => null) as { silence?: MonitorSilence; error?: string } | null;
  if (!response.ok || !payload?.silence) throw new Error(payload?.error ?? "Monitor silence failed.");
  return { silence: payload.silence };
}

export async function loadMonitorThumbnail(courtNumber: number): Promise<{ body: ArrayBuffer; contentType: string; sampledAt: string | null } | null> {
  const connection = requiredMonitorConnection();
  const response = await fetch(`${connection.baseUrl}/v1/courts/${courtNumber}/thumbnail`, {
    headers: { authorization: `Bearer ${connection.token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Thumbnail fetch failed.");
  return {
    body: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "image/jpeg",
    sampledAt: response.headers.get("x-scorecheck-sampled-at")
  };
}

export async function loadMonitorCourtPipelineRange(windowSec = 300, stepSec = 15): Promise<MonitorCourtPipelineRange> {
  const connection = requiredMonitorConnection();
  const url = new URL("/v1/range/court-pipeline", `${connection.baseUrl}/`);
  url.searchParams.set("windowSec", String(windowSec));
  url.searchParams.set("stepSec", String(stepSec));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${connection.token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error("Monitoring history fetch failed.");
  return response.json() as Promise<MonitorCourtPipelineRange>;
}

async function loadLiveMonitorSnapshot(): Promise<MonitorSnapshot> {
  const connection = requiredMonitorConnection();
  const response = await fetch(`${connection.baseUrl}/v1/snapshot`, {
    headers: { authorization: `Bearer ${connection.token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000)
  });
  if (!response.ok) throw new Error(`Monitoring API returned ${response.status}.`);
  return parseMonitorSnapshot(await response.json());
}

function parseMonitorSnapshot(input: unknown): MonitorSnapshot {
  return envelopeSnapshotSchema.parse(input) as unknown as MonitorSnapshot;
}

function requiredMonitorConnection(): { baseUrl: string; token: string } {
  const connection = monitorConnection();
  if (!connection) throw new Error("Monitoring API is not configured.");
  return connection;
}

function monitorConnection(): { baseUrl: string; token: string } | null {
  const rawUrl = process.env.MONITOR_PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
  const token = process.env.MONITOR_API_TOKEN?.trim() ?? "";
  if (!rawUrl || token.length < 24) return null;
  try {
    const parsed = new URL(rawUrl);
    const localHttp = parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (parsed.protocol !== "https:" && !localHttp) return null;
    return { baseUrl: `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`, token };
  } catch {
    return null;
  }
}
