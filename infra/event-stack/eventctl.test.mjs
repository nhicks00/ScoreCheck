import assert from "node:assert/strict";
import test from "node:test";

import { buildEventctlInvocation, validateProfile } from "./eventctl.mjs";

const profile = {
  schemaVersion: 2,
  manifest: "/protected/event/manifest.json",
  state: "/protected/event/state.json",
  anchors: "/protected/endpoint-anchors.json",
  secrets: "/protected/event/secrets",
  sshKey: "/protected/scorecheck_do",
  knownHosts: "/protected/event/known_hosts",
  credentialsEnv: "/protected/provider.env",
  lifecycleAttestation: "/protected/lifecycle-attestation.json",
  evidence: "/protected/event/evidence"
};

test("expands one operator profile into exact non-shell lifecycle arguments", () => {
  assert.deepEqual(buildEventctlInvocation("up", profile), [
    "up", "--manifest", profile.manifest, "--state", profile.state,
    "--anchors", profile.anchors, "--secrets", profile.secrets,
    "--ssh-key", profile.sshKey, "--known-hosts", profile.knownHosts,
    "--credentials-env", profile.credentialsEnv,
    "--attestation", profile.lifecycleAttestation
  ]);
  assert.deepEqual(buildEventctlInvocation("destroy", profile, "DESTROY:event"), [
    "destroy", "--manifest", profile.manifest, "--state", profile.state,
    "--credentials-env", profile.credentialsEnv, "--evidence", profile.evidence,
    "--confirm", "DESTROY:event"
  ]);
});

test("never invents destructive confirmations", () => {
  for (const command of ["start", "close", "destroy"]) {
    assert.throws(() => buildEventctlInvocation(command, profile), /explicit --confirm/);
  }
  assert.throws(() => buildEventctlInvocation("up", profile, "yes"), /does not accept/);
});

test("rejects relative, missing, and extra profile fields", () => {
  assert.equal(validateProfile(profile), profile);
  assert.throws(() => validateProfile({ ...profile, state: "state.json" }), /normalized absolute/);
  const missing = { ...profile };
  delete missing.anchors;
  assert.throws(() => validateProfile(missing), /exactly/);
  assert.throws(() => validateProfile({ ...profile, extra: "/tmp/value" }), /exactly/);
});
