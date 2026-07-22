import assert from "node:assert/strict";
import test from "node:test";

import { initialProgramSupervisor, programSupervisorStep } from "./program-supervisor.mjs";

const startedMs = Date.parse("2026-07-22T00:00:00Z");

test("restarts only after six consecutive browser failures with healthy upstream", () => {
  let state = initialProgramSupervisor([1]);
  for (let index = 0; index < 5; index += 1) {
    const result = programSupervisorStep(state, snapshot({ browser: null }), [1], startedMs + index * 5_000);
    state = result.state;
    assert.deepEqual(result.actions, []);
  }
  const result = programSupervisorStep(state, snapshot({ browser: null }), [1], startedMs + 25_000);
  assert.deepEqual(result.actions, [{ type: "restart", camera: 1, attempt: 1, reason: "upstream healthy while the program browser remained unavailable" }]);
  assert.equal(result.state.cameras[1].restartCount, 1);
});

test("never restarts for source, program-path, Egress, or monitor dependency loss", () => {
  for (const override of [{ rawReady: false }, { programReady: false }, { egressActive: false }, { agentHealthy: false }]) {
    let state = initialProgramSupervisor([1]);
    for (let index = 0; index < 12; index += 1) state = programSupervisorStep(state, snapshot({ browser: null, ...override }), [1], startedMs + index * 5_000).state;
    assert.equal(state.cameras[1].restartCount, 0);
    assert.equal(state.cameras[1].consecutiveFailures, 0);
  }
});

test("enforces cooldown and permanently exhausts after two attempts", () => {
  let state = initialProgramSupervisor([1]);
  const failSix = (at) => {
    const actions = [];
    for (let index = 0; index < 6; index += 1) {
      const result = programSupervisorStep(state, snapshot({ browser: null }), [1], at + index * 5_000);
      state = result.state;
      actions.push(...result.actions);
    }
    return actions;
  };
  assert.equal(failSix(startedMs)[0].attempt, 1);
  assert.deepEqual(failSix(startedMs + 60_000), []);
  assert.equal(failSix(startedMs + 11 * 60_000)[0].attempt, 2);
  const exhausted = failSix(startedMs + 22 * 60_000);
  assert.deepEqual(exhausted, [{ type: "exhausted", camera: 1, reason: "bounded restart limit reached" }]);
  assert.deepEqual(programSupervisorStep(state, snapshot({ browser: null }), [1], startedMs + 23 * 60_000).actions, []);
});

test("healthy browser progress resets the consecutive failure count", () => {
  let state = initialProgramSupervisor([1]);
  for (let index = 0; index < 4; index += 1) state = programSupervisorStep(state, snapshot({ browser: null }), [1], startedMs + index * 5_000).state;
  state = programSupervisorStep(state, snapshot(), [1], startedMs + 20_000).state;
  assert.equal(state.cameras[1].consecutiveFailures, 0);
});

function snapshot({ browser = healthyBrowser(), rawReady = true, programReady = true, egressActive = true, agentHealthy = true } = {}) {
  return {
    courts: [{
      courtNumber: 1,
      paths: {
        raw: { ready: rawReady, frameErrors: 0 },
        program: { ready: programReady, frameErrors: 0 }
      },
      browser
    }],
    agents: [{
      role: "compositor",
      assignedCourts: [1],
      state: agentHealthy ? "HEALTHY" : "MISSING",
      nativeServices: { egress: { idle: !egressActive, activeWebRequests: egressActive ? 1 : 0 } }
    }]
  };
}

function healthyBrowser() {
  return {
    receivedAt: new Date(startedMs + 20_000).toISOString(),
    video: { state: "playing", connectionState: "connected", transport: "whep" }
  };
}
