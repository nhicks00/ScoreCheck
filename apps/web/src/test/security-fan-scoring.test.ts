import { describe, expect, it } from "vitest";
import { generateSessionToken, hashToken, safeDisplayName, validateToken } from "../lib/security";

describe("fan scoring security helpers", () => {
  it("hashes and validates session tokens", () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThan(30);
    expect(validateToken(token, hashToken(token))).toBe(true);
  });

  it("sanitizes display names", () => {
    expect(safeDisplayName("  Mike\nAva's Dad  ")).toBe("Mike Ava's Dad");
    expect(safeDisplayName("   ")).toBe("Scorekeeper");
  });
});
