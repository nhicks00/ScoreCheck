import assert from "node:assert/strict";
import test from "node:test";

import { parseHostSamplesCsv, summarizeHostSamples } from "./host-samples.mjs";

test("summarizes reset-safe host capacity evidence with a pre-run baseline", () => {
  const rows = parseHostSamplesCsv(csv([
    ["2026-07-15T00:00:55Z", 0.1, 1, 0.1, 0, 0, 1],
    ["2026-07-15T00:01:00Z", 0.2, 1, 0.3, 0, 0.1, 1],
    ["2026-07-15T00:01:05Z", 0.3, 1, 0.4, 1, 0.2, 1],
    ["2026-07-15T00:01:10Z", 0.4, 1, 0.5, 1, 0.3, 1]
  ]));
  const summary = summarizeHostSamples(rows, {
    startEpochSeconds: Date.parse("2026-07-15T00:01:00Z") / 1_000,
    endEpochSeconds: Date.parse("2026-07-15T00:01:10Z") / 1_000,
    stepSeconds: 5
  });

  assert.equal(summary.expectedSamples, 3);
  assert.equal(summary.validSamples, 3);
  assert.equal(summary.coverageRatio, 1);
  assert.equal(summary.compositorZombieGrowth, 1);
  assert.equal(summary.ingestZombieGrowth, 0);
  assert.equal(summary.p95GapSeconds, 5);
  assert.equal(summary.maxGapSeconds, 5);
  assert.equal(summary.startEdgeGapSeconds, 0);
  assert.equal(summary.endEdgeGapSeconds, 0);
  assert.equal(summary.egressShmMaxRatio, 0.3);
});

test("uses the nearest valid pre-start row as the zombie baseline", () => {
  const rows = parseHostSamplesCsv(csv([
    ["2026-07-15T00:00:52Z", 0.1, 1, 0.1, 0, 0, 1],
    ["2026-07-15T00:00:58Z", 0.1, 1, 0.1, 2, 0, 1],
    ["2026-07-15T00:01:00Z", 0.1, 1, 0.1, 2, 0, 1],
    ["2026-07-15T00:01:05Z", 0.1, 1, 0.1, 2, 0, 1]
  ]));
  const summary = summarizeHostSamples(rows, {
    startEpochSeconds: Date.parse("2026-07-15T00:01:00Z") / 1_000,
    endEpochSeconds: Date.parse("2026-07-15T00:01:05Z") / 1_000,
    stepSeconds: 5
  });

  assert.equal(summary.baselineSampleAt, "2026-07-15T00:00:58.000Z");
  assert.equal(summary.compositorZombieBaseline, 2);
  assert.equal(summary.compositorZombieGrowth, 0);
});

test("reports sparse and invalid host samples instead of silently accepting them", () => {
  const rows = parseHostSamplesCsv(csv([
    ["2026-07-15T00:00:55Z", 0.1, 0, 0.1, 0, 0, 1],
    ["2026-07-15T00:01:00Z", 0.2, 0, 0.3, 0, 0.1, 1],
    ["2026-07-15T00:01:08Z", "", 0, 0.4, 0, 0.2, 0]
  ]));
  const summary = summarizeHostSamples(rows, {
    startEpochSeconds: Date.parse("2026-07-15T00:01:00Z") / 1_000,
    endEpochSeconds: Date.parse("2026-07-15T00:01:10Z") / 1_000,
    stepSeconds: 5
  });

  assert.equal(summary.expectedSamples, 3);
  assert.equal(summary.validSamples, 1);
  assert.equal(summary.failedSamples, 1);
  assert.equal(summary.coverageRatio, 1 / 3);
  assert.equal(summary.p95GapSeconds, null);
});

test("exposes a long blind spot even when clustered samples inflate count coverage and p95", () => {
  const seconds = [
    -5,
    0, 5, 10, 15, 20, 25, 30, 35, 40, 45,
    75, 76, 77, 78, 79, 80, 81, 85, 90, 95, 100, 105, 110, 115, 120
  ];
  const rows = parseHostSamplesCsv(csv(seconds.map((second) => [
    new Date(Date.parse("2026-07-15T00:01:00Z") + (second * 1_000)).toISOString(),
    0.2, 0, 0.3, 0, 0.1, 1
  ])));
  const summary = summarizeHostSamples(rows, {
    startEpochSeconds: Date.parse("2026-07-15T00:01:00Z") / 1_000,
    endEpochSeconds: Date.parse("2026-07-15T00:03:00Z") / 1_000,
    stepSeconds: 5
  });

  assert.equal(summary.expectedSamples, 25);
  assert.equal(summary.validSamples, 25);
  assert.equal(summary.coverageRatio, 1);
  assert.equal(summary.p95GapSeconds, 5);
  assert.equal(summary.maxGapSeconds, 30);
  assert.equal(summary.startEdgeGapSeconds, 0);
  assert.equal(summary.endEdgeGapSeconds, 0);
});

test("rejects malformed or duplicate CSV rows", () => {
  assert.throws(() => parseHostSamplesCsv("wrong,header\nvalue"), /header/);
  assert.throws(() => parseHostSamplesCsv(csv([
    ["2026-07-15T00:00:00Z", 0.1, 0, 0.1, 0, 0, 1],
    ["2026-07-15T00:00:00Z", 0.2, 0, 0.2, 0, 0, 1]
  ])), /duplicate timestamp/);
});

function csv(rows) {
  return [
    "sampled_at,ingest_cpu_ratio,ingest_zombies,compositor_cpu_ratio,compositor_zombies,egress_shm_ratio,sample_ok",
    ...rows.map((row) => row.join(","))
  ].join("\n");
}
