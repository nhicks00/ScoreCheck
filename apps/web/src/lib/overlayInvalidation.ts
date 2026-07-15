export type OverlayInvalidationScheduler = {
  invalidate: () => void;
  dispose: () => void;
};

/**
 * Treats untrusted realtime broadcasts only as rate-limited invalidation
 * hints. The first hint refreshes immediately. Further hints are coalesced
 * without moving the deadline, so a sustained forged stream can neither
 * starve the authoritative HTTP refresh nor trigger more than one refresh per
 * interval. A hint received during a fetch guarantees one trailing refresh
 * after both the fetch and rate-limit window have settled.
 */
export function createOverlayInvalidationScheduler(
  fetchAuthoritativeState: () => Promise<void>,
  minRefreshIntervalMs = 1_000
): OverlayInvalidationScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let pending = false;
  let disposed = false;

  const intervalMs = Number.isFinite(minRefreshIntervalMs)
    ? Math.max(1, Math.floor(minRefreshIntervalMs))
    : 1_000;

  async function run() {
    if (disposed || inFlight || timer || !pending) return;
    pending = false;
    inFlight = true;

    // Open the next rate window from the start of this refresh. This timer is
    // intentionally never reset by invalidations.
    timer = setTimeout(() => {
      timer = null;
      drain();
    }, intervalMs);

    try {
      await fetchAuthoritativeState();
    } catch {
      // Invalidations are advisory and expose no error channel. Callers own
      // connectivity feedback; a later hint or durable poll remains the
      // repair path after a failed refresh.
    } finally {
      inFlight = false;
      drain();
    }
  }

  function drain() {
    if (disposed || inFlight || timer || !pending) return;
    void run();
  }

  function invalidate() {
    if (disposed) return;
    pending = true;
    drain();
  }

  return {
    invalidate,
    dispose() {
      disposed = true;
      pending = false;
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

/**
 * Supabase broadcast bodies are unauthenticated hints. Deliberately erase the
 * callback argument so no caller can accidentally pass a forged payload into
 * overlay state application.
 */
export function invalidationOnlyBroadcastHandler(invalidate: () => void) {
  return (_untrustedBroadcast: unknown) => invalidate();
}
