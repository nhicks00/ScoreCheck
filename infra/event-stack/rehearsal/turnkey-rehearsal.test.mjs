import assert from "node:assert/strict";
import test from "node:test";

import { buildRecoveryPlan, buildRunPlan } from "./turnkey-rehearsal.mjs";

test("runs the exact build, workload, provider cleanup, evidence, and Droplet teardown order", () => {
  const commands = buildRunPlan({ event: "test", eventProfile: "/event.json", rehearsalProfile: "/rehearsal.json" }).map((step) => `${step.system}:${step.command}`);
  assert.deepEqual(commands, [
    "lifecycle:plan", "rehearsal:plan", "rehearsal:prepare", "lifecycle:up", "lifecycle:start",
    "rehearsal:start", "rehearsal:soak", "rehearsal:stop", "lifecycle:close", "rehearsal:cleanup",
    "rehearsal:seal", "lifecycle:evidence", "lifecycle:destroy"
  ]);
  assert.ok(commands.indexOf("rehearsal:cleanup") < commands.indexOf("lifecycle:destroy"));
});

test("failed startup stops workload and cleans provider resources before infrastructure abort", () => {
  const commands = buildRecoveryPlan({ event: "test", eventProfile: "/event.json", rehearsalProfile: "/rehearsal.json", lifecyclePhase: "ready", rehearsalPhase: "starting" }).map((step) => `${step.system}:${step.command}`);
  assert.deepEqual(commands, ["rehearsal:stop", "rehearsal:cleanup", "rehearsal:seal", "lifecycle:abort"]);
});

test("failed live gate completes provider cleanup and evidence before infrastructure destroy", () => {
  const commands = buildRecoveryPlan({ event: "test", eventProfile: "/event.json", rehearsalProfile: "/rehearsal.json", lifecyclePhase: "live", rehearsalPhase: "running" }).map((step) => `${step.system}:${step.command}`);
  assert.deepEqual(commands, ["rehearsal:stop", "lifecycle:close", "rehearsal:cleanup", "rehearsal:seal", "lifecycle:evidence", "lifecycle:destroy"]);
});

test("recovery resumes an interrupted infrastructure destroy instead of abandoning billed resources", () => {
  const commands = buildRecoveryPlan({ event: "test", eventProfile: "/event.json", rehearsalProfile: "/rehearsal.json", lifecyclePhase: "destroying", rehearsalPhase: "cleaned" }).map((step) => `${step.system}:${step.command}`);
  assert.deepEqual(commands, ["rehearsal:seal", "lifecycle:destroy"]);
});

test("recovery creates cancellable rehearsal evidence when failure precedes rehearsal state", () => {
  const commands = buildRecoveryPlan({ event: "test", eventProfile: "/event.json", rehearsalProfile: "/rehearsal.json", lifecyclePhase: "planned", rehearsalPhase: null }).map((step) => `${step.system}:${step.command}`);
  assert.deepEqual(commands, ["rehearsal:plan", "rehearsal:cleanup", "rehearsal:seal", "lifecycle:abort"]);
});
