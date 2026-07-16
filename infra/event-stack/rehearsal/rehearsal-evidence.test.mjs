import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "../event-manifest.mjs";
import { RehearsalSoakEvaluator, browserContinuityProblems, evaluateRehearsalPoolEvidence, sealRehearsalEvidence, verifyRehearsalEvidence } from "./rehearsal-evidence.mjs";

test("runs an aligned resumable gate and checks providers at bounded intervals", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "scorecheck-rehearsal-soak-"));
  let now = Date.parse("2026-07-15T12:00:00Z");
  const providerSlots = [];
  const state = { event: "gate", generationId: "generation-1234", sampler: { output: join(root, "pool-host-samples.jsonl") }, soak: { startedAt: new Date(now).toISOString() } };
  const evaluator = new RehearsalSoakEvaluator({
    minimumDurationMs: 0,
    hostEvidenceSettleMs: 0,
    hostEvidenceEvaluator: async () => ({ passed: true, problems: [] }),
    now: () => now,
    sleep: async (ms) => { now += ms; },
    verifier: {
      observeFull: async ({ includeProvider }) => {
        if (includeProvider) providerSlots.push(now);
        return { passed: true, observedAt: new Date(now).toISOString(), snapshot: { generatedAt: new Date(now).toISOString() }, sampler: { running: true, pid: 1 }, provider: includeProvider ? { courts: [] } : null, problems: [] };
      }
    }
  });
  const report = await evaluator.run({ state, evidenceDirectory: root, durationMs: 1_000, sampleIntervalMs: 250, providerIntervalMs: 500 });
  assert.equal(report.passed, true);
  assert.equal(report.observedSamples, 5);
  assert.equal(providerSlots.length, 3);
  assert.equal((await readFile(report.samplesPath, "utf8")).trim().split("\n").length, 5);
});

test("fails closed and preserves the first monitor defect", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "scorecheck-rehearsal-soak-fail-"));
  let now = Date.parse("2026-07-15T12:00:00Z");
  let calls = 0;
  const state = { event: "gate", generationId: "generation-1234", sampler: { output: join(root, "pool.jsonl") }, soak: { startedAt: new Date(now).toISOString() } };
  const evaluator = new RehearsalSoakEvaluator({
    minimumDurationMs: 0,
    hostEvidenceSettleMs: 0,
    hostEvidenceEvaluator: async () => ({ passed: true, problems: [] }),
    now: () => now,
    sleep: async (ms) => { now += ms; },
    verifier: { observeFull: async () => ({ snapshot: {}, sampler: { running: true }, provider: null, problems: ++calls === 2 ? ["Camera 4 has frame errors"] : [] }) }
  });
  const report = await evaluator.run({ state, evidenceDirectory: root, durationMs: 1_000, sampleIntervalMs: 250, providerIntervalMs: 500 });
  assert.equal(report.passed, false);
  assert.equal(report.observedSamples, 2);
  assert.deepEqual(report.problems, ["Camera 4 has frame errors"]);
});

test("pins browser page identity and requires reset-safe heartbeat and rendered-frame progress", () => {
  const browser = (court, overrides = {}) => ({
    credentialId: `credential-${court}`,
    pageLoadedAt: "2026-07-15T12:00:00.000Z",
    pageBuildVersion: "build-a",
    configurationVersion: "config-a",
    heartbeatSeq: 10,
    receivedAt: "2026-07-15T12:00:05.000Z",
    video: { framesRendered: 150 },
    ...overrides
  });
  const monitor = (overrides = {}) => ({ courts: Array.from({ length: 8 }, (_, index) => ({ courtNumber: index + 1, browser: browser(index + 1, overrides[index + 1] ?? {}) })) });
  const before = monitor();
  const after = monitor(Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, { heartbeatSeq: 11, receivedAt: "2026-07-15T12:00:10.000Z", video: { framesRendered: 300 } }])));
  assert.deepEqual(browserContinuityProblems(before, after), []);
  after.courts[0].browser.pageLoadedAt = "2026-07-15T12:00:09.000Z";
  after.courts[1].browser.heartbeatSeq = 1;
  after.courts[2].browser.video.framesRendered = 1;
  const problems = browserContinuityProblems(before, after).join("; ");
  assert.match(problems, /pageLoadedAt changed/);
  assert.match(problems, /heartbeat sequence/);
  assert.match(problems, /rendered frames/);
});

test("evaluates exact DigitalOcean host identity, sampler cadence, CPU, shared memory, and zombie evidence", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "scorecheck-rehearsal-pool-"));
  const inputs = await loadManifestInputs();
  const manifest = buildEventManifest({ event: "rehearsal-pool-evidence", kind: "rehearsal", destroyAfter: "2026-08-01", ...inputs });
  const startMs = Date.parse("2026-07-15T12:00:10.000Z");
  const endMs = startMs + 10_000;
  const poolSpecs = [
    ...manifest.droplets.filter((entry) => entry.role === "ingest"),
    ...manifest.droplets.filter((entry) => ["compositor", "compositor-spare"].includes(entry.role)).sort((left, right) => left.providerName.localeCompare(right.providerName))
  ];
  const lifecycleState = {
    droplets: Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, {
      id: String(1_000 + index), status: "active", providerName: spec.providerName, region: spec.region
    }]))
  };
  const lines = [];
  for (const [index, spec] of poolSpecs.entries()) {
    const role = spec.role === "ingest" ? "ingest" : "compositor";
    const resource = lifecycleState.droplets[spec.name];
    const events = [{
      schemaVersion: 1, role, event: "watcher_started", observedAt: timestamp(startMs - 10_000), pollIntervalMs: 50,
      watcherPid: 2_000 + index, machineFingerprint: (index + 1).toString(16).padStart(16, "0"),
      provider: "digitalocean", providerResourceId: resource.id, providerHostname: spec.providerName
    }];
    for (let offset = -1; offset <= 11; offset += 1) events.push({
      schemaVersion: 1, role, event: "heartbeat", observedAt: timestamp(startMs + offset * 1_000),
      scanCount: offset + 20, activeZombieCount: 0, maximumScanGapMs: 55
    });
    for (const offset of [-5, 0, 5, 10]) events.push({
      schemaVersion: 1, role, event: "host_sample", observedAt: timestamp(startMs + offset * 1_000 + 20),
      sampleSlotAt: timestamp(startMs + offset * 1_000), sampleLagMs: 20, sampleOk: true,
      cpuRatio: role === "ingest" ? 0.4 : 0.5, shmRatio: role === "ingest" ? 0 : 0.2
    });
    events.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    lines.push(...events.map((event) => JSON.stringify({ ...event, hostId: spec.providerName })));
  }
  const output = join(root, "pool-host-samples.jsonl");
  await writeFile(output, `${lines.join("\n")}\n`, { mode: 0o600 });
  const state = { sampler: { output } };
  const evidence = await evaluateRehearsalPoolEvidence({ state, manifest, lifecycleState, startMs, endMs });
  assert.equal(evidence.passed, true);
  assert.equal(Object.keys(evidence.hosts).length, 10);

  lifecycleState.droplets[poolSpecs[0].name].id = "999999";
  const mismatched = await evaluateRehearsalPoolEvidence({ state, manifest, lifecycleState, startMs, endMs });
  assert.equal(mismatched.passed, false);
  assert.match(mismatched.problems.join("; "), /provider_identity/);
});

test("seals and verifies failed evidence only after every provider resource is deleted", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "scorecheck-rehearsal-seal-"));
  const manifest = { kind: "rehearsal", event: "gate", droplets: Array(12).fill({}) };
  const digest = sha(manifest);
  const state = {
    phase: "cleaned", event: "gate", generationId: "generation-1234", manifestSha256: digest,
    createdAt: "2026-07-15T12:00:00Z", preparedAt: "2026-07-15T12:01:00Z", startedAt: "2026-07-15T12:02:00Z", stoppedAt: "2026-07-15T12:03:00Z", cleanedAt: "2026-07-15T12:04:00Z",
    program: { project: { id: "project", status: "deleted" } },
    courts: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, { stream: { id: `s${index}`, status: "deleted" }, broadcast: { id: `b${index}`, status: "deleted" } }])),
    startEvidence: { passed: true }, soakEvidence: { passed: false }, endpointEvidence: { passed: false }, stopEvidence: { passed: true }
  };
  await Promise.all([
    writeFile(join(root, "pool-host-samples.jsonl"), "{}\n", { mode: 0o600 }),
    writeFile(join(root, "rehearsal-monitor-samples.jsonl"), "{}\n", { mode: 0o600 }),
    writeFile(join(root, "rehearsal-soak-report.json"), "{}\n", { mode: 0o600 })
  ]);
  await assert.rejects(() => sealRehearsalEvidence({ state: { ...state, program: { project: { id: "project" } } }, manifest, evidenceDirectory: root }), /Vercel/);
  const marker = await sealRehearsalEvidence({ state, manifest, evidenceDirectory: root });
  assert.equal(marker.classification, "FAIL");
  const verified = await verifyRehearsalEvidence({ directory: root, event: state.event, generationId: state.generationId, manifestSha256: digest });
  assert.equal(verified.marker.providerCleanupComplete, true);
});

test("creates protected cancelled evidence when preparation fails before evidence collection", async () => {
  const parent = await mkdtemp(join(os.tmpdir(), "scorecheck-rehearsal-cancelled-"));
  const root = join(parent, "evidence");
  const manifest = { kind: "rehearsal", event: "gate", droplets: Array(12).fill({}) };
  const digest = sha(manifest);
  const state = {
    phase: "cleaned", event: "gate", generationId: "generation-1234", manifestSha256: digest,
    createdAt: "2026-07-15T12:00:00Z", preparedAt: null, startedAt: null, stoppedAt: null, cleanedAt: "2026-07-15T12:01:00Z",
    program: { project: { id: "project", status: "deleted" } },
    courts: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, { stream: { id: null, status: "absent" }, broadcast: { id: null, status: "absent" } }])),
    startEvidence: null, soakEvidence: null, endpointEvidence: null, stopEvidence: null
  };

  const marker = await sealRehearsalEvidence({ state, manifest, evidenceDirectory: root });
  assert.equal(marker.classification, "CANCELLED");
  assert.equal((await stat(root)).mode & 0o077, 0);
  const verified = await verifyRehearsalEvidence({ directory: root, event: state.event, generationId: state.generationId, manifestSha256: digest });
  assert.equal(verified.evidence.classification, "CANCELLED");
});

function sha(value) {
  const stable = (current) => Array.isArray(current) ? `[${current.map(stable).join(",")}]` : current && typeof current === "object" ? `{${Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${stable(current[key])}`).join(",")}}` : JSON.stringify(current);
  return createHash("sha256").update(stable(value)).digest("hex");
}

function timestamp(value) { return new Date(value).toISOString(); }
