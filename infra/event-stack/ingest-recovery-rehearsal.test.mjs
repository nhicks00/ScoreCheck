import assert from "node:assert/strict";
import test from "node:test";

import { IngestRecoveryFaultRuntime, injectCommand, inspectCommand, restoreCommand } from "./ingest-recovery-fault-runtime.mjs";
import { evaluateIngestRecoveryRehearsal, parseArgs as parseRehearsalArgs, restorePrimaryAfterFailedRehearsal } from "./ingest-recovery-rehearsal.mjs";
import { parseArgs as parsePublisherArgs, validatePublisherState } from "./production-synthetic-publishers.mjs";

test("production synthetic publisher CLI requires protected paths and exact confirmations", () => {
  const start = parsePublisherArgs([
    "start",
    "--profile", "/tmp/profile.json",
    "--state", "/tmp/publishers.json",
    "--evidence", "/tmp/evidence",
    "--runtime", "/tmp/runtime",
    "--ffmpeg", "/tmp/ffmpeg",
    "--confirm", "START-SYNTHETIC-PUBLISHERS:event"
  ]);
  assert.equal(start.command, "start");
  assert.equal(start.confirm, "START-SYNTHETIC-PUBLISHERS:event");
  assert.throws(() => parsePublisherArgs(["status", "--profile", "/tmp/profile.json", "--state", "/tmp/publishers.json", "--confirm", "x"]), /does not accept/u);
  assert.throws(() => parsePublisherArgs(["start", "--profile", "relative", "--state", "/tmp/state"]), /normalized absolute path/u);
});

test("production synthetic publisher state contains eight redacted publisher identities", () => {
  const state = publisherState();
  assert.equal(validatePublisherState(state), state);
  delete state.publishers[8];
  assert.throws(() => validatePublisherState(state), /inventory is incomplete/u);
});

test("primary ingest fault runtime owns only its exact marker and converges through restore", async () => {
  let status = "HEALTHY";
  const commands = [];
  const runner = async (_command, args) => {
    const remote = args.at(-1);
    commands.push(remote);
    if (remote.includes("docker compose stop")) status = "FAULTED";
    else if (remote.includes("docker compose up")) status = "HEALTHY";
    return { stdout: `${status}\n`, stderr: "" };
  };
  const runtime = new IngestRecoveryFaultRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known_hosts", runner });
  const input = { host: "198.51.100.10", event: "event-test", recoveryId: "recovery-1234" };
  const fault = await runtime.inject({ ...input, confirmation: "FAULT-PRIMARY-INGEST:event-test" });
  assert.equal(fault.status, "FAULTED");
  const restored = await runtime.restore({ ...input, confirmation: "RESTORE-PRIMARY-INGEST:event-test" });
  assert.equal(restored.status, "HEALTHY");
  assert.ok(commands.some((command) => command.includes("docker compose stop caddy mediamtx")));
  assert.ok(commands.some((command) => command.includes("docker compose up -d mediamtx caddy")));
  await assert.rejects(() => runtime.inject({ ...input, confirmation: "yes" }), /exactly FAULT-PRIMARY/u);
});

test("primary ingest fault resumes an exact partially applied owned fault", async () => {
  let status = "MARKED_RUNNING";
  const commands = [];
  const runner = async (_command, args) => {
    const remote = args.at(-1);
    commands.push(remote);
    if (remote.includes("docker compose stop")) status = "FAULTED";
    return { stdout: `${status}\n`, stderr: "" };
  };
  const runtime = new IngestRecoveryFaultRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known_hosts", runner });
  const result = await runtime.inject({
    host: "198.51.100.10",
    event: "event-test",
    recoveryId: "recovery-1234",
    confirmation: "FAULT-PRIMARY-INGEST:event-test"
  });
  assert.equal(result.status, "FAULTED");
  assert.ok(commands.some((command) => command.includes("docker compose stop caddy mediamtx")));
});

test("fault commands are bounded to MediaMTX/Caddy and the exact owned marker", () => {
  const identity = "event-test:recovery-1234";
  assert.match(inspectCommand(identity), /\.scorecheck-ingest-recovery-rehearsal-fault/u);
  assert.match(injectCommand(identity), /docker compose stop caddy mediamtx/u);
  assert.match(injectCommand(identity), /test "\$\(cat "\$marker"\)" = "\$expected"/u);
  assert.doesNotMatch(injectCommand(identity), /systemctl|reboot|droplet/u);
  assert.match(restoreCommand(identity), /docker compose up -d mediamtx caddy/u);
});

test("recovery rehearsal CLI requires four separate destructive confirmations", () => {
  const args = parseRehearsalArgs([
    "run",
    "--profile", "/tmp/profile.json",
    "--destinations", "/tmp/destinations.json",
    "--soak-evidence", "/tmp/soak",
    "--publisher-state", "/tmp/publishers.json",
    "--recovery-state", "/tmp/recovery.json",
    "--evidence", "/tmp/evidence",
    "--confirm-fault", "FAULT-PRIMARY-INGEST:event-test",
    "--confirm-takeover", "TAKEOVER-INGEST:event-test",
    "--confirm-restore", "RESTORE-PRIMARY-INGEST:event-test",
    "--confirm-rollback", "ROLLBACK-INGEST:event-test"
  ]);
  assert.equal(args.command, "run");
  assert.throws(() => parseRehearsalArgs(["run", "--evidence", "/tmp/evidence"]), /--profile is required/u);
  assert.deepEqual(parseRehearsalArgs(["status", "--evidence", "/tmp/evidence"]).command, "status");
});

test("recovery evidence passes only after bounded takeover and rollback with healthy endpoints", () => {
  const input = evidenceInput();
  const report = evaluateIngestRecoveryRehearsal(input);
  assert.equal(report.classification, "PASS");
  assert.equal(report.takeover.rtoMs, 120_000);
  assert.equal(report.rollback.rtoMs, 90_000);

  const slow = evidenceInput();
  slow.recovery.timeline.find((entry) => entry.event === "takeover-qualified").at = "2026-07-22T12:10:01Z";
  const failed = evaluateIngestRecoveryRehearsal(slow);
  assert.equal(failed.classification, "FAIL");
  assert.ok(failed.problems.some((problem) => problem.includes("takeover RTO")));
});

test("failure safety recovery resumes takeover before restoring the primary and rolling back", async () => {
  let state = evidenceInput().recovery;
  state.phase = "FAILED";
  state.resumePhase = "TAKING_OVER";
  state.activeHost = "primary";
  const calls = [];
  const recoveryStore = {
    load: async () => state,
    withLock: async (operation) => operation()
  };
  const controller = {
    takeover: async ({ state: input, confirmation }) => {
      calls.push(["takeover", confirmation]);
      state = { ...input, phase: "ACTIVE_ON_SPARE", resumePhase: null, activeHost: "spare" };
      return state;
    },
    rollback: async ({ state: input, confirmation }) => {
      calls.push(["rollback", confirmation]);
      state = { ...input, phase: "ROLLED_BACK", activeHost: "primary" };
      return state;
    }
  };
  const fault = {
    restore: async ({ confirmation }) => {
      calls.push(["restore", confirmation]);
      return { status: "HEALTHY" };
    }
  };
  const result = await restorePrimaryAfterFailedRehearsal({
    recoveryStore,
    controller,
    fault,
    manifest: { event: "event-test" },
    options: {
      confirmTakeover: "TAKEOVER-INGEST:event-test",
      confirmRestore: "RESTORE-PRIMARY-INGEST:event-test",
      confirmRollback: "ROLLBACK-INGEST:event-test"
    }
  });
  assert.equal(result.passed, true);
  assert.equal(result.state.phase, "ROLLED_BACK");
  assert.deepEqual(calls.map(([name]) => name), ["takeover", "restore", "rollback"]);
});

test("failure safety recovery restores a partially faulted primary before takeover", async () => {
  const state = { ...evidenceInput().recovery, phase: "PREPARED", resumePhase: null };
  const calls = [];
  const result = await restorePrimaryAfterFailedRehearsal({
    recoveryStore: { load: async () => state, withLock: async (operation) => operation() },
    controller: {},
    fault: {
      restore: async () => {
        calls.push("restore");
        return { status: "HEALTHY" };
      }
    },
    manifest: { event: "event-test" },
    options: { confirmRestore: "RESTORE-PRIMARY-INGEST:event-test" }
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.actions, ["primary-services-restored"]);
  assert.deepEqual(calls, ["restore"]);
});

function publisherState() {
  return {
    schemaVersion: 1,
    event: "event-test",
    generationId: "generation-1234",
    phase: "RUNNING",
    profile: "/tmp/profile.json",
    evidenceDirectory: "/tmp/evidence",
    runtimeDirectory: "/tmp/runtime",
    ffmpegPath: "/tmp/ffmpeg",
    startedAt: "2026-07-22T12:00:00Z",
    stoppedAt: null,
    publishers: Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
      const court = index + 1;
      return [court, {
        court,
        marker: `scorecheck-rehearsal-generation-1234-camera-${court}`,
        protocol: court <= 2 ? "RTMP" : "SRT",
        status: "running",
        progressPath: `/tmp/evidence/camera-${court}.progress`,
        logPath: `/tmp/evidence/camera-${court}.log`,
        supervisorConfigPath: `/tmp/runtime/camera-${court}.json`,
        supervisorStatusPath: `/tmp/evidence/camera-${court}.status.json`
      }];
    }))
  };
}

function evidenceInput() {
  const topology = {
    primary: host("ingest", "1", "198.51.100.1", "10.120.0.1"),
    spare: host("spare", "2", "198.51.100.2", "10.120.0.2"),
    observability: host("monitor", "3", "198.51.100.3", "10.120.0.3"),
    compositors: Array.from({ length: 8 }, (_, index) => ({ ...host(`compositor-${index + 1}`, String(index + 10), `198.51.100.${index + 10}`, `10.120.0.${index + 10}`), cameraNumber: index + 1 })),
    reservedIpv4: "198.51.100.200",
    ingestHostname: "preview.example.com",
    vpcCidr: "10.120.0.0/20",
    ingestFirewallTag: "scorecheck-ingest"
  };
  const outputGenerations = Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
    const court = index + 1;
    return [court, {
      schemaVersion: 1,
      court,
      event: "event-test",
      destinationId: `broadcast-${court}`,
      outputGeneration: "generation-1234",
      outputProfile: "1080p30",
      rendererGitSha: "a".repeat(40),
      rendererDeploymentId: "dpl_renderer123",
      egressId: `EG_output${court}`,
      requestSha256: "b".repeat(64),
      startedAt: "2026-07-22T11:55:00Z"
    }];
  }));
  return {
    manifest: { kind: "production", event: "event-test" },
    lifecycleState: { event: "event-test", generationId: "generation-1234" },
    recovery: {
      schemaVersion: 3,
      event: "event-test",
      recoveryId: "recovery-1234",
      phase: "ROLLED_BACK",
      startedAt: "2026-07-22T11:58:00Z",
      preparedAt: "2026-07-22T11:59:00Z",
      updatedAt: "2026-07-22T12:05:30Z",
      topology,
      outputGenerations,
      activeHost: "primary",
      resumePhase: null,
      failure: null,
      timeline: [
        { at: "2026-07-22T11:58:00Z", event: "spare-ingest-staging-started" },
        { at: "2026-07-22T12:02:00Z", event: "takeover-qualified" },
        { at: "2026-07-22T12:05:30Z", event: "rollback-qualified" }
      ]
    },
    faultStartedAt: "2026-07-22T12:00:00Z",
    faultEvidence: { status: "FAULTED" },
    restoreStartedAt: "2026-07-22T12:04:00Z",
    restoreEvidence: { status: "HEALTHY" },
    baseline: { label: "baseline", passed: true },
    activeOnSpare: { label: "active-on-spare", passed: true },
    rolledBack: { label: "rolled-back", passed: true },
    baselinePublisherHealth: { passed: true },
    finalPublisherHealth: { passed: true },
    completedAt: "2026-07-22T12:06:00Z"
  };
}

function host(name, dropletId, publicIpv4, privateIpv4) {
  return { name, providerName: name, dropletId, publicIpv4, privateIpv4 };
}
