import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { overlayBoundaryRetryState, overlayConnectionStale, overlayFailureHealth } from "../lib/overlayFailureRecovery";

describe("overlay failure recovery", () => {
  it("retries the overlay subtree once and then fails transparent", () => {
    const retry = overlayBoundaryRetryState({ failed: true, retryCount: 0 });

    expect(retry).toEqual({ failed: false, retryCount: 1 });
    expect(overlayBoundaryRetryState({ ...retry!, failed: true })).toBeNull();
    expect(overlayBoundaryRetryState({ failed: false, retryCount: 0 })).toBeNull();
  });

  it("never navigates or reloads the Program page after an overlay exception", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/overlay/court/[courtNumber]/OverlayClient.tsx"),
      "utf8"
    );
    const boundary = source.slice(
      source.indexOf("class OverlayErrorBoundary"),
      source.indexOf("type OverlayClientProps")
    );

    expect(boundary).not.toContain("window.location.reload");
    expect(boundary).not.toContain("window.location.replace");
    expect(boundary).toContain("this.props.onFailure()");
    expect(boundary).toContain("overlayBoundaryRetryState(state)");
  });

  it("reports the failed score render without implying a media failure", () => {
    expect(overlayFailureHealth()).toEqual({
      loaded: false,
      connected: false,
      stale: true,
      frozen: true,
      matchId: null,
      phase: "ERROR",
      sourceSignature: null,
      renderedSignature: null,
      domMismatchReason: null,
      stateUpdatedAt: null
    });
  });

  it("marks authoritative repair loss stale without clearing the last-good overlay", () => {
    expect(overlayConnectionStale(false, true)).toBe(false);
    expect(overlayConnectionStale(true, true)).toBe(true);
    expect(overlayConnectionStale(false, false)).toBe(true);

    const source = readFileSync(
      join(process.cwd(), "src/app/overlay/court/[courtNumber]/OverlayClient.tsx"),
      "utf8"
    );
    const fetchAuthoritativeState = source.slice(
      source.indexOf("const fetchAuthoritativeState"),
      source.indexOf("useEffect(() => {\n    void fetchAuthoritativeState")
    );
    const failurePath = fetchAuthoritativeState.slice(fetchAuthoritativeState.indexOf("} catch"));
    expect(failurePath).toContain("setConnected(false)");
    expect(failurePath).not.toContain("setState(");
    expect(failurePath).not.toContain("lastApplied.current = null");
  });
});
