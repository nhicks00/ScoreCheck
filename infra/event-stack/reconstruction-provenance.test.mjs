import assert from "node:assert/strict";
import test from "node:test";

import { buildReconstructionCommand, sha256, validateReconstructionProvenance } from "./reconstruction-provenance.mjs";

const digest = sha256("config");
const spec = {
  name: "bvm-preview-01",
  providerName: "rehearsal-bvm-preview-01",
  cloudInitSha256: sha256("cloud-init")
};
const resource = { id: "123", publicIpv4: "198.51.100.10", privateIpv4: "10.120.0.10" };

function payload() {
  return {
    schemaVersion: 1,
    capturedAt: "2026-07-15T00:00:00Z",
    providerDropletId: "123",
    hostname: "rehearsal-bvm-preview-01",
    publicIpv4: "198.51.100.10",
    privateIpv4: "10.120.0.10",
    region: "sfo2",
    os: "Ubuntu 24.04",
    kernel: "6.8.0",
    dockerVersion: "28.0.0",
    composeVersion: "2.38.0",
    cloudInitSha256: spec.cloudInitSha256,
    ufw: { active: true, sha256: sha256("ufw") },
    configs: [{ path: "/opt/mediamtx/mediamtx.yml", sha256: digest, mode: 0o600, size: 10 }],
    containers: [{ name: "mediamtx", imageRef: "example@sha256:abc", imageId: `sha256:${"a".repeat(64)}`, state: "running", health: "healthy", restartCount: 0, startedAt: "now", revision: "" }]
  };
}

test("builds a non-secret remote reconstruction command", () => {
  const command = buildReconstructionCommand({ expectedConfigHashes: { "/opt/mediamtx/mediamtx.yml": digest } });
  assert.match(command, /^SCORECHECK_ATTESTATION_INPUT=[A-Za-z0-9+/=]+ python3/);
  assert.match(command, /metadata\/v1/);
  assert.doesNotMatch(command, /PUBLISH_PASS|AUTH_TOKEN|API_SECRET/);
});

test("accepts exact provider, bootstrap, network, config, firewall, and container evidence", () => {
  const result = validateReconstructionProvenance({
    payload: payload(), spec, resource, expectedConfigHashes: { "/opt/mediamtx/mediamtx.yml": digest }
  });
  assert.equal(result.providerDropletId, "123");
});

test("fails closed on identity, cloud-init, config, firewall, or image drift", () => {
  for (const mutate of [
    (value) => { value.providerDropletId = "999"; },
    (value) => { value.hostname = "wrong"; },
    (value) => { value.publicIpv4 = "198.51.100.99"; },
    (value) => { value.cloudInitSha256 = sha256("wrong"); },
    (value) => { value.ufw.active = false; },
    (value) => { value.configs[0].sha256 = sha256("wrong"); },
    (value) => { value.containers[0].imageId = "not-an-image"; }
  ]) {
    const changed = payload();
    mutate(changed);
    assert.throws(() => validateReconstructionProvenance({
      payload: changed, spec, resource, expectedConfigHashes: { "/opt/mediamtx/mediamtx.yml": digest }
    }), /reconstruction attestation/);
  }
});
