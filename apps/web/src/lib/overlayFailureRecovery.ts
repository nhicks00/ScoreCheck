export type OverlayBoundaryState = { failed: boolean; retryCount: number };

export function overlayBoundaryRetryState(state: OverlayBoundaryState): OverlayBoundaryState | null {
  if (!state.failed || state.retryCount >= 1) return null;
  return { failed: false, retryCount: state.retryCount + 1 };
}
