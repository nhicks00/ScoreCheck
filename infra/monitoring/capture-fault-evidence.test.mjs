import assert from "node:assert/strict";
import test from "node:test";

import { evaluateEvidence, summarizeSnapshot } from "./capture-fault-evidence.mjs";

test("passes exact issue detection, recovery, and peer isolation", () => {
  const rows = [
    sample({ at: 0 }),
    sample({ at: 1_000, issueCode: "REQUIRED_RAW_PATH_MISSING", incident: true }),
    sample({ at: 2_000, issueCode: "REQUIRED_RAW_PATH_MISSING", incident: true }),
    sample({ at: 3_000 })
  ];
  const result = evaluateEvidence(rows, options({ expectedIssue: "REQUIRED_RAW_PATH_MISSING", requireRecovery: true }));
  assert.equal(result.status, "PASS");
  assert.equal(result.firstIssueAt, iso(1_000));
  assert.equal(result.recoveredAt, iso(3_000));
  assert.deepEqual(result.unexpectedIncidents, []);
});

test("fails when the expected issue is absent or does not recover", () => {
  const absent = evaluateEvidence([sample({ at: 0 }), sample({ at: 1_000 })], options({ expectedIssue: "CAMERA_CONTENT_BLACK" }));
  assert.equal(absent.status, "FAIL");
  assert.match(absent.reason, /not observed/);

  const persistent = evaluateEvidence([
    sample({ at: 0 }),
    sample({ at: 1_000, issueCode: "CAMERA_CONTENT_BLACK", incident: true }),
    sample({ at: 2_000, issueCode: "CAMERA_CONTENT_BLACK", incident: true })
  ], options({ expectedIssue: "CAMERA_CONTENT_BLACK", requireRecovery: true }));
  assert.equal(persistent.status, "FAIL");
  assert.match(persistent.reason, /did not recover/);
});

test("requires recovery after the final observed issue", () => {
  const result = evaluateEvidence([
    sample({ at: 0 }),
    sample({ at: 1_000, issueCode: "CAMERA_CONTENT_BLACK", incident: true }),
    sample({ at: 2_000 }),
    sample({ at: 3_000, issueCode: "CAMERA_CONTENT_BLACK", incident: true })
  ], options({ expectedIssue: "CAMERA_CONTENT_BLACK", requireRecovery: true }));
  assert.equal(result.status, "FAIL");
  assert.equal(result.recoveredAt, null);
});

test("fails an unexpected peer incident or new peer attention state", () => {
  const peerIncident = sample({ at: 1_000 });
  peerIncident.incidents.push(incident({ id: "peer", courtNumber: 2, issueCode: "REQUIRED_RAW_PATH_MISSING" }));
  const incidentResult = evaluateEvidence([sample({ at: 0 }), peerIncident], options());
  assert.equal(incidentResult.status, "FAIL");

  const peerState = sample({ at: 1_000 });
  peerState.peerCourts[0].overallState = "CRITICAL";
  const stateResult = evaluateEvidence([sample({ at: 0 }), peerState], options());
  assert.equal(stateResult.status, "FAIL");
});

test("allows an explicitly expected peer for a shared compositor fault", () => {
  const row = sample({ at: 1_000, issueCode: "EGRESS_WORKER_UNAVAILABLE", incident: true });
  row.incidents.push(incident({ id: "peer", courtNumber: 2, issueCode: "EGRESS_WORKER_UNAVAILABLE" }));
  row.peerCourts[0].overallState = "CRITICAL";
  const result = evaluateEvidence(
    [sample({ at: 0 }), row],
    options({ expectedIssue: "EGRESS_WORKER_UNAVAILABLE", allowedPeerCourts: [2] })
  );
  assert.equal(result.status, "PASS");
});

test("does not let an unrelated courtless incident satisfy a selected-camera issue", () => {
  const row = sample({ at: 1_000 });
  row.incidents.push(incident({ id: "shared", courtNumber: null, issueCode: "CAMERA_CONTENT_BLACK" }));
  const result = evaluateEvidence(
    [sample({ at: 0 }), row],
    options({ expectedIssue: "CAMERA_CONTENT_BLACK" })
  );
  assert.equal(result.status, "FAIL");
  assert.match(result.reason, /not observed/);
});

test("fails a new unapproved global or selected-camera incident", () => {
  for (const courtNumber of [null, 1]) {
    const row = sample({ at: 1_000 });
    row.incidents.push(incident({ id: `unexpected-${courtNumber}`, courtNumber, issueCode: "AGENT_MISSING" }));
    const result = evaluateEvidence([sample({ at: 0 }), row], options());
    assert.equal(result.status, "FAIL");
    assert.equal(result.unexpectedIncidents[0].issueCode, "AGENT_MISSING");
  }
});

test("invalidates a dirty baseline or collection failure", () => {
  const dirty = sample({ at: 0 });
  dirty.incidents.push(incident({ id: "existing", courtNumber: 1 }));
  assert.equal(evaluateEvidence([dirty], options()).status, "INVALID");

  const unhealthy = sample({ at: 1_000 });
  unhealthy.collector.agentsFresh = 5;
  assert.equal(evaluateEvidence([sample({ at: 0 }), unhealthy], options()).status, "INVALID");
  assert.equal(evaluateEvidence([{ kind: "error", code: "TIMEOUT" }], options()).status, "INVALID");
});

test("invalidates a baseline that is not ready for fault injection", () => {
  const degraded = sample({ at: 0 });
  degraded.court.overallState = "DEGRADED";
  assert.equal(evaluateEvidence([degraded], options()).status, "INVALID");

  const expectedOff = sample({ at: 0 });
  expectedOff.court.overallState = "EXPECTED_OFF";
  const result = evaluateEvidence([expectedOff], options({ expectedIssue: "REQUIRED_RAW_PATH_MISSING" }));
  assert.equal(result.status, "INVALID");
  assert.match(result.reason, /not healthy before fault injection/);
});

test("invalidates notification or dead-man health loss", () => {
  const notificationFailure = sample({ at: 1_000 });
  notificationFailure.notifications.state = "DEGRADED";
  assert.equal(evaluateEvidence([sample({ at: 0 }), notificationFailure], options()).status, "INVALID");

  const deadManFailure = sample({ at: 1_000 });
  deadManFailure.deadMan.state = "DEGRADED";
  assert.equal(evaluateEvidence([sample({ at: 0 }), deadManFailure], options()).status, "INVALID");
});

test("invalidates stale snapshots even when the API request itself succeeds", () => {
  const stale = sample({ at: 1_000 });
  stale.snapshotAgeMs = 20_000;
  const result = evaluateEvidence([sample({ at: 0 }), stale], options());
  assert.equal(result.status, "INVALID");
  assert.equal(result.staleSnapshotSamples, 1);
});

test("records media and browser transitions without relying on counter monotonicity", () => {
  const baseline = sample({ at: 0 });
  const down = sample({ at: 1_000 });
  down.court.paths.raw.ready = false;
  down.court.paths.preview.ready = false;
  down.court.browser = null;
  const recovered = sample({ at: 2_000 });
  recovered.court.browser.reconnectCount = 4;
  const result = evaluateEvidence([baseline, down, recovered], options());
  assert.deepEqual(result.pathTransitions, [
    { branch: "raw", ready: false, at: iso(1_000) },
    { branch: "preview", ready: false, at: iso(1_000) },
    { branch: "raw", ready: true, at: iso(2_000) },
    { branch: "preview", ready: true, at: iso(2_000) }
  ]);
  assert.equal(result.browserTransitions.length, 3);
});

test("summarizes only the selected camera while preserving bounded peer state", () => {
  const snapshot = snapshotFixture();
  const result = summarizeSnapshot(snapshot, 1, {
    sequence: 0,
    requestedAt: iso(0),
    receivedAt: iso(50),
    requestLatencyMs: 50
  });
  assert.equal(result.court.courtNumber, 1);
  assert.deepEqual(result.peerCourts, [{ courtNumber: 2, overallState: "EXPECTED_OFF" }]);
  assert.equal(result.agents[0].agentId, "agent-1");
  assert.equal(result.snapshotAgeMs, 50);
});

test("rejects malformed snapshot timestamps", () => {
  const snapshot = snapshotFixture();
  snapshot.generatedAt = "not-a-timestamp";
  assert.throws(() => summarizeSnapshot(snapshot, 1, {
    sequence: 0,
    requestedAt: iso(0),
    receivedAt: iso(50),
    requestLatencyMs: 50
  }), /timestamps are invalid/);
});

function options(patch = {}) {
  return {
    courtNumber: 1,
    expectedIssue: null,
    requireRecovery: false,
    allowedPeerCourts: [],
    maxSnapshotAgeMs: 15_000,
    ...patch
  };
}

function sample({ at, issueCode = null, incident: withIncident = false }) {
  const snapshot = snapshotFixture();
  snapshot.generatedAt = iso(at);
  const court = snapshot.courts[0];
  court.stages[0].issueCode = issueCode;
  court.stages[0].state = issueCode ? "CRITICAL" : "HEALTHY";
  court.overallState = issueCode ? "CRITICAL" : "HEALTHY";
  if (withIncident) snapshot.incidents.push(incident({ issueCode }));
  return summarizeSnapshot(snapshot, 1, {
    sequence: at / 1_000,
    requestedAt: iso(at),
    receivedAt: iso(at),
    requestLatencyMs: 0
  });
}

function snapshotFixture() {
  return {
    generatedAt: iso(0),
    collector: { state: "HEALTHY", agentsExpected: 1, agentsFresh: 1 },
    event: null,
    notifications: { state: "HEALTHY" },
    deadMan: { state: "HEALTHY" },
    faultGates: [],
    incidents: [],
    courts: [court(1, "HEALTHY"), court(2, "EXPECTED_OFF")],
    agents: [{
      agentId: "agent-1",
      role: "mediamtx",
      assignedCourts: [],
      state: "HEALTHY",
      ageMs: 100,
      nativeServices: null
    }]
  };
}

function court(courtNumber, overallState) {
  return {
    courtNumber,
    overallState,
    stages: [{ stage: "RAW_INGEST", state: overallState, issueCode: null }],
    paths: {
      raw: { ready: overallState === "HEALTHY" },
      preview: { ready: overallState === "HEALTHY" },
      program: { ready: overallState === "HEALTHY" }
    },
    ffmpeg: {},
    browser: overallState === "HEALTHY" ? { state: "playing", pageLoadedAt: iso(0), reconnectCount: 0, reloadCount: 0 } : null,
    expectation: {},
    faultGate: null,
    youtube: null,
    thumbnail: null,
    egressHost: null
  };
}

function incident({ id = "incident-1", courtNumber = 1, issueCode = "REQUIRED_RAW_PATH_MISSING" } = {}) {
  return { id, courtNumber, issueCode, status: "open" };
}

function iso(offsetMs) {
  return new Date(Date.UTC(2026, 6, 15, 0, 0, 0, offsetMs)).toISOString();
}
