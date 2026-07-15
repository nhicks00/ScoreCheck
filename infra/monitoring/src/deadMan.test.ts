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
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBe("https://hc-ping.com/active");
    expect(String(send.mock.calls[1]?.[0])).toContain("/pause");
    expect(deadMan.health().active.mode).toBe("PAUSED");

    await deadMan.maintain(true, at(10_000));
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toBe("https://hc-ping.com/active");
    expect(deadMan.health().active.mode).toBe("RUNNING");

    await deadMan.maintain(false, at(15_000));
    expect(send).toHaveBeenCalledTimes(4);
    expect(deadMan.health().active.mode).toBe("PAUSED");
  });

  it("withholds the baseline through its provider deadline and recovers at bounded expiry", async () => {
    const send = providerFetch({ baseline: { timeout: 600, grace: 180 } });
    const deadMan = new ExternalDeadMan(config({
      healthchecksBaselinePingUrl: "https://hc-ping.com/baseline",
      healthchecksBaselineCheckId: "00000000-0000-4000-8000-000000000003",
      healthchecksApiKey: "healthchecks-write-key"
    }), send);

    const gate = await deadMan.armTestGate({
      check: "baseline",
      durationSeconds: 900,
      actor: "gate-operator",
      reason: "Prove baseline Pushover delivery."
    }, at(0));

    expect(gate).toMatchObject({
      check: "baseline",
      phase: "WITHHOLDING",
      expectedAlertAt: at(780_000).toISOString(),
      expiresAt: at(900_000).toISOString(),
      providerTimeoutSeconds: 600,
      providerGraceSeconds: 180
    });
    expect(send).toHaveBeenCalledTimes(2);

    await deadMan.maintain(false, at(899_999));
    expect(send).toHaveBeenCalledTimes(2);
    expect(deadMan.testGate()?.phase).toBe("WITHHOLDING");

    await deadMan.maintain(false, at(900_000));
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toBe("https://hc-ping.com/baseline");
    expect(deadMan.testGate()).toBeNull();
    expect(deadMan.health().baseline).toMatchObject({ mode: "RUNNING", lastFailureAt: null });
  });

  it("resumes and then pauses the active check after a bounded withheld-ping test", async () => {
    const send = providerFetch({ active: { timeout: 60, grace: 60 } });
    const deadMan = new ExternalDeadMan(config({
      healthchecksActivePingUrl: "https://hc-ping.com/active",
      healthchecksActiveCheckId: "00000000-0000-4000-8000-000000000004",
      healthchecksApiKey: "healthchecks-write-key"
    }), send);

    const gate = await deadMan.armTestGate({
      check: "active",
      durationSeconds: 180,
      actor: "gate-operator",
      reason: "Prove active Pushover delivery."
    }, at(0));
    expect(gate.expectedAlertAt).toBe(at(120_000).toISOString());
    expect(deadMan.health().active.mode).toBe("RUNNING");

    await deadMan.maintain(false, at(179_999));
    expect(send).toHaveBeenCalledTimes(2);

    await deadMan.maintain(false, at(180_000));
    expect(deadMan.testGate()).toMatchObject({ phase: "WAITING_TO_PAUSE", recoveryReason: "expired" });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toBe("https://hc-ping.com/active");

    await deadMan.maintain(false, at(209_999));
    expect(send).toHaveBeenCalledTimes(3);
    await deadMan.maintain(false, at(210_000));
    expect(send).toHaveBeenCalledTimes(4);
    expect(String(send.mock.calls[3]?.[0])).toContain("/pause");
    expect(deadMan.testGate()).toBeNull();
    expect(deadMan.health().active.mode).toBe("PAUSED");
  });

  it("aborts a withheld-ping test immediately when coverage begins", async () => {
    const send = providerFetch({ active: { timeout: 60, grace: 60 } });
    const deadMan = new ExternalDeadMan(config({
      healthchecksActivePingUrl: "https://hc-ping.com/active",
      healthchecksActiveCheckId: "00000000-0000-4000-8000-000000000004",
      healthchecksApiKey: "healthchecks-write-key"
    }), send);

    await deadMan.armTestGate({
      check: "active",
      durationSeconds: 180,
      actor: "gate-operator",
      reason: "Prove active Pushover delivery."
    }, at(0));
    await deadMan.maintain(true, at(30_000));

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]?.[0]).toBe("https://hc-ping.com/active");
    expect(deadMan.testGate()).toBeNull();
    expect(deadMan.health().active.mode).toBe("RUNNING");
  });

  it("rejects a gate that cannot cross the live provider alert deadline", async () => {
    const send = providerFetch({ baseline: { timeout: 600, grace: 180 } });
    const deadMan = new ExternalDeadMan(config({
      healthchecksBaselinePingUrl: "https://hc-ping.com/baseline",
      healthchecksBaselineCheckId: "00000000-0000-4000-8000-000000000003",
      healthchecksApiKey: "healthchecks-write-key"
    }), send);

    await expect(deadMan.armTestGate({
      check: "baseline",
      durationSeconds: 809,
      actor: "gate-operator",
      reason: "This test is intentionally too short."
    }, at(0))).rejects.toMatchObject({ code: "TEST_GATE_DURATION_TOO_SHORT", status: 400 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(deadMan.testGate()).toBeNull();
  });

  it("does not arm when the initial provider ping fails", async () => {
    const send = providerFetch({ baseline: { timeout: 600, grace: 180 }, failPosts: true });
    const deadMan = new ExternalDeadMan(config({
      healthchecksBaselinePingUrl: "https://hc-ping.com/baseline",
      healthchecksBaselineCheckId: "00000000-0000-4000-8000-000000000003",
      healthchecksApiKey: "healthchecks-write-key"
    }), send);

    await expect(deadMan.armTestGate({
      check: "baseline",
      durationSeconds: 900,
      actor: "gate-operator",
      reason: "Prove baseline Pushover delivery."
    }, at(0))).rejects.toMatchObject({ code: "DEAD_MAN_PROVIDER_UNAVAILABLE", status: 503 });
    expect(deadMan.testGate()).toBeNull();
    expect(deadMan.health().baseline.lastFailureAt).toBe(at(0).toISOString());
  });

  it("serializes concurrent arm requests and admits exactly one gate", async () => {
    const send = providerFetch({ baseline: { timeout: 600, grace: 180 } });
    const deadMan = new ExternalDeadMan(config({
      healthchecksBaselinePingUrl: "https://hc-ping.com/baseline",
      healthchecksBaselineCheckId: "00000000-0000-4000-8000-000000000003",
      healthchecksApiKey: "healthchecks-write-key"
    }), send);
    const request = {
      check: "baseline" as const,
      durationSeconds: 900,
      actor: "gate-operator",
      reason: "Prove baseline Pushover delivery."
    };

    const results = await Promise.allSettled([
      deadMan.armTestGate(request, at(0)),
      deadMan.armTestGate(request, at(0))
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "TEST_GATE_ALREADY_ACTIVE", status: 409 }
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("retries a failed active-check pause at the bounded retry cadence", async () => {
    let pauseAttempts = 0;
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "GET") return Response.json({ timeout: 60, grace: 60 });
      if (String(url).endsWith("/pause")) {
        pauseAttempts += 1;
        return new Response(null, { status: pauseAttempts === 1 ? 503 : 200 });
      }
      return new Response(null, { status: 200 });
    });
    const deadMan = new ExternalDeadMan(config({
      healthchecksActivePingUrl: "https://hc-ping.com/active",
      healthchecksActiveCheckId: "00000000-0000-4000-8000-000000000004",
      healthchecksApiKey: "healthchecks-write-key"
    }), send);

    await deadMan.armTestGate({
      check: "active",
      durationSeconds: 180,
      actor: "gate-operator",
      reason: "Prove active Pushover delivery."
    }, at(0));
    await deadMan.maintain(false, at(180_000));
    await deadMan.maintain(false, at(210_000));
    expect(pauseAttempts).toBe(1);
    expect(deadMan.testGate()?.phase).toBe("WAITING_TO_PAUSE");

    await deadMan.maintain(false, at(239_999));
    expect(pauseAttempts).toBe(1);
    await deadMan.maintain(false, at(240_000));
    expect(pauseAttempts).toBe(2);
    expect(deadMan.testGate()).toBeNull();
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

  it("degrades overall watchdog health when both checks are email-only", async () => {
    const emailId = "00000000-0000-4000-8000-000000000005";
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") return new Response(null, { status: 200 });
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/channels/")) return Response.json({ channels: [{ id: emailId, kind: "email" }] });
      return Response.json({ channels: emailId });
    });
    const deadMan = new ExternalDeadMan(config({
      healthchecksBaselinePingUrl: "https://hc-ping.com/baseline",
      healthchecksBaselineCheckId: "00000000-0000-4000-8000-000000000003",
      healthchecksActivePingUrl: "https://hc-ping.com/active",
      healthchecksActiveCheckId: "00000000-0000-4000-8000-000000000004",
      healthchecksApiKey: "healthchecks-write-key"
    }), send);

    await deadMan.maintain(false, at(0));

    expect(deadMan.health()).toMatchObject({
      state: "DEGRADED",
      baseline: { mode: "RUNNING" },
      active: { mode: "PAUSED" },
      phoneChannel: { state: "DEGRADED", baselineAttached: false, activeAttached: false }
    });
  });
});

type TestConfig = {
  healthchecksBaselinePingUrl: string | null;
  healthchecksBaselineCheckId: string | null;
  healthchecksActivePingUrl: string | null;
  healthchecksApiKey: string | null;
  healthchecksActiveCheckId: string | null;
  healthchecksBaselineIntervalMs: number;
  healthchecksActiveIntervalMs: number;
  healthchecksChannelAuditIntervalMs: number;
};

function config(patch: Partial<TestConfig> = {}): TestConfig {
  return {
    healthchecksBaselinePingUrl: null as string | null,
    healthchecksBaselineCheckId: null as string | null,
    healthchecksActivePingUrl: null as string | null,
    healthchecksApiKey: null as string | null,
    healthchecksActiveCheckId: null as string | null,
    healthchecksBaselineIntervalMs: 600_000,
    healthchecksActiveIntervalMs: 60_000,
    healthchecksChannelAuditIntervalMs: 300_000,
    ...patch
  };
}

function successfulFetch() {
  return vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
}

function providerFetch(input: {
  baseline?: { timeout: number; grace: number };
  active?: { timeout: number; grace: number };
  failPosts?: boolean;
}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === "POST") return new Response(null, { status: input.failPosts ? 503 : 200 });
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("00000000-0000-4000-8000-000000000003") && input.baseline) return Response.json(input.baseline);
    if (pathname.endsWith("00000000-0000-4000-8000-000000000004") && input.active) return Response.json(input.active);
    return new Response(null, { status: 404 });
  });
}

function at(offsetMs: number): Date {
  return new Date(Date.parse("2026-07-12T00:00:00.000Z") + offsetMs);
}
