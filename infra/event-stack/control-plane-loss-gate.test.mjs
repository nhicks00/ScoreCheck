import assert from "node:assert/strict";
import test from "node:test";

import { coldBrowserProblems, healthySnapshotProblems, parseArgs } from "./control-plane-loss-gate.mjs";

const now = new Date().toISOString();
const owner = {
  destinationId: "broadcast-5",
  egressId: "EG_camera5",
  rendererGitSha: "a".repeat(40)
};

test("accepts a fresh, exact Camera 5 control-plane baseline", () => {
  assert.deepEqual(healthySnapshotProblems(snapshot(), { camera: 5, owner, requireControlPlane: true }), []);
  const degraded = snapshot();
  degraded.courts[0].browser.scoreRender.stale = true;
  assert.match(healthySnapshotProblems(degraded, { camera: 5, owner, requireControlPlane: true }).join("; "), /control plane is not current/u);
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
