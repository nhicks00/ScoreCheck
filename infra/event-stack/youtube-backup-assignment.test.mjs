import assert from "node:assert/strict";
import test from "node:test";

import { createYoutubeBackupAssignment, YoutubeBackupAssignmentRuntime } from "./youtube-backup-assignment.mjs";

function stream(overrides = {}) {
  return {
    id: "stream-1",
    court: 1,
    streamName: "protected-stream-key-1",
    rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
    rtmpsBackupIngestionAddress: "rtmps://b.rtmps.youtube.com/live2",
    ...overrides
  };
}

test("builds one court-scoped backup assignment without exposing its key in public state", () => {
  const assignment = createYoutubeBackupAssignment({ event: "event-test", generation: "generation-test", court: 1, stream: stream() });
  assert.equal(assignment.remotePath, "requests/court-1.backup.env");
  assert.match(assignment.content, /^YOUTUBE_BACKUP_RTMPS_BASE=rtmps:\/\/b\.rtmps\.youtube\.com\/live2\nCOURT_1_YOUTUBE_KEY=protected-stream-key-1\n$/u);
  assert.match(assignment.sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(assignment.id, assignment.sha256);
});

test("rejects missing, duplicate, or credential-bearing backup addresses", () => {
  const input = { event: "event-test", generation: "generation-test", court: 1 };
  assert.throws(() => createYoutubeBackupAssignment({ ...input, stream: stream({ rtmpsBackupIngestionAddress: null }) }), /backup RTMPS/u);
  assert.throws(() => createYoutubeBackupAssignment({ ...input, stream: stream({ rtmpsBackupIngestionAddress: stream().rtmpsIngestionAddress }) }), /must differ/u);
  assert.throws(() => createYoutubeBackupAssignment({ ...input, stream: stream({ rtmpsBackupIngestionAddress: "rtmps://user:secret@b.rtmps.youtube.com/live2" }) }), /backup RTMPS/u);
});

test("stages, verifies, and removes only the exact protected remote assignment", async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === "ssh" && args.at(-1).includes("else exit 3")) return { code: 3, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const runtime = new YoutubeBackupAssignmentRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known", runner });
  const assignment = await runtime.stage({
    host: "198.51.100.12",
    event: "event-test",
    generation: "generation-test",
    court: 1,
    stream: stream()
  });
  assert.equal("content" in assignment, false);
  assert.equal(calls.filter((entry) => entry.command === "scp").length, 1);
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("protected-stream-key-1")), false);
  assert.match(calls.find((entry) => entry.command === "ssh" && entry.args.at(-1).includes("mv "))?.args.at(-1) ?? "", new RegExp(assignment.sha256, "u"));
  assert.deepEqual(await runtime.verify({ host: "198.51.100.12", assignment }), assignment);
  const cleaned = await runtime.cleanup({ host: "198.51.100.12", assignment });
  assert.equal(cleaned.removed, true);
  assert.match(calls.at(-1).args.at(-1), /rm requests\/court-1\.backup\.env/u);
});
