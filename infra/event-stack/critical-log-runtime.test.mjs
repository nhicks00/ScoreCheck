import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { criticalLogHosts, evaluateCriticalLogEvidence } from "./critical-log-runtime.mjs";

const event = "critical-log-test";
const names = Array.from({ length: 12 }, (_, index) => `host-${String(index + 1).padStart(2, "0")}`);

test("derives exactly twelve deterministic SSH log streams", () => {
  const manifest = { droplets: names.map((name, index) => ({ name, role: index === 0 ? "ingest" : index === 1 ? "commentary" : index === 2 ? "observability" : index === 11 ? "compositor-spare" : "compositor" })) };
  const lifecycleState = { droplets: Object.fromEntries(names.map((name, index) => [name, { publicIpv4: `192.0.2.${index + 1}` }])) };
  const hosts = criticalLogHosts(manifest, lifecycleState);
  assert.equal(hosts.length, 12);
  assert.deepEqual(hosts[0], { name: "host-01", role: "ingest", target: "root@192.0.2.1" });
});

test("accepts complete external log-stream heartbeat coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-critical-logs-"));
  const path = join(root, "critical-logs.jsonl");
  const startMs = Date.parse("2026-07-22T00:00:00Z");
  const rows = [
    row("collector_started", startMs - 1_000, { expectedHosts: 12 }),
    ...names.map((host) => row("stream_ready", startMs - 500, { host, role: "compositor" })),
    ...[60, 120].map((seconds) => row("heartbeat", startMs + seconds * 1_000, { readyHosts: names, expectedHosts: 12 })),
    row("collector_stopped", startMs + 121_000, { readyHosts: names, expectedHosts: 12 })
  ];
  await writeFile(path, `${rows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const result = await evaluateCriticalLogEvidence({ path, event, expectedHosts: names, startMs, endMs: startMs + 120_000 });
  assert.equal(result.passed, true);
  assert.equal(result.heartbeats, 2);
});

test("fails closed on a stream exit or incomplete heartbeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-critical-logs-"));
  const path = join(root, "critical-logs.jsonl");
  const startMs = Date.parse("2026-07-22T00:00:00Z");
  const rows = [
    row("collector_started", startMs - 1_000, { expectedHosts: 12 }),
    ...names.slice(0, 11).map((host) => row("stream_ready", startMs - 500, { host, role: "compositor" })),
    row("heartbeat", startMs + 60_000, { readyHosts: names.slice(0, 11), expectedHosts: 12 }),
    row("collector_error", startMs + 61_000, { host: names[11], reason: "SSH exited" })
  ];
  await writeFile(path, `${rows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const result = await evaluateCriticalLogEvidence({ path, event, expectedHosts: names, startMs, endMs: startMs + 120_000 });
  assert.equal(result.passed, false);
  assert.match(result.problems.join("; "), /stream failure|every host|incomplete/u);
});

test("fails closed when critical-log heartbeat timestamps repeat or move backward", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-critical-logs-"));
  const path = join(root, "critical-logs.jsonl");
  const startMs = Date.parse("2026-07-22T00:00:00Z");
  const rows = [
    row("collector_started", startMs - 1_000, { expectedHosts: 12 }),
    ...names.map((host) => row("stream_ready", startMs - 500, { host, role: "compositor" })),
    ...[60, 60, 30, 120].map((seconds) => row("heartbeat", startMs + seconds * 1_000, { readyHosts: names, expectedHosts: 12 })),
    row("collector_stopped", startMs + 121_000, { readyHosts: names, expectedHosts: 12 })
  ];
  await writeFile(path, `${rows.map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const result = await evaluateCriticalLogEvidence({ path, event, expectedHosts: names, startMs, endMs: startMs + 120_000 });
  assert.equal(result.passed, false);
  assert.match(result.problems.join("; "), /timestamps are not strictly increasing/);
});

function row(type, observedMs, values) {
  return { schemaVersion: 1, event, observedAt: new Date(observedMs).toISOString(), type, ...values };
}
