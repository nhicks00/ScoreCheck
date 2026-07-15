export type OverlayInvalidationScheduler = {
  invalidate: () => void;
  dispose: () => void;
};

/**
 * Coalesces untrusted realtime invalidations into a trailing, authoritative
 * HTTP refresh. An invalidation received during a fetch schedules one more
 * refresh after that fetch settles so the latest durable state is observed.
 */
export function createOverlayInvalidationScheduler(
  fetchAuthoritativeState: () => Promise<void>,
  debounceMs = 75
): OverlayInvalidationScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let rerun = false;
  let disposed = false;

  function schedule() {
    if (disposed) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  }

  async function run() {
    if (disposed) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    inFlight = true;
    try {
      await fetchAuthoritativeState();
    } finally {
      inFlight = false;
      if (rerun && !disposed) {
        rerun = false;
        schedule();
      }
    }
  }

  return {
    invalidate: schedule,
    dispose() {
      disposed = true;
      rerun = false;
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
