import { describe, expect, it } from "vitest";
import { generateScorerToken, hashSecret, validateToken } from "../lib/security";

describe("scorer token security", () => {
  it("validates a generated token only against its hash", () => {
    const token = generateScorerToken();
    const hash = hashSecret(token);
    expect(token).not.toEqual(hash);
    expect(validateToken(token, hash)).toBe(true);
    expect(validateToken(`${token}x`, hash)).toBe(false);
  });
});
