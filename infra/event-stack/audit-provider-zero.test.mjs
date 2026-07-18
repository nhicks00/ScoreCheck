import assert from "node:assert/strict";
import test from "node:test";

import { classifyProviderZero, parseArgs, validateAnchors } from "./audit-provider-zero.mjs";

function healthyInput() {
  return {
    event: "turnkey-zero-to-12-rehearsal-r56",
    account: { status: "active", dropletLimit: 15 },
    droplets: [],
    reservedIpv4: [
      { ip: "203.0.113.1", region: "sfo2", dropletId: null, locked: false },
      { ip: "203.0.113.2", region: "sfo2", dropletId: null, locked: false }
    ],
    expectedReservedIpv4: ["203.0.113.2", "203.0.113.1"],
    snapshots: [],
    tags: [{ name: "bvm-compositor" }, { name: "scorecheck-temporary" }],
    volumesResult: { readable: false, status: 403, items: [] },
    projects: [],
    dnsRecords: [],
    youtubePool: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, {
      court: index + 1,
      streamStatus: "inactive",
      healthStatus: "noData",
      configurationIssues: []
    }]))
  };
}

test("accepts only the complete zero-compute, zero-residue provider baseline", () => {
  const audit = classifyProviderZero(healthyInput());
  assert.equal(audit.pass, true);
  assert.equal(audit.checks.dropletsZero, true);
  assert.equal(audit.checks.youtubePoolExactIdle, true);
  assert.equal(audit.providerReadContracts.volumesReadable, false);
});

test("fails on any compute, event tag, snapshot, rehearsal control plane, active destination, or anchor drift", () => {
  const cases = [
    { droplets: [{ id: "1", name: "unexpected", status: "active", tags: [] }] },
    { tags: [{ name: "scorecheck-event:old" }] },
    { snapshots: [{ id: "1", name: "scorecheck-old" }] },
    { projects: [{ id: "p1", name: "scorecheck-rehearsal-old" }] },
    { dnsRecords: [{ id: "d1", name: "monitor-rehearsal", type: "A" }] },
    { reservedIpv4: [{ ip: "203.0.113.1", region: "sfo2", dropletId: "9", locked: false }, { ip: "203.0.113.2", region: "sfo2", dropletId: null, locked: false }] },
    { youtubePool: { ...healthyInput().youtubePool, 8: { ...healthyInput().youtubePool[8], streamStatus: "active" } } }
  ];
  for (const changed of cases) assert.equal(classifyProviderZero({ ...healthyInput(), ...changed }).pass, false);
});

test("validates exact protected CLI inputs and retained anchors", () => {
  assert.deepEqual(parseArgs([
    "--event", "turnkey-zero-to-12-rehearsal-r56",
    "--credentials-env", "/protected/provider.env",
    "--anchors", "/protected/anchors.json",
    "--zone", "example.com",
    "--output", "/protected/audit.json"
  ]), {
    event: "turnkey-zero-to-12-rehearsal-r56",
    credentialsEnv: "/protected/provider.env",
    anchors: "/protected/anchors.json",
    zone: "example.com",
    output: "/protected/audit.json"
  });
  assert.doesNotThrow(() => validateAnchors({
    schemaVersion: 2,
    provider: "digitalocean",
    retention: "persistent",
    status: "ready",
    reservedIpv4: { ingest: "203.0.113.1", commentary: "203.0.113.2" }
  }));
  assert.throws(() => validateAnchors({ schemaVersion: 2, reservedIpv4: {} }), /anchors are invalid/u);
});
