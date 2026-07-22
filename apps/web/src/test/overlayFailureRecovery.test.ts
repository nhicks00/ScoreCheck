import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { overlayBoundaryRetryState } from "../lib/overlayFailureRecovery";

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
    expect(boundary).toContain("overlayBoundaryRetryState(state)");
  });
});
