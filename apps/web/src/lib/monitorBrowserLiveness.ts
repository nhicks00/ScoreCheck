// Keep operator liveness aligned with the monitoring service's Prometheus contract.
export const MONITOR_BROWSER_HEARTBEAT_FRESH_MS = 10_000;

export type MonitorBrowserLiveness = {
  state: "LIVE" | "STATUS_MISSING" | "CLOSED" | "NEVER_SEEN";
  heartbeatAgeMs: number | null;
};

export function deriveMonitorBrowserLiveness(input: {
  receivedAt: string | null | undefined;
  programReaderCount: number | null | undefined;
  nowMs: number;
}): MonitorBrowserLiveness {
  const heartbeatAgeMs = heartbeatAge(input.receivedAt, input.nowMs);
  const hasReader = (input.programReaderCount ?? 0) > 0;
  const heartbeatFresh = heartbeatAgeMs != null && heartbeatAgeMs <= MONITOR_BROWSER_HEARTBEAT_FRESH_MS;

  if (hasReader && heartbeatFresh) return { state: "LIVE", heartbeatAgeMs };
  if (hasReader) return { state: "STATUS_MISSING", heartbeatAgeMs };
  if (heartbeatAgeMs != null) return { state: "CLOSED", heartbeatAgeMs };
  return { state: "NEVER_SEEN", heartbeatAgeMs: null };
}

function heartbeatAge(receivedAt: string | null | undefined, nowMs: number): number | null {
  if (!receivedAt || !Number.isFinite(nowMs)) return null;
  const receivedAtMs = Date.parse(receivedAt);
  if (!Number.isFinite(receivedAtMs)) return null;
  return Math.max(0, nowMs - receivedAtMs);
}
