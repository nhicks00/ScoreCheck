import { describe, expect, it } from "vitest";
import { extractCourtNumberFromCode, normalizeVerificationCode } from "../lib/youtube";

describe("youtube verification code parsing", () => {
  it("normalizes clear claim codes", () => {
    expect(normalizeVerificationCode(" c4-728 ")).toBe("C4-728");
    expect(normalizeVerificationCode("C4 728")).toBe("C4-728");
  });

  it("ignores long suspicious messages", () => {
    expect(normalizeVerificationCode("please use this C4-728 code for something else entirely")).toBeNull();
  });

  it("extracts court numbers", () => {
    expect(extractCourtNumberFromCode("C8-111")).toBe(8);
  });
});
