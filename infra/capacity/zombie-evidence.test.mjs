import assert from "node:assert/strict";
import test from "node:test";

import { parseZombieEventLine, parseZombieEventsNdjson, summarizeZombieEvents } from "./zombie-evidence.mjs";

const START = Date.parse("2026-07-15T00:00:10Z") / 1_000;
const END = Date.parse("2026-07-15T00:00:20Z") / 1_000;

test("preserves a pre-window unclassified baseline and bounds observer churn", () => {
  const events = baseEvents();
  events.push(open("ingest", 1, "100:10", "timeout", "bash", "unclassified", true));
  events.push(open("ingest", 12, "200:20", "sshd", "sshd", "observer.capacity-ssh", false));
  events.push(close("ingest", 12.2, "200:20", "observer.capacity-ssh", 200));
  const summary = summarize(events);

  assert.equal(summary.roles.ingest.baselineUnclassifiedCount, 1);
  assert.equal(summary.roles.ingest.baselineUnclassifiedEvents[0].command, "timeout");
  assert.equal(summary.roles.ingest.newUnclassifiedCount, 0);
  assert.equal(summary.roles.ingest.observerEventCount, 1);
  assert.equal(summary.roles.ingest.observerMaximumDurationMs, 200);
  assert.equal(summary.roles.ingest.observerMaximumRollingMinuteCount, 1);
  assert.equal(summary.roles.ingest.unclosedObserverCount, 0);
});

test("reports every new non-observer zombie with bounded attribution", () => {
  const events = baseEvents();
  events.push(open("compositor", 14, "300:30", "pactl", "chrome", "unclassified", false));
  events.push(close("compositor", 14.15, "300:30", "unclassified", 150));
  const summary = summarize(events);

  assert.equal(summary.roles.compositor.newUnclassifiedCount, 1);
  assert.deepEqual(summary.roles.compositor.newUnclassifiedEvents[0], {
    observedAt: iso(14),
    identity: "300:30",
    pid: 300,
    ppid: 2,
    command: "pactl",
    parentCommand: "chrome",
    executable: "pactl",
    commandFingerprint: "0123456789abcdef",
    cgroupFingerprint: "fedcba9876543210",
    classification: "unclassified"
  });
});

test("separately bounds exact Egress Chrome child lifecycle", () => {
  const events = baseEvents();
  events.push(open("compositor", 12, "310:31", "chrome", "chrome", "workload.egress-chrome", false));
  events.push(close("compositor", 12.1, "310:31", "workload.egress-chrome", 100));
  events.push(open("compositor", 13, "320:32", "chrome", "chrome", "workload.egress-chrome", false));
  events.push(close("compositor", 13.2, "320:32", "workload.egress-chrome", 200));
  const summary = summarize(events);

  assert.equal(summary.roles.compositor.newUnclassifiedCount, 0);
  assert.equal(summary.roles.compositor.observerEventCount, 0);
  assert.equal(summary.roles.compositor.workloadEventCount, 2);
  assert.deepEqual(summary.roles.compositor.workloadClassifications, { "workload.egress-chrome": 2 });
  assert.equal(summary.roles.compositor.workloadMaximumDurationMs, 200);
  assert.equal(summary.roles.compositor.workloadMaximumRollingMinuteCount, 2);
  assert.equal(summary.roles.compositor.workloadMaximumConcurrentCount, 1);
  assert.equal(summary.roles.compositor.unclosedWorkloadCount, 0);
});

test("includes observer zombies already active at the formal start", () => {
  const events = baseEvents();
  events.push(open("ingest", 8, "400:40", "sshd", "sshd", "observer.capacity-ssh", false));
  events.push(close("ingest", 12, "400:40", "observer.capacity-ssh", 4_000));
  const summary = summarize(events);

  assert.equal(summary.roles.ingest.observerEventCount, 0);
  assert.equal(summary.roles.ingest.observerMaximumDurationMs, 4_000);
  assert.equal(summary.roles.ingest.unclosedObserverCount, 0);
});

test("does not misclassify observation end as process reaping", () => {
  const events = baseEvents();
  events.push(open("compositor", 18, "500:50", "runc", "dockerd", "healthcheck.egress.runtime", false));
  events.push(endObservation("compositor", 22, "500:50", "healthcheck.egress.runtime", 4_000));
  const summary = summarize(events);

  assert.equal(summary.roles.compositor.observerMaximumDurationMs, 4_000);
  assert.equal(summary.roles.compositor.unclosedObserverCount, 1);
});

test("rejects malformed, unsafe, or over-broad event data", () => {
  const valid = open("ingest", 12, "600:60", "node", "runc", "healthcheck.monitor-agent", false);
  assert.equal(parseZombieEventLine(JSON.stringify(valid)).initialObservation, false);
  assert.throws(() => parseZombieEventLine(JSON.stringify({ ...valid, initialObservation: undefined })), /initialObservation/);
  assert.throws(() => parseZombieEventLine(JSON.stringify({ ...valid, classification: "healthcheck.generic" })), /classification/);
  assert.throws(() => parseZombieEventLine(JSON.stringify({ ...valid, command: "bad\nvalue" })), /command/);
  assert.throws(() => parseZombieEventsNdjson(JSON.stringify(valid)), /compositor watcher/);
});

test("validates aligned host samples without accepting partial success", () => {
  const sample = event("ingest", "host_sample", 15.05, {
    sampleSlotAt: iso(15),
    sampleLagMs: 50,
    sampleOk: true,
    cpuRatio: 0.25,
    shmRatio: 0
  });
  const parsed = parseZombieEventLine(JSON.stringify(sample));
  assert.equal(parsed.sampleSlotAt, iso(15));
  assert.equal(parsed.sampleLagMs, 50);
  assert.throws(() => parseZombieEventLine(JSON.stringify({ ...sample, sampleOk: true, cpuRatio: null })), /must contain/);
  assert.throws(() => parseZombieEventLine(JSON.stringify({ ...sample, sampleLagMs: 60_001 })), /sampleLagMs/);
});

function summarize(events) {
  const ordered = [...events].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const parsed = parseZombieEventsNdjson(ordered.map((event) => JSON.stringify(event)).join("\n"));
  return summarizeZombieEvents(parsed, { startEpochSeconds: START, endEpochSeconds: END });
}

function baseEvents() {
  return ["ingest", "compositor"].flatMap((role, roleIndex) => [
    event(role, "watcher_started", 0, { pollIntervalMs: 50, watcherPid: 900 + roleIndex }),
    ...[9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21].map((second, index) =>
      event(role, "heartbeat", second, { scanCount: index + 1, activeZombieCount: 0, maximumScanGapMs: 55 })
    )
  ]);
}

function open(role, second, identity, command, parentCommand, classification, initialObservation) {
  return event(role, "zombie_open", second, {
    identity,
    pid: Number(identity.split(":")[0]),
    ppid: 2,
    state: "Z",
    command,
    parentCommand,
    executable: command,
    commandFingerprint: "0123456789abcdef",
    cgroupFingerprint: "fedcba9876543210",
    classification,
    initialObservation
  });
}

function close(role, second, identity, classification, durationMs) {
  return event(role, "zombie_close", second, { identity, classification, durationMs });
}

function endObservation(role, second, identity, classification, durationMs) {
  return event(role, "zombie_observation_end", second, { identity, classification, durationMs });
}

function event(role, eventName, second, values) {
  return { schemaVersion: 1, role, event: eventName, observedAt: iso(second), ...values };
}

function iso(second) {
  return new Date(Date.parse("2026-07-15T00:00:00Z") + (second * 1_000)).toISOString();
}
