import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const harness = vi.hoisted(() => ({
  event: null as { id: string; is_active: boolean } | null,
  court: { id: "court-1", preview_stream_path: null as string | null },
  expectation: { broadcast_expectation: null as string | null }
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(async () => null) }));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ supabaseUrl: "https://db.example.com", supabaseServiceRoleKey: "test-role-key" })
}));
vi.mock("@/lib/eventConfig", () => ({ getActiveEvent: vi.fn(async () => harness.event) }));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: table === "courts" ? harness.court : harness.expectation,
          error: null
        })
      };
      return builder;
    }
  })
}));
vi.mock("@/lib/video", () => ({
  courtMonitorStreamPath: (courtNumber: number) => `court${courtNumber}_monitor`,
  courtPreviewStreamPath: (courtNumber: number, dbPath?: string | null) => dbPath ?? `court${courtNumber}_preview`,
  courtStreamSources: (path: string) => ({ whepUrl: `https://media.example.com/${path}/whep`, hlsUrl: null }),
  dataSaverStreamAdmitted: (expectation: string | null | undefined) => expectation === "OFF",
  videoConfigured: () => true
}));

import { GET } from "../app/api/admin/video/stream-source/route";

function request(quality: "data_saver" | "detail"): NextRequest {
  return new NextRequest(`http://localhost/api/admin/video/stream-source?courtNumber=1&quality=${quality}`);
}

describe("admin monitor stream source", () => {
  beforeEach(() => {
    harness.event = null;
    harness.court.preview_stream_path = null;
    harness.expectation.broadcast_expectation = null;
  });

  it("admits the data-saver path when no production event is active", async () => {
    const response = await GET(request("data_saver"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      whepUrl: "https://media.example.com/court1_monitor/whep"
    });
  });

  it("admits the data-saver path when event selection falls back to history", async () => {
    harness.event = { id: "event-1", is_active: false };

    const response = await GET(request("data_saver"));

    expect(response.status).toBe(200);
  });

  it("rejects the data-saver path while the active court is live", async () => {
    harness.event = { id: "event-1", is_active: true };
    harness.expectation.broadcast_expectation = "LIVE";

    const response = await GET(request("data_saver"));

    expect(response.status).toBe(409);
  });

  it("keeps an unknown active-event expectation fail-closed", async () => {
    harness.event = { id: "event-1", is_active: true };

    const response = await GET(request("data_saver"));

    expect(response.status).toBe(409);
  });
});
