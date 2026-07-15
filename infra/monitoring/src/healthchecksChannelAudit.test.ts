import { describe, expect, it, vi } from "vitest";
import { HealthchecksChannelAudit } from "./healthchecksChannelAudit.js";

const PUSHOVER_ID = "00000000-0000-4000-8000-000000000001";
const EMAIL_ID = "00000000-0000-4000-8000-000000000002";
const BASELINE_ID = "00000000-0000-4000-8000-000000000003";
const ACTIVE_ID = "00000000-0000-4000-8000-000000000004";

describe("Healthchecks phone-channel audit", () => {
  it("accepts only a Pushover channel attached to both checks", async () => {
    const send = providerFetch({
      channels: [{ id: PUSHOVER_ID, name: "operator phone", kind: "po" }],
      baselineChannels: PUSHOVER_ID,
      activeChannels: PUSHOVER_ID
    });
    const audit = new HealthchecksChannelAudit(config(), send);

    await audit.maintain(at(0));

    expect(audit.health()).toEqual({
      configured: true,
      state: "HEALTHY",
      baselineAttached: true,
      activeAttached: true,
      lastSuccessAt: at(0).toISOString(),
      lastFailureAt: null
    });
    expect(JSON.stringify(audit.health())).not.toMatch(/operator phone|00000000/);
    expect(send).toHaveBeenCalledTimes(3);
    for (const call of send.mock.calls) {
      expect(call[1]).toMatchObject({ method: "GET" });
      expect(new Headers(call[1]?.headers).get("x-api-key")).toBe("healthchecks-write-key");
    }

    await audit.maintain(at(299_999));
    expect(send).toHaveBeenCalledTimes(3);
    await audit.maintain(at(300_000));
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("reports email-only checks as missing phone delivery", async () => {
    const send = providerFetch({
      channels: [{ id: EMAIL_ID, name: "operator email", kind: "email" }],
      baselineChannels: EMAIL_ID,
      activeChannels: EMAIL_ID
    });
    const audit = new HealthchecksChannelAudit(config(), send);

    await audit.maintain(at(0));

    expect(audit.health()).toMatchObject({
      state: "DEGRADED",
      baselineAttached: false,
      activeAttached: false,
      lastSuccessAt: at(0).toISOString(),
      lastFailureAt: null
    });
  });

  it("identifies which check is missing the Pushover channel", async () => {
    const audit = new HealthchecksChannelAudit(config(), providerFetch({
      channels: [{ id: PUSHOVER_ID, name: "operator phone", kind: "po" }],
      baselineChannels: PUSHOVER_ID,
      activeChannels: ""
    }));

    await audit.maintain(at(0));

    expect(audit.health()).toMatchObject({
      state: "DEGRADED",
      baselineAttached: true,
      activeAttached: false
    });
  });

  it("audits at five-minute cadence and retries provider failures after thirty seconds", async () => {
    const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const audit = new HealthchecksChannelAudit(config(), send);

    await audit.maintain(at(0));
    await audit.maintain(at(29_999));
    await audit.maintain(at(30_000));

    expect(send).toHaveBeenCalledTimes(6);
    expect(audit.health()).toMatchObject({
      state: "DEGRADED",
      lastSuccessAt: null,
      lastFailureAt: at(30_000).toISOString()
    });
  });

  it("does not make API requests when the audit contract is incomplete", async () => {
    const send = providerFetch({ channels: [], baselineChannels: "", activeChannels: "" });
    const audit = new HealthchecksChannelAudit(config({ healthchecksBaselineCheckId: null }), send);

    await audit.maintain(at(0));

    expect(send).not.toHaveBeenCalled();
    expect(audit.health()).toEqual({
      configured: false,
      state: "NOT_APPLICABLE",
      baselineAttached: null,
      activeAttached: null,
      lastSuccessAt: null,
      lastFailureAt: null
    });
  });

  it("fails closed on malformed provider responses", async () => {
    const send = vi.fn<typeof fetch>(async () => Response.json({ unexpected: true }));
    const audit = new HealthchecksChannelAudit(config(), send);

    await audit.maintain(at(0));

    expect(audit.health()).toMatchObject({
      state: "DEGRADED",
      baselineAttached: null,
      activeAttached: null,
      lastSuccessAt: null,
      lastFailureAt: at(0).toISOString()
    });
  });
});

type AuditConfig = ConstructorParameters<typeof HealthchecksChannelAudit>[0];

function config(patch: Partial<AuditConfig> = {}): AuditConfig {
  return {
    healthchecksApiKey: "healthchecks-write-key",
    healthchecksBaselinePingUrl: "https://hc-ping.com/baseline",
    healthchecksBaselineCheckId: BASELINE_ID,
    healthchecksActivePingUrl: "https://hc-ping.com/active",
    healthchecksActiveCheckId: ACTIVE_ID,
    healthchecksChannelAuditIntervalMs: 300_000,
    ...patch
  };
}

function providerFetch(input: {
  channels: Array<{ id: string; name: string; kind: string }>;
  baselineChannels: string;
  activeChannels: string;
}) {
  return vi.fn<typeof fetch>(async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/channels/")) return Response.json({ channels: input.channels });
    if (pathname.endsWith(`/checks/${BASELINE_ID}`)) return Response.json({ channels: input.baselineChannels });
    if (pathname.endsWith(`/checks/${ACTIVE_ID}`)) return Response.json({ channels: input.activeChannels });
    return new Response(null, { status: 404 });
  });
}

function at(offsetMs: number): Date {
  return new Date(Date.parse("2026-07-15T00:00:00.000Z") + offsetMs);
}
