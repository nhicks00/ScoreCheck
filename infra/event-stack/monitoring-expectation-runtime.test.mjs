import assert from "node:assert/strict";
import test from "node:test";

import { MonitoringExpectationRuntime } from "./monitoring-expectation-runtime.mjs";

const nowMs = Date.parse("2026-07-26T12:00:00Z");
const key = "service-role-test-key-1234567890";

test("resolves exactly one active event and every requested camera", async () => {
  const requests = [];
  const runtime = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    fetchImpl: async (url) => {
      requests.push(url.toString());
      if (url.pathname.endsWith("/events")) return response([{ id: "event-1" }]);
      return response([{ id: "court-1", court_number: 1 }, { id: "court-2", court_number: 2 }]);
    }
  });
  assert.deepEqual(await runtime.resolve([1, 2]), { eventId: "event-1", cameras: { 1: "court-1", 2: "court-2" } });
  assert.match(requests[0], /is_active=eq\.true/u);
  assert.match(requests[1], /court_number=in\.\(1%2C2\)|court_number=in\.\(1,2\)/u);
});

test("fails closed on an absent event or incomplete camera mapping", async () => {
  const noEvent = new MonitoringExpectationRuntime({ supabaseUrl: "https://project.supabase.co", serviceRoleKey: key, fetchImpl: async () => response([]) });
  await assert.rejects(() => noEvent.resolve([1]), /exactly one active Supabase event/u);

  let request = 0;
  const incomplete = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    fetchImpl: async () => response(request++ === 0 ? [{ id: "event-1" }] : [{ id: "court-1", court_number: 1 }])
  });
  await assert.rejects(() => incomplete.resolve([1, 2]), /does not map every active camera/u);
});

test("upserts and verifies testing and live expectations without requiring commentary", async () => {
  const bodies = [];
  const runtime = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    now: () => nowMs,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return response([body]);
    }
  });
  const binding = { eventId: "event-1", cameras: { 1: "court-1" } };
  await runtime.set({ binding, camera: 1, phase: "TESTING", commentaryParticipating: false, runId: "run-1" });
  await runtime.set({ binding, camera: 1, phase: "LIVE", commentaryParticipating: false, runId: "run-1" });
  assert.deepEqual(bodies.map((body) => body.broadcast_expectation), ["TESTING", "LIVE"]);
  assert.ok(bodies.every((body) => body.media_expectation === "REQUIRED" && body.commentary_expectation === "NONE" && body.scoring_expectation === "SCHEDULED"));
  assert.equal(bodies[0].override_expires_at, "2026-07-27T06:00:00.000Z");
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
