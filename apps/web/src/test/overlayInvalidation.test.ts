import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOverlayInvalidationScheduler,
  invalidationOnlyBroadcastHandler
} from "../lib/overlayInvalidation";

afterEach(() => {
  vi.useRealTimers();
});

describe("overlay realtime invalidation", () => {
  it("never forwards a forged broadcast payload and applies only an authoritative fetch", async () => {
    vi.useFakeTimers();
    const fetchAuthoritativeState = vi.fn(async () => undefined);
    const scheduler = createOverlayInvalidationScheduler(fetchAuthoritativeState, 50);
    const onBroadcast = invalidationOnlyBroadcastHandler(scheduler.invalidate);
    const forged = {
      match: { id: "attacker-match", teamA: { name: "FORGED" } },
      score: { teamAScore: 99, teamBScore: 0 }
    };

    onBroadcast({ payload: forged });
    expect(fetchAuthoritativeState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);

    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(1);
    expect(fetchAuthoritativeState).toHaveBeenCalledWith();
    scheduler.dispose();
  });

  it("debounces bursts and coalesces an invalidation received during a fetch", async () => {
    vi.useFakeTimers();
    let releaseFirst: () => void = () => undefined;
    let fetchCount = 0;
    const fetchAuthoritativeState = vi.fn(() => {
      fetchCount += 1;
      if (fetchCount > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const scheduler = createOverlayInvalidationScheduler(fetchAuthoritativeState, 25);

    scheduler.invalidate();
    scheduler.invalidate();
    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(25);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(1);

    scheduler.invalidate();
    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
});
