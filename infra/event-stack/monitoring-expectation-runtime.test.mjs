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
      if (url.pathname.endsWith("/court_monitoring_expectations")) return response([]);
      return response([{ id: "court-1", court_number: 1, youtube_video_id: "video-old-1" }, { id: "court-2", court_number: 2, youtube_video_id: null }]);
    }
  });
  assert.deepEqual(await runtime.resolve([1, 2]), {
    eventId: "event-1",
    cameras: { 1: "court-1", 2: "court-2" },
    youtubeVideoIds: { 1: "video-old-1", 2: null }
  });
  assert.match(requests[0], /is_active=eq\.true/u);
  assert.match(requests[1], /court_number=in\.\(1%2C2\)|court_number=in\.\(1,2\)/u);
  assert.match(requests[2], /court_monitoring_expectations/u);
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

test("rejects an active camera with a pre-existing monitoring expectation", async () => {
  let request = 0;
  const runtime = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    now: () => nowMs,
    fetchImpl: async () => response(request++ === 0
      ? [{ id: "event-1" }]
      : request === 2 ? [{ id: "court-1", court_number: 1, youtube_video_id: null }] : [{ court_id: "court-1", override_created_by: "operator", override_expires_at: "2026-07-27T07:00:00Z" }])
  });
  await assert.rejects(() => runtime.resolve([1]), /no active pre-existing overrides/u);
});

test("allows an expired monitoring expectation to be replaced by the new run", async () => {
  let request = 0;
  const runtime = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    now: () => nowMs,
    fetchImpl: async () => response(request++ === 0
      ? [{ id: "event-1" }]
      : request === 2 ? [{ id: "court-1", court_number: 1, youtube_video_id: null }] : [{ court_id: "court-1", override_created_by: "operator", override_expires_at: "2026-07-26T11:00:00Z" }])
  });
  assert.deepEqual(await runtime.resolve([1]), { eventId: "event-1", cameras: { 1: "court-1" }, youtubeVideoIds: { 1: null } });
});

test("allows the canonical non-expiring OFF baseline", async () => {
  let request = 0;
  const runtime = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    now: () => nowMs,
    fetchImpl: async () => response(request++ === 0
      ? [{ id: "event-1" }]
      : request === 2 ? [{ id: "court-1", court_number: 1, youtube_video_id: "video-old-1" }] : [{ court_id: "court-1", override_created_by: null, override_expires_at: null }])
  });
  assert.deepEqual(await runtime.resolve([1]), { eventId: "event-1", cameras: { 1: "court-1" }, youtubeVideoIds: { 1: "video-old-1" } });
});

test("binds a run-owned YouTube destination and restores the exact prior value", async () => {
  let current = "video-old-1";
  const requests = [];
  const runtime = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      if (!options.method) return response([{ youtube_video_id: current }]);
      const body = JSON.parse(options.body);
      current = body.youtube_video_id;
      return response([{ youtube_video_id: current }]);
    }
  });
  const binding = { eventId: "event-1", cameras: { 1: "court-1" }, youtubeVideoIds: { 1: "video-old-1" } };
  const bound = await runtime.bindDestination({ binding, camera: 1, broadcastId: "video-new-1" });
  assert.deepEqual(bound, { broadcastId: "video-new-1", previousVideoId: "video-old-1", adopted: false });
  assert.match(requests[1].url, /youtube_video_id=eq\.video-old-1/u);
  const restored = await runtime.restoreDestination({ binding, camera: 1, broadcastId: "video-new-1" });
  assert.deepEqual(restored, { status: "RESTORED", broadcastId: "video-new-1", previousVideoId: "video-old-1", adopted: false });
  assert.equal(current, "video-old-1");
  assert.match(requests[3].url, /youtube_video_id=eq\.video-new-1/u);
});

test("refuses to overwrite a YouTube destination changed after resolution", async () => {
  const runtime = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    fetchImpl: async () => response([{ youtube_video_id: "video-operator" }])
  });
  await assert.rejects(() => runtime.bindDestination({
    binding: { eventId: "event-1", cameras: { 1: "court-1" }, youtubeVideoIds: { 1: "video-old-1" } },
    camera: 1,
    broadcastId: "video-new-1"
  }), /changed after monitoring resolution/u);
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

for (const phase of ["testing", "live"]) {
  test(`restores exactly one ${phase} expectation owned by the failed run to OFF`, async () => {
    const requests = [];
    const reason = `Production soak run-1 set Camera 1 ${phase}.`;
    const runtime = new MonitoringExpectationRuntime({
      supabaseUrl: "https://project.supabase.co",
      serviceRoleKey: key,
      now: () => nowMs,
      fetchImpl: async (url, options) => {
        requests.push({ url: url.toString(), options });
        if (!options.method) return response([{ override_created_by: "scorecheck-production-soak", override_reason: reason }]);
        return response([{ court_id: "court-1" }]);
      }
    });
    const result = await runtime.clear({ binding: { eventId: "event-1", cameras: { 1: "court-1" } }, camera: 1, runId: "run-1" });
    assert.equal(result.phase, "CLEARED");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.method, undefined);
    assert.match(requests[0].url, /select=override_created_by%2Coverride_reason|select=override_created_by,override_reason/u);
    assert.equal(requests[1].options.method, "PATCH");
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      coverage_phase: "OFF",
      media_expectation: "OFF",
      broadcast_expectation: "OFF",
      commentary_expectation: "NONE",
      scoring_expectation: "NONE",
      override_created_by: null,
      override_created_at: null,
      override_reason: null,
      override_expires_at: null,
      updated_at: "2026-07-26T12:00:00.000Z"
    });
    assert.match(requests[1].url, /override_created_by=eq\.scorecheck-production-soak/u);
    assert.match(requests[1].url, new RegExp(encodeURIComponent(reason).replaceAll(".", "\\."), "u"));
  });
}

test("refuses to clear an expectation not owned by the failed run", async () => {
  let requests = 0;
  const runtime = new MonitoringExpectationRuntime({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    fetchImpl: async () => {
      requests += 1;
      return response([{ override_created_by: "operator", override_reason: "manual override" }]);
    }
  });
  await assert.rejects(
    () => runtime.clear({ binding: { eventId: "event-1", cameras: { 1: "court-1" } }, camera: 1, runId: "run-1" }),
    /does not own the current row/u
  );
  assert.equal(requests, 1);
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
