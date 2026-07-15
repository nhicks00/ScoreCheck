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
    const scheduler = createOverlayInvalidationScheduler(fetchAuthoritativeState, 1_000);
    const onBroadcast = invalidationOnlyBroadcastHandler(scheduler.invalidate);
    const forged = {
      match: { id: "attacker-match", teamA: { name: "FORGED" } },
      score: { teamAScore: 99, teamBScore: 0 }
    };

    onBroadcast({ payload: forged });
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(1);
    expect(fetchAuthoritativeState).toHaveBeenCalledWith();
    scheduler.dispose();
  });

  it("runs on the leading edge and rate-bounds a sustained invalidation flood", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const startedAt: number[] = [];
    const fetchAuthoritativeState = vi.fn(async () => {
      startedAt.push(Date.now());
    });
    const scheduler = createOverlayInvalidationScheduler(fetchAuthoritativeState);

    scheduler.invalidate();
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(1);

    const flood = setInterval(scheduler.invalidate, 50);
    await vi.advanceTimersByTimeAsync(3_500);
    clearInterval(flood);

    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(4);
    expect(startedAt.map((started, index) => index === 0 ? 0 : started - startedAt[index - 1]!))
      .toEqual([0, 1_000, 1_000, 1_000]);

    // The last invalidation during the flood is not lost, and repeated hints
    // never reset its deadline. Exactly one bounded trailing refresh runs.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(5);
    scheduler.dispose();
  });

  it("coalesces invalidations during a slow fetch into one trailing refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    let releaseFirst: () => void = () => undefined;
    let fetchCount = 0;
    const fetchAuthoritativeState = vi.fn(() => {
      fetchCount += 1;
      if (fetchCount > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const scheduler = createOverlayInvalidationScheduler(fetchAuthoritativeState);

    scheduler.invalidate();
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    scheduler.invalidate();
    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(2_750);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(1);

    // Once the slow fetch settles, the pending refresh starts immediately
    // because the one-second rate-limit window has already elapsed.
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("keeps the bounded trailing refresh after an authoritative fetch rejects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    const fetchAuthoritativeState = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const scheduler = createOverlayInvalidationScheduler(fetchAuthoritativeState);

    scheduler.invalidate();
    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchAuthoritativeState).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
});
