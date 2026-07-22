import assert from "node:assert/strict";
import test from "node:test";

import { evaluateSshSessionAudit, sshSessionAuditCommand } from "./ssh-session-audit.mjs";

test("builds a bounded read-only SSH journal query", () => {
  const command = sshSessionAuditCommand("2026-07-22T12:00:00Z", "2026-07-22T13:00:00Z");
  assert.match(command, /journalctl --quiet --unit=ssh\.service/u);
  assert.match(command, /--since=@1784721600 --until=@1784725200/u);
  assert.doesNotMatch(command, /rm |truncate|vacuum/u);
  assert.throws(() => sshSessionAuditCommand("bad", "2026-07-22T13:00:00Z"), /start is invalid/u);
});

test("accepts admin and bastion command sessions while retaining interactive evidence", () => {
  const stdout = [
    row("2026-07-22T12:01:00Z", "Accepted publickey for root from 198.51.100.25 port 50000 ssh2: ED25519 SHA256:admin"),
    row("2026-07-22T12:01:00.100Z", "Starting session: shell on pts/0 for root from 198.51.100.25 port 50000 id 0"),
    row("2026-07-22T12:02:00Z", "Accepted publickey for root from 10.120.0.4 port 50001 ssh2: ED25519 SHA256:bastion"),
    row("2026-07-22T12:02:00.100Z", "Starting session: command for root from 10.120.0.4 port 50001 id 0")
  ].join("\n");
  const result = evaluateSshSessionAudit({
    host: "bvm-compositor-a",
    startedAt: "2026-07-22T12:00:00Z",
    endedAt: "2026-07-22T13:00:00Z",
    stdout,
    adminAddresses: ["198.51.100.25"],
    bastionAddresses: ["10.120.0.4"]
  });
  assert.equal(result.status, "healthy");
  assert.equal(result.acceptedKeys, 2);
  assert.equal(result.interactiveShells, 1);
  assert.equal(result.commandSessions, 1);
  assert.deepEqual(result.sources.map((source) => source.approvedAs).sort(), ["admin", "bastion"]);
});

test("fails evidence for unknown sources, non-key methods, or bastion shells", () => {
  const stdout = [
    row("2026-07-22T12:01:00Z", "Accepted password for root from 203.0.113.9 port 50000 ssh2"),
    row("2026-07-22T12:02:00Z", "Accepted publickey for root from 10.120.0.4 port 50001 ssh2: ED25519 SHA256:bastion"),
    row("2026-07-22T12:02:00.100Z", "Starting session: shell on pts/1 for root from 10.120.0.4 port 50001 id 0")
  ].join("\n");
  const result = evaluateSshSessionAudit({
    host: "bvm-ingest",
    startedAt: "2026-07-22T12:00:00Z",
    endedAt: "2026-07-22T13:00:00Z",
    stdout,
    adminAddresses: ["198.51.100.25"],
    bastionAddresses: ["10.120.0.4"]
  });
  assert.equal(result.status, "unhealthy");
  assert.match(result.problems.join("; "), /disallowed SSH method password/u);
  assert.match(result.problems.join("; "), /unapproved source 203\.0\.113\.9/u);
  assert.match(result.problems.join("; "), /interactive SSH shell from non-admin source 10\.120\.0\.4/u);
});

test("fails closed on malformed or empty accepted-key evidence", () => {
  const result = evaluateSshSessionAudit({
    host: "bvm-observability",
    startedAt: "2026-07-22T12:00:00Z",
    endedAt: "2026-07-22T13:00:00Z",
    stdout: [
      "{bad json}",
      row("2026-07-22T12:01:00Z", "Starting session: tunnel for root from 198.51.100.25 port 50000 id 0")
    ].join("\n"),
    adminAddresses: ["198.51.100.25"]
  });
  assert.equal(result.status, "unhealthy");
  assert.match(result.problems.join("; "), /2 malformed journal record/u);
  assert.match(result.problems.join("; "), /no accepted-key records/u);
});

function row(at, message) {
  return JSON.stringify({
    __REALTIME_TIMESTAMP: String(Date.parse(at) * 1_000),
    MESSAGE: message
  });
}
