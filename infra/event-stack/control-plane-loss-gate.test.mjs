import assert from "node:assert/strict";
import test from "node:test";

import {
  browserQualityCountersStable,
  coldBrowserProblems,
  healthySnapshotProblems,
  NORMAL_LATENCY_VIEWER_WARMUP_MS,
  parseArgs,
  VIEWER_MARKERS,
  warmViewerSession
} from "./control-plane-loss-gate.mjs";

const now = new Date().toISOString();
const owner = {
  destinationId: "broadcast-5",
  egressId: "EG_camera5",
  rendererGitSha: "a".repeat(40)
};

test("accepts a fresh, exact Camera 5 control-plane baseline", () => {
  assert.deepEqual(healthySnapshotProblems(snapshot(), { camera: 5, owner, requireControlPlane: true }), []);
  const settledStartup = snapshot();
  settledStartup.courts[0].browser.video.framesDropped = 1;
  assert.deepEqual(healthySnapshotProblems(settledStartup, { camera: 5, owner, requireControlPlane: true }), []);
  const degraded = snapshot();
  degraded.courts[0].browser.scoreRender.stale = true;
  assert.match(healthySnapshotProblems(degraded, { camera: 5, owner, requireControlPlane: true }).join("; "), /control plane is not current/u);
});

test("requires browser quality counters to remain reset-safe and unchanged", () => {
  const before = snapshot().courts[0].browser;
  before.video.framesDropped = 1;
  const stable = structuredClone(before);
  const growing = structuredClone(before);
  growing.video.freezeCount += 1;

  assert.equal(browserQualityCountersStable(before, stable), true);
  assert.equal(browserQualityCountersStable(before, growing), false);
  stable.video.framesDropped = -1;
  assert.match(healthySnapshotProblems(snapshotWithBrowser(stable), { camera: 5, owner, requireControlPlane: true }).join("; "), /browser is not fresh/u);
});

test("accepts a cold local-renderer browser only with cached score continuity", () => {
  const baseline = snapshot();
  const cold = snapshot({ credentialId: "cold-browser", pageLoadedAt: "2026-07-29T10:01:00Z", connected: false, stale: true });
  assert.deepEqual(coldBrowserProblems(cold, { camera: 5, baseline, owner }), []);
  cold.courts[0].browser.scoreRender.renderedSignature = "changed";
  assert.match(coldBrowserProblems(cold, { camera: 5, baseline, owner }).join("; "), /last-good score/u);
});

test("requires normalized protected paths and exact run arguments", () => {
  assert.deepEqual(parseArgs([
    "run",
    "--profile", "/tmp/event-profile.json",
    "--evidence", "/tmp/evidence",
    "--camera", "5",
    "--confirm", "CONTROL-PLANE-LOSS:event:CAMERA-5"
  ]), {
    command: "run",
    profile: "/tmp/event-profile.json",
    evidence: "/tmp/evidence",
    camera: 5,
    confirm: "CONTROL-PLANE-LOSS:event:CAMERA-5"
  });
  assert.throws(() => parseArgs(["run", "--profile", "relative.json", "--evidence", "/tmp/evidence", "--camera", "5", "--confirm", "x"]), /normalized absolute path/u);
});

test("warms a normal-latency viewer before the control-plane fault", async () => {
  const actions = [];
  await warmViewerSession({ mark: async (marker) => actions.push(["mark", marker]) }, async (durationMs) => actions.push(["sleep", durationMs]));

  assert.equal(NORMAL_LATENCY_VIEWER_WARMUP_MS, 90_000);
  assert.deepEqual(actions, [["sleep", 90_000], ["mark", "viewer-buffered"]]);
  assert.ok(VIEWER_MARKERS.indexOf("viewer-buffered") < VIEWER_MARKERS.indexOf("control-plane-faulted"));
});

function snapshot({ credentialId = "baseline-browser", pageLoadedAt = "2026-07-29T10:00:00Z", connected = true, stale = false } = {}) {
  const browser = {
    receivedAt: now,
    credentialId,
    pageLoadedAt,
    pageBuildVersion: owner.rendererGitSha,
    configurationVersion: "config-v1",
    video: {
      state: "playing",
      connectionState: "connected",
      transport: "hls",
      framesDropped: 0,
      freezeCount: 0,
      totalFreezesDurationMs: 0,
      hlsActiveInstances: 1
    },
    scoreRender: { loaded: true, connected, stale, renderedSignature: "score-1" }
  };
  return {
    version: 6,
    generatedAt: now,
    collector: { state: "HEALTHY", agentsFresh: 12, agentsExpected: 12 },
    incidents: [],
    faultGates: [],
    agents: [{
      agentId: "compositor-a",
      state: "HEALTHY",
      nativeServices: { egress: { activeWebRequests: 1, maximumWebRequests: 1 } },
      egressSupervisor: { status: "HEALTHY", egressId: owner.egressId }
    }],
    courts: [
      {
        courtNumber: 5,
        overallState: "HEALTHY",
        egressHost: "compositor-a",
        paths: {
          raw: { ready: true, frameErrors: 0, inboundBitrateBps: 3_000_000, readerCount: 2 },
          program: { ready: true, frameErrors: 0, inboundBitrateBps: 3_000_000, readerCount: 2 }
        },
        browser,
        youtube: {
          videoId: owner.destinationId,
          streamStatus: "active",
          healthStatus: "good",
          broadcastLifecycle: "live",
          configurationIssues: []
        }
      },
      { courtNumber: 1, overallState: "HEALTHY" },
      { courtNumber: 2, overallState: "EXPECTED_OFF" },
      { courtNumber: 3, overallState: "HEALTHY" },
      { courtNumber: 4, overallState: "HEALTHY" },
      { courtNumber: 6, overallState: "HEALTHY" },
      { courtNumber: 7, overallState: "EXPECTED_OFF" },
      { courtNumber: 8, overallState: "EXPECTED_OFF" }
    ]
  };
}

function snapshotWithBrowser(browser) {
  const value = snapshot();
  value.courts[0].browser = browser;
  return value;
}
