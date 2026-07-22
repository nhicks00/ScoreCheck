import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluatePlatformSentinelEvidence, sentinelEndpoints } from "./platform-sentinel-runtime.mjs";

const manifest = {
  event: "event-test",
  endpoints: [
    { role: "observability", hostname: "monitor.example.test" },
    { role: "ingest", hostname: "ingest.example.test" },
    { role: "commentary", hostname: "rtc.example.test" },
    { role: "commentary", hostname: "turn.example.test" }
  ]
};

test("derives the four public-plane endpoints without exposing protected routes", () => {
  assert.deepEqual(sentinelEndpoints(manifest, { origin: "https://renderer.example.test/" }), {
    monitor: "https://monitor.example.test/healthz",
    ingest: "https://ingest.example.test/healthz",
    commentary: "https://rtc.example.test/",
    renderer: "https://renderer.example.test/api/health"
  });
});

test("accepts continuous successful external sentinel evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-sentinel-"));
  const path = join(root, "sentinel.jsonl");
  const startMs = Date.parse("2026-07-22T00:00:00Z");
  const rows = [0, 60, 120].map((seconds) => sample(new Date(startMs + seconds * 1_000).toISOString()));
  await writeFile(path, `${rows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const result = await evaluatePlatformSentinelEvidence({ path, event: manifest.event, startMs, endMs: startMs + 120_000 });
  assert.equal(result.passed, true);
  assert.equal(result.samples, 3);
});

test("fails on endpoint errors and coverage gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-sentinel-"));
  const path = join(root, "sentinel.jsonl");
  const startMs = Date.parse("2026-07-22T00:00:00Z");
  await writeFile(path, `${JSON.stringify(sample(new Date(startMs).toISOString(), false))}\n${JSON.stringify(sample(new Date(startMs + 180_000).toISOString()))}\n`, { mode: 0o600 });
  const result = await evaluatePlatformSentinelEvidence({ path, event: manifest.event, startMs, endMs: startMs + 180_000 });
  assert.equal(result.passed, false);
  assert.match(result.problems.join("; "), /failed or malformed|maximum gap/);
});

test("fails closed when sentinel timestamps repeat or move backward", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-sentinel-"));
  const path = join(root, "sentinel.jsonl");
  const startMs = Date.parse("2026-07-22T00:00:00Z");
  const rows = [0, 60, 60, 30, 120].map((seconds) => sample(new Date(startMs + seconds * 1_000).toISOString()));
  await writeFile(path, `${rows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const result = await evaluatePlatformSentinelEvidence({ path, event: manifest.event, startMs, endMs: startMs + 120_000 });
  assert.equal(result.passed, false);
  assert.match(result.problems.join("; "), /timestamps are not strictly increasing/);
});

function sample(observedAt, passed = true) {
  return {
    schemaVersion: 1,
    event: manifest.event,
    observedAt,
    passed,
    endpoints: Array.from({ length: 4 }, (_, index) => ({ name: String(index), status: 200, ok: passed })),
    healthchecksDelivery: { ok: true, status: 200 },
    problems: passed ? [] : ["ingest failed"]
  };
}
