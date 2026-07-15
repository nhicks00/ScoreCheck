import { describe, expect, it } from "vitest";
import {
  communityDeviceCookieOptions,
  generateSessionToken,
  hashToken,
  isValidDeviceId,
  safeDisplayName,
  validateToken
} from "../lib/security";

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

  it("accepts only bounded base64url device IDs and keeps them private", () => {
    expect(isValidDeviceId("abcdefghijklmnop")).toBe(true);
    expect(isValidDeviceId("abcDEF0123_-xyzXYZ")).toBe(true);
    expect(isValidDeviceId("too-short")).toBe(false);
    expect(isValidDeviceId("contains spaces and punctuation!")).toBe(false);
    expect(isValidDeviceId("a".repeat(129))).toBe(false);
    expect(communityDeviceCookieOptions).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 365 * 24 * 60 * 60
    });
  });
});
