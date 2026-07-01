import { describe, expect, it } from "vitest";
import { checkWorkerSecret } from "../lib/workerAuth";

describe("worker auth", () => {
  it("fails closed when the worker secret is not configured", () => {
    expect(checkWorkerSecret("", "anything")).toEqual({
      ok: false,
      message: "Worker secret is not configured",
      status: 503
    });
  });

  it("rejects missing or incorrect worker secrets", () => {
    expect(checkWorkerSecret("expected", null)).toEqual({
      ok: false,
      message: "Unauthorized",
      status: 401
    });
    expect(checkWorkerSecret("expected", "wrong")).toEqual({
      ok: false,
      message: "Unauthorized",
      status: 401
    });
  });

  it("accepts the configured worker secret", () => {
    expect(checkWorkerSecret("expected", "expected")).toEqual({ ok: true });
  });
});
