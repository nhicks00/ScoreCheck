import assert from "node:assert/strict";
import test from "node:test";

import { pairPoolHostSamples, parsePoolHostEventsNdjson, summarizePoolHost } from "./pool-host-evidence.mjs";

const START = Date.parse("2026-07-15T10:00:00Z") / 1_000;
const END = START + 10;

test("separates same-role compositor events by stable host identity", () => {
  const events = parsePoolHostEventsNdjson([
    started("compositor-a", "compositor", -10),
    heartbeat("compositor-a", "compositor", -6),
    sample("compositor-a", "compositor", -5, 0.1, 0.01),
    sample("compositor-a", "compositor", 0, 0.2, 0.1),
    heartbeat("compositor-a", "compositor", 1),
    sample("compositor-a", "compositor", 5, 0.3, 0.2),
    heartbeat("compositor-a", "compositor", 6),
    sample("compositor-a", "compositor", 10, 0.4, 0.3),
    heartbeat("compositor-a", "compositor", 11),
    started("compositor-b", "compositor", -10),
    heartbeat("compositor-b", "compositor", -6),
    sample("compositor-b", "compositor", -5, 0.1, 0.01),
    sample("compositor-b", "compositor", 0, 0.2, 0.1),
    heartbeat("compositor-b", "compositor", 1),
    sample("compositor-b", "compositor", 5, 0.2, 0.1),
    heartbeat("compositor-b", "compositor", 6),
    sample("compositor-b", "compositor", 10, 0.2, 0.1),
    heartbeat("compositor-b", "compositor", 11)
  ].join("\n"));
  const summary = summarizePoolHost(events, {
    hostId: "compositor-a",
    role: "compositor",
    startEpochSeconds: START,
    endEpochSeconds: END,
    stepSeconds: 5
  });
  assert.equal(summary.samples.validSamples, 3);
  assert.equal(summary.machineFingerprint, "aaaaaaaaaaaaaaaa");
  assert.equal(summary.samples.coverageRatio, 1);
  assert.equal(summary.samples.baselineAgeSeconds, 5);
  assert.equal(summary.samples.cpuMaxRatio, 0.4);
  assert.equal(summary.samples.shmMaxRatio, 0.3);
  assert.equal(summary.zombies.watcherRestarts, 0);
});

test("fails closed on duplicate slots, role drift, and missing hosts", () => {
  assert.throws(() => parsePoolHostEventsNdjson([
    sample("a", "compositor", 0, 0.2, 0.1),
    sample("a", "compositor", 0, 0.3, 0.2)
  ].join("\n")), /duplicate sample slot/);
  assert.throws(() => parsePoolHostEventsNdjson([
    started("a", "compositor", -1),
    heartbeat("a", "ingest", 0)
  ].join("\n")), /changed role/);
  const events = parsePoolHostEventsNdjson(started("a", "compositor", -1));
  assert.throws(() => summarizePoolHost(events, {
    hostId: "b", role: "compositor", startEpochSeconds: START, endEpochSeconds: END, stepSeconds: 5
  }), /no events/);
});

test("pairs ingest and compositor evidence using the weakest coverage and worst gaps", () => {
  const paired = pairPoolHostSamples({
    coverageRatio: 1, p95GapSeconds: 5, maxGapSeconds: 5, startEdgeGapSeconds: 0,
    endEdgeGapSeconds: 0, baselineAgeSeconds: 5, cpuP95Ratio: 0.5, cpuMaxRatio: 0.6,
    sampleLagP95Ms: 20, sampleLagMaxMs: 30, shmMaxRatio: 0
  }, {
    coverageRatio: 0.9, p95GapSeconds: 7, maxGapSeconds: 10, startEdgeGapSeconds: 2,
    endEdgeGapSeconds: 3, baselineAgeSeconds: 8, cpuP95Ratio: 0.6, cpuMaxRatio: 0.7,
    sampleLagP95Ms: 30, sampleLagMaxMs: 40, shmMaxRatio: 0.4
  });
  assert.equal(paired.coverageRatio, 0.9);
  assert.equal(paired.maxGapSeconds, 10);
  assert.equal(paired.baselineAgeSeconds, 8);
  assert.equal(paired.egressShmMaxRatio, 0.4);
});

function started(hostId, role, offsetSeconds) {
  const machineFingerprint = hostId.endsWith("a") ? "aaaaaaaaaaaaaaaa" : "bbbbbbbbbbbbbbbb";
  return row(hostId, role, "watcher_started", offsetSeconds, { pollIntervalMs: 50, watcherPid: 100, machineFingerprint });
}

function heartbeat(hostId, role, offsetSeconds) {
  return row(hostId, role, "heartbeat", offsetSeconds, { scanCount: 10, activeZombieCount: 0, maximumScanGapMs: 52 });
}

function sample(hostId, role, offsetSeconds, cpuRatio, shmRatio) {
  return row(hostId, role, "host_sample", offsetSeconds + 0.02, {
    sampleSlotAt: at(offsetSeconds), sampleLagMs: 20, sampleOk: true, cpuRatio, shmRatio
  });
}

function row(hostId, role, event, offsetSeconds, fields) {
  return JSON.stringify({ schemaVersion: 1, hostId, role, event, observedAt: at(offsetSeconds), ...fields });
}

function at(offsetSeconds) {
  return new Date((START + offsetSeconds) * 1_000).toISOString();
}
