import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedIntegerEnv, getEnv } from "../lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("community media environment bounds", () => {
  it("preserves an explicit zero capacity as the fail-closed state", () => {
    vi.stubEnv("COMMUNITY_MEDIA_MAX_PER_COURT", "0");
    vi.stubEnv("COMMUNITY_MEDIA_MAX_TOTAL", "0");

    expect(getEnv()).toMatchObject({
      communityMediaMaxPerCourt: 0,
      communityMediaMaxTotal: 0
    });
  });

  it.each([
    ["1.5", 0, 0, 5_000],
    ["5001", 0, 0, 5_000],
    ["-1", 0, 0, 20_000],
    ["601", 120, 30, 600]
  ])("uses the safe fallback for malformed or out-of-range input %s", (raw, fallback, minimum, maximum) => {
    vi.stubEnv("BOUNDED_INTEGER_TEST", raw);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(boundedIntegerEnv("BOUNDED_INTEGER_TEST", fallback, minimum, maximum)).toBe(fallback);
  });

  it("accepts only integer session leases within 30 through 600 seconds", () => {
    vi.stubEnv("COMMUNITY_MEDIA_SESSION_SECONDS", "30");
    expect(getEnv().communityMediaSessionSeconds).toBe(30);
    vi.stubEnv("COMMUNITY_MEDIA_SESSION_SECONDS", "600");
    expect(getEnv().communityMediaSessionSeconds).toBe(600);
  });
});
