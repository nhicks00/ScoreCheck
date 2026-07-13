import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("../lib/supabase", () => ({
  supabaseAdmin: () => ({
    rpc: harness.rpc
  })
}));

import {
  recordSourceHeartbeat,
  resetSourceHeartbeatCacheForTests,
  shouldPersistSourceHeartbeat,
  sourceHeartbeatSignature
} from "../lib/sourceHeartbeat";

const success = {
  courtId: "court-1",
  eventId: "event-1",
  matchId: "match-1",
  sourceAvailable: true,
  successful: true,
  observedAt: "2026-07-13T15:00:00.000Z"
};

describe("score source heartbeat cadence", () => {
  beforeEach(() => {
    harness.rpc.mockReset();
    harness.rpc.mockResolvedValue({ error: null });
    resetSourceHeartbeatCacheForTests();
  });

  it("writes the first observation and suppresses identical observations inside ten seconds", () => {
    expect(shouldPersistSourceHeartbeat(undefined, success)).toBe(true);
    expect(shouldPersistSourceHeartbeat({
      signature: sourceHeartbeatSignature(success),
      persistedAtMs: Date.parse(success.observedAt)
    }, {
      ...success,
      observedAt: "2026-07-13T15:00:09.999Z"
    })).toBe(false);
  });

  it("refreshes an unchanged healthy source at the bounded cadence", () => {
    expect(shouldPersistSourceHeartbeat({
      signature: sourceHeartbeatSignature(success),
      persistedAtMs: Date.parse(success.observedAt)
    }, {
      ...success,
      observedAt: "2026-07-13T15:00:10.000Z"
    })).toBe(true);
  });

  it("writes source availability, error, and match transitions immediately", () => {
    const previous = {
      signature: sourceHeartbeatSignature(success),
      persistedAtMs: Date.parse(success.observedAt)
    };
    expect(shouldPersistSourceHeartbeat(previous, {
      ...success,
      sourceAvailable: false,
      observedAt: "2026-07-13T15:00:01.000Z"
    })).toBe(true);
    expect(shouldPersistSourceHeartbeat(previous, {
      ...success,
      sourceAvailable: false,
      successful: false,
      errorMessage: "Match API HTTP 503",
      observedAt: "2026-07-13T15:00:01.000Z"
    })).toBe(true);
    expect(shouldPersistSourceHeartbeat(previous, {
      ...success,
      matchId: "match-2",
      observedAt: "2026-07-13T15:00:01.000Z"
    })).toBe(true);
  });

  it("persists only the first and cadence-due identical observation", async () => {
    await recordSourceHeartbeat(success);
    await recordSourceHeartbeat({ ...success, observedAt: "2026-07-13T15:00:09.999Z" });
    await recordSourceHeartbeat({ ...success, observedAt: "2026-07-13T15:00:10.000Z" });

    expect(harness.rpc).toHaveBeenCalledTimes(2);
    expect(harness.rpc).toHaveBeenLastCalledWith("record_score_source_heartbeat", expect.objectContaining({
      p_court_id: "court-1",
      p_source_available: true,
      p_successful: true,
      p_observed_at: "2026-07-13T15:00:10.000Z",
      p_error_message: null
    }));
  });

  it("records a failure immediately without supplying a replacement success timestamp", async () => {
    await recordSourceHeartbeat(success);
    await recordSourceHeartbeat({
      ...success,
      sourceAvailable: false,
      successful: false,
      errorMessage: "Match API HTTP 503",
      observedAt: "2026-07-13T15:00:01.000Z"
    });

    expect(harness.rpc).toHaveBeenLastCalledWith("record_score_source_heartbeat", expect.objectContaining({
      p_successful: false,
      p_observed_at: "2026-07-13T15:00:01.000Z",
      p_error_message: "Match API HTTP 503"
    }));
  });
});
