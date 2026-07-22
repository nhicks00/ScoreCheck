import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, recoverySummary } from "./ingest-recoveryctl.mjs";

test("parses the exact protected operator contract for prepare and takeover", () => {
  const common = [
    "--manifest", "/protected/manifest.json",
    "--lifecycle-state", "/protected/lifecycle.json",
    "--anchors", "/protected/anchors.json",
    "--recovery-state", "/protected/recovery.json",
    "--secrets", "/protected/secrets",
    "--ssh-key", "/protected/ssh-key",
    "--known-hosts", "/protected/known-hosts",
    "--ingest-tls-state", "/protected/ingest-tls",
    "--credentials-env", "/protected/provider.env"
  ];
  assert.equal(parseArgs(["prepare", ...common]).command, "prepare");
  const takeover = parseArgs(["takeover", ...common, "--confirm", "TAKEOVER-INGEST:event-one"]);
  assert.equal(takeover.confirm, "TAKEOVER-INGEST:event-one");
  assert.throws(() => parseArgs(["takeover", ...common]), /--confirm is required/u);
  assert.throws(() => parseArgs(["prepare", ...common, "--confirm", "unused"]), /does not accept/u);
});

test("limits status to one protected state path and rejects ambiguous options", () => {
  assert.deepEqual(parseArgs(["status", "--recovery-state", "/protected/recovery.json"]), {
    command: "status",
    manifest: null,
    lifecycleState: null,
    anchors: null,
    recoveryState: "/protected/recovery.json",
    secrets: null,
    sshKey: null,
    knownHosts: null,
    ingestTlsState: null,
    credentialsEnv: null,
    confirm: null
  });
  assert.throws(() => parseArgs(["status", "--recovery-state", "/a", "--manifest", "/b"]), /status accepts only/u);
  assert.throws(() => parseArgs(["status", "--recovery-state", "/a", "--recovery-state", "/b"]), /only once/u);
  assert.throws(() => parseArgs(["status", "--recovery-state", "relative.json"]), /normalized absolute/u);
});

test("prints a sanitized recovery summary without topology or output destinations", () => {
  const value = recoverySummary({
    schemaVersion: 3,
    event: "event-one",
    recoveryId: "recovery-one",
    phase: "FAILED",
    activeHost: "primary",
    resumePhase: "TAKING_OVER",
    startedAt: "2026-07-22T12:00:00.000Z",
    preparedAt: "2026-07-22T12:01:00.000Z",
    updatedAt: "2026-07-22T12:02:00.000Z",
    failure: "bounded failure",
    timeline: [{ at: "2026-07-22T12:00:00.000Z", event: "takeover-started" }],
    topology: { reservedIpv4: "198.51.100.20" },
    outputGenerations: { 1: { destinationId: "secret-destination" } }
  });
  assert.equal(value.status, "FAILED");
  assert.deepEqual(value.completedSteps, ["takeover-started"]);
  assert.equal(Object.hasOwn(value, "topology"), false);
  assert.equal(JSON.stringify(value).includes("secret-destination"), false);
});
