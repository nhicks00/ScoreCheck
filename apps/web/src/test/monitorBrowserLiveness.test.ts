import { describe, expect, it } from "vitest";
import { deriveMonitorBrowserLiveness, MONITOR_BROWSER_HEARTBEAT_FRESH_MS } from "../lib/monitorBrowserLiveness";

const NOW_MS = Date.parse("2026-07-15T01:00:00.000Z");

describe("monitor browser liveness", () => {
  it("requires both a fresh heartbeat and a current program reader", () => {
    expect(deriveMonitorBrowserLiveness({
      receivedAt: new Date(NOW_MS - 5_000).toISOString(),
      programReaderCount: 1,
      nowMs: NOW_MS
    })).toEqual({ state: "LIVE", heartbeatAgeMs: 5_000 });
  });

  it("does not present a recently closed viewer as live", () => {
    expect(deriveMonitorBrowserLiveness({
      receivedAt: new Date(NOW_MS - 5_000).toISOString(),
      programReaderCount: 0,
      nowMs: NOW_MS
    })).toEqual({ state: "CLOSED", heartbeatAgeMs: 5_000 });
  });

  it("surfaces a reader whose browser status has gone stale", () => {
    expect(deriveMonitorBrowserLiveness({
      receivedAt: new Date(NOW_MS - MONITOR_BROWSER_HEARTBEAT_FRESH_MS - 1).toISOString(),
      programReaderCount: 1,
      nowMs: NOW_MS
    })).toEqual({ state: "STATUS_MISSING", heartbeatAgeMs: MONITOR_BROWSER_HEARTBEAT_FRESH_MS + 1 });
  });

  it("distinguishes never observed and invalid heartbeats from closed history", () => {
    expect(deriveMonitorBrowserLiveness({ receivedAt: null, programReaderCount: 0, nowMs: NOW_MS })).toEqual({
      state: "NEVER_SEEN",
      heartbeatAgeMs: null
    });
    expect(deriveMonitorBrowserLiveness({ receivedAt: "invalid", programReaderCount: 0, nowMs: NOW_MS })).toEqual({
      state: "NEVER_SEEN",
      heartbeatAgeMs: null
    });
  });
});
