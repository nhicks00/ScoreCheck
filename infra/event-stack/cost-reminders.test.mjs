import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCostReminders, runCostReminderCycle } from "./cost-reminders.mjs";

const manifest = { event: "event-test" };

test("does not warn while coverage is live", () => {
  assert.deepEqual(evaluateCostReminders({
    manifest,
    lifecycle: lifecycle("live"),
    droplets: Array.from({ length: 12 }, (_, id) => ({ id })),
    snapshot: snapshot(8),
    now: new Date("2026-08-02T12:00:00Z")
  }), []);
});

test("reports active output and billed compute after coverage closes", () => {
  const findings = evaluateCostReminders({
    manifest,
    lifecycle: lifecycle("closed", { closedAt: "2026-08-01T22:00:00Z" }),
    droplets: Array.from({ length: 12 }, (_, id) => ({ id })),
    snapshot: snapshot(3),
    now: new Date("2026-08-02T12:00:00Z")
  });
  assert.deepEqual(findings.map((entry) => entry.key), [
    "egress-after-close",
    "compute-one-hour-after-close",
    "compute-next-morning"
  ]);
  assert.match(findings[0].message, /3 stream outputs/);
});

test("warns when terminal lifecycle still has event compute", () => {
  const findings = evaluateCostReminders({
    manifest,
    lifecycle: lifecycle("destroyed"),
    droplets: [{ id: "unexpected" }],
    snapshot: null,
    now: new Date("2026-08-02T12:00:00Z")
  });
  assert.deepEqual(findings.map((entry) => entry.key), ["terminal-provider-nonzero"]);
});

test("deduplicates reminders for six hours and clears resolved keys", async () => {
  const messages = [];
  const notifier = { send: async (message) => messages.push(message) };
  const closed = lifecycle("closed", { closedAt: "2026-08-01T22:00:00Z" });
  const first = await runCostReminderCycle({
    manifest,
    lifecycle: closed,
    droplets: [{ id: "one" }],
    snapshot: snapshot(1),
    delivery: { schemaVersion: 1, event: manifest.event, checkedAt: null, notifications: {} },
    notifier,
    now: new Date("2026-08-02T00:00:00Z")
  });
  assert.equal(first.sent, 2);
  const second = await runCostReminderCycle({
    manifest,
    lifecycle: closed,
    droplets: [{ id: "one" }],
    snapshot: snapshot(1),
    delivery: first.delivery,
    notifier,
    now: new Date("2026-08-02T01:00:00Z")
  });
  assert.equal(second.sent, 0);
  const cleared = await runCostReminderCycle({
    manifest,
    lifecycle: lifecycle("destroyed"),
    droplets: [],
    snapshot: snapshot(0),
    delivery: second.delivery,
    notifier,
    now: new Date("2026-08-02T02:00:00Z")
  });
  assert.equal(cleared.sent, 0);
  assert.deepEqual(cleared.delivery.notifications, {});
  assert.equal(messages.length, 2);
});

function lifecycle(phase, coverage = null) {
  return {
    phase,
    createdAt: "2026-08-01T08:00:00Z",
    coverage: coverage ? { startedAt: "2026-08-01T12:00:00Z", closedAt: coverage.closedAt } : null
  };
}

function snapshot(activeWebRequests) {
  return {
    agents: [{ nativeServices: { egress: { activeWebRequests } } }]
  };
}
