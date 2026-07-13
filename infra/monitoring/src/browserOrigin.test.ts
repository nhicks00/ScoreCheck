import { describe, expect, it } from "vitest";
import { decideBrowserOrigin } from "./browserOrigin.js";

const allowedOrigins = ["https://score.beachvolleyballmedia.com"];

describe("decideBrowserOrigin", () => {
  it("accepts a missing origin only for authenticated browser writes", () => {
    expect(decideBrowserOrigin(undefined, allowedOrigins, { allowMissing: true })).toEqual({
      allowed: true,
      corsOrigin: null
    });
    expect(decideBrowserOrigin(undefined, allowedOrigins, { allowMissing: false })).toEqual({
      allowed: false,
      corsOrigin: null
    });
  });

  it("normalizes and accepts an explicitly allowed origin", () => {
    expect(decideBrowserOrigin("https://score.beachvolleyballmedia.com/path", allowedOrigins, { allowMissing: false })).toEqual({
      allowed: true,
      corsOrigin: "https://score.beachvolleyballmedia.com"
    });
  });

  it("rejects explicit unapproved or malformed origins", () => {
    expect(decideBrowserOrigin("https://example.com", allowedOrigins, { allowMissing: true }).allowed).toBe(false);
    expect(decideBrowserOrigin("not a url", allowedOrigins, { allowMissing: true }).allowed).toBe(false);
  });
});
