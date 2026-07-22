import assert from "node:assert/strict";
import test from "node:test";

import { dependencyModeForCommand, materialModeForCommand, validateConfirmation, validateRehearsalProfile } from "./rehearsal-stack.mjs";

const profile = {
  schemaVersion: 2,
  manifest: "/protected/rehearsal/manifest.json",
  lifecycleState: "/protected/rehearsal/lifecycle-state.json",
  rehearsalState: "/protected/rehearsal/rehearsal-state.json",
  secrets: "/protected/rehearsal/secrets",
  material: "/protected/rehearsal/material.json",
  rehearsalEvidence: "/protected/rehearsal/evidence",
  credentialsEnv: "/protected/provider.env",
  sshKey: "/protected/scorecheck_do",
  knownHosts: "/protected/rehearsal/known_hosts",
  venueProfile: "/protected/rehearsal/venue-profile.json",
  ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  git: { repo: "nhicks00/ScoreCheck", repoId: 123, ref: "main", sha: "a".repeat(40) },
  soakDurationSeconds: 1_800
};

test("accepts only an exact protected rehearsal profile", () => {
  assert.equal(validateRehearsalProfile(profile), profile);
  assert.throws(() => validateRehearsalProfile({ ...profile, soakDurationSeconds: 300 }), /1800/);
  assert.throws(() => validateRehearsalProfile({ ...profile, extra: true }), /exactly/);
  assert.throws(() => validateRehearsalProfile({ ...profile, sshKey: "relative" }), /absolute/);
});

test("requires exact confirmations only for provider or workload mutations", () => {
  assert.doesNotThrow(() => validateConfirmation("prepare", "PREPARE:event", "event"));
  assert.doesNotThrow(() => validateConfirmation("start", "START-REHEARSAL:event", "event"));
  assert.doesNotThrow(() => validateConfirmation("cleanup", "CLEANUP:event", "event"));
  assert.throws(() => validateConfirmation("prepare", "yes", "event"), /exactly/);
  assert.throws(() => validateConfirmation("stop", "yes", "event"), /does not accept/);
});

test("creates secret material only during prepare and never as a side effect of inspection or cleanup", () => {
  assert.equal(materialModeForCommand("prepare"), "create-or-load");
  for (const command of ["start", "soak", "stop"]) assert.equal(materialModeForCommand(command), "load");
  for (const command of ["plan", "status", "cleanup", "seal"]) assert.equal(materialModeForCommand(command), "none");
  assert.throws(() => materialModeForCommand("unknown"), /unsupported/);
});

test("does not resolve host-bound runtime dependencies before provider provisioning", () => {
  for (const command of ["plan", "status", "seal"]) assert.equal(dependencyModeForCommand(command), "inert");
  assert.equal(dependencyModeForCommand("prepare"), "prepare");
  assert.equal(dependencyModeForCommand("cleanup"), "cleanup");
  for (const command of ["start", "soak", "stop"]) assert.equal(dependencyModeForCommand(command), "runtime");
  assert.throws(() => dependencyModeForCommand("unknown"), /unsupported/);
});
