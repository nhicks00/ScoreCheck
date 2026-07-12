import { describe, expect, it, vi } from "vitest";
import { ExternalDeadMan } from "./deadMan.js";

describe("external dead-man lifecycle", () => {
  it("pings the baseline on its bounded cadence", async () => {
    const send = successfulFetch();
    const deadMan = new ExternalDeadMan(config({ healthchecksBaselinePingUrl: "https://hc-ping.com/baseline" }), send);

    await deadMan.maintain(false, at(0));
    await deadMan.maintain(false, at(599_999));
    await deadMan.maintain(false, at(600_000));

    expect(send).toHaveBeenCalledTimes(2);
    expect(deadMan.health().baseline.mode).toBe("RUNNING");
    expect(deadMan.health().state).toBe("HEALTHY");
  });

  it("pauses the active check while idle and resumes it with a live ping", async () => {
    const send = successfulFetch();
    const deadMan = new ExternalDeadMan(config({
      healthchecksActivePingUrl: "https://hc-ping.com/active",
      healthchecksApiKey: "healthchecks-write-key",
      healthchecksActiveCheckId: "220650f2-ed19-479c-933e-b0df1246ba81"
    }), send);

    await deadMan.maintain(false, at(0));
    await deadMan.maintain(false, at(5_000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toContain("/pause");
    expect(deadMan.health().active.mode).toBe("PAUSED");

    await deadMan.maintain(true, at(10_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe("https://hc-ping.com/active");
    expect(deadMan.health().active.mode).toBe("RUNNING");

    await deadMan.maintain(false, at(15_000));
    expect(send).toHaveBeenCalledTimes(3);
    expect(deadMan.health().active.mode).toBe("PAUSED");
  });

  it("marks failures degraded and retries without request storms", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const deadMan = new ExternalDeadMan(config({ healthchecksBaselinePingUrl: "https://hc-ping.com/baseline" }), send);

    await deadMan.maintain(false, at(0));
    await deadMan.maintain(false, at(29_999));
    await deadMan.maintain(false, at(30_000));

    expect(send).toHaveBeenCalledTimes(2);
    expect(deadMan.health().state).toBe("DEGRADED");
    expect(deadMan.health().baseline.lastFailureAt).not.toBeNull();
  });

  it("is not applicable when no checks are configured", async () => {
    const send = successfulFetch();
    const deadMan = new ExternalDeadMan(config(), send);
    await deadMan.maintain(true, at(0));
    expect(send).not.toHaveBeenCalled();
    expect(deadMan.health().state).toBe("NOT_APPLICABLE");
  });
});

type TestConfig = {
  healthchecksBaselinePingUrl: string | null;
  healthchecksActivePingUrl: string | null;
  healthchecksApiKey: string | null;
  healthchecksActiveCheckId: string | null;
  healthchecksBaselineIntervalMs: number;
  healthchecksActiveIntervalMs: number;
};

function config(patch: Partial<TestConfig> = {}): TestConfig {
  return {
    healthchecksBaselinePingUrl: null as string | null,
    healthchecksActivePingUrl: null as string | null,
    healthchecksApiKey: null as string | null,
    healthchecksActiveCheckId: null as string | null,
    healthchecksBaselineIntervalMs: 600_000,
    healthchecksActiveIntervalMs: 60_000,
    ...patch
  };
}

function successfulFetch() {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
}

function at(offsetMs: number): Date {
  return new Date(Date.parse("2026-07-12T00:00:00.000Z") + offsetMs);
}
