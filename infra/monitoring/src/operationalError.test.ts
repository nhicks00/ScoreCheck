import { describe, expect, it } from "vitest";
import { operationalErrorCode } from "./operationalError.js";

describe("operational error logging", () => {
  it("preserves bounded provider error codes without logging messages", () => {
    expect(operationalErrorCode({ code: "23503", message: "contains private payload" })).toBe("23503");
  });

  it("falls back to an HTTP status or safe error name", () => {
    expect(operationalErrorCode({ status: 503 })).toBe("HTTP_503");
    expect(operationalErrorCode(new TypeError("secret"))).toBe("TYPEERROR");
    expect(operationalErrorCode("secret")).toBe("UNKNOWN");
  });
});
