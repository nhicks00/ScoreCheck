export type OverlayBoundaryState = { failed: boolean; retryCount: number };

export function overlayConnectionStale(persistedStale: boolean, connected: boolean): boolean {
  return persistedStale || !connected;
}

export function overlayBoundaryRetryState(state: OverlayBoundaryState): OverlayBoundaryState | null {
  if (!state.failed || state.retryCount >= 1) return null;
  return { failed: false, retryCount: state.retryCount + 1 };
}

export function overlayFailureHealth() {
  return {
    loaded: false,
    connected: false,
    stale: true,
    frozen: true,
    matchId: null,
    phase: "ERROR" as const,
    sourceSignature: null,
    renderedSignature: null,
    domMismatchReason: null,
    stateUpdatedAt: null
  };
}
