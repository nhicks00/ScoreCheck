import assert from "node:assert/strict";
import test from "node:test";

import { healthchecksResultUrl, runPlatformSentinel } from "./platform-sentinel.mjs";

const endpoints = [
  { name: "monitor", url: "https://monitor.example.test/healthz", expectedStatus: 200 },
  { name: "ingest", url: "https://ingest.example.test/healthz", expectedStatus: 200 },
  { name: "commentary", url: "https://commentary.example.test/", expectedStatus: 200 },
  { name: "renderer", url: "https://renderer.example.test/api/health", expectedStatus: 200 }
];

test("checks all public planes and pings the independent sentinel check", async () => {
  const calls = [];
  const result = await runPlatformSentinel({
    event: "event-test",
    endpoints,
    pingUrl: "https://hc-ping.com/sentinel-id",
    now: () => new Date("2026-07-22T00:00:00Z"),
    fetchImpl: async (url) => { calls.push(String(url)); return new Response("ok", { status: 200 }); }
  });
  assert.equal(result.passed, true);
  assert.equal(result.endpoints.length, 4);
  assert.equal(calls.at(-1), "https://hc-ping.com/sentinel-id");
});

test("reports a failed public plane through Healthchecks fail semantics", async () => {
  const calls = [];
  const result = await runPlatformSentinel({
    event: "event-test",
    endpoints,
    pingUrl: "https://hc-ping.com/sentinel-id",
    now: () => new Date("2026-07-22T00:00:00Z"),
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response("status", { status: String(url).includes("ingest") ? 503 : 200 });
    }
  });
  assert.equal(result.passed, false);
  assert.match(result.problems.join("; "), /ingest returned HTTP 503/);
  assert.equal(calls.at(-1), "https://hc-ping.com/sentinel-id/fail");
});

test("keeps success and failure URLs scoped to one Healthchecks check", () => {
  assert.equal(healthchecksResultUrl("https://hc-ping.com/id/", true), "https://hc-ping.com/id");
  assert.equal(healthchecksResultUrl("https://hc-ping.com/id/", false), "https://hc-ping.com/id/fail");
  assert.throws(() => healthchecksResultUrl("http://hc-ping.com/id", true), /HTTPS/);
});
