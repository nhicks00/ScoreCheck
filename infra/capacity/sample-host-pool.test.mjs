import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parsePoolSamplerArgs } from "./sample-host-pool.mjs";

test("requires one ingest, eight active compositors, and one warm-spare SSH watcher", () => {
  const args = parsePoolSamplerArgs([
    "--host", "ingest,ingest,root@10.0.0.1",
    ...Array.from({ length: 9 }, (_, index) => ["--host", `compositor-${index + 1},compositor,root@10.0.0.${index + 2}`]).flat(),
    "--ssh-key", "~/.ssh/scorecheck_do",
    "--interval-seconds", "5",
    "--duration-seconds", "7500",
    "--process-poll-ms", "50",
    "--output", "/tmp/pool.ndjson"
  ]);
  assert.equal(args.hosts.length, 10);
  assert.equal(args.hosts.filter((host) => host.role === "compositor").length, 9);
  assert.equal(args.durationSeconds, 7500);
});

test("rejects partial pools and duplicate physical hosts", () => {
  const base = [
    "--host", "ingest,ingest,root@10.0.0.1",
    ...Array.from({ length: 9 }, (_, index) => ["--host", `compositor-${index + 1},compositor,root@10.0.0.${index + 2}`]).flat(),
    "--ssh-key", "/tmp/key", "--interval-seconds", "5", "--output", "/tmp/pool.ndjson"
  ];
  assert.throws(() => parsePoolSamplerArgs(base.slice(0, -8).concat(base.slice(-6))), /exactly ten/);
  const duplicate = [...base];
  const lastHost = duplicate.lastIndexOf("--host");
  duplicate[lastHost + 1] = "compositor-9,compositor,root@10.0.0.2";
  assert.throws(() => parsePoolSamplerArgs(duplicate), /SSH hosts must be unique/);
});

test("CLI starts one watcher per host and writes protected identity-preserving evidence", async () => {
  const fixture = await fakeSshFixture();
  try {
    const output = path.join(fixture.directory, "pool.ndjson");
    const result = await runPoolCli(fixture.directory, output);
    assert.equal(result.code, 0, result.stderr);
    const events = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 10);
    assert.equal(new Set(events.map((event) => event.hostId)).size, 10);
    assert.equal(new Set(events.map((event) => event.machineFingerprint)).size, 10);
    assert.ok(events.every((event) => event.event === "watcher_started"));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("CLI stops the full pool immediately when one host emits a new unclassified zombie", async () => {
  const fixture = await fakeSshFixture();
  try {
    const output = path.join(fixture.directory, "pool-failed.ndjson");
    const result = await runPoolCli(fixture.directory, output, { FAKE_FAIL_HOST: "root@10.0.0.10", duration: "5" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /observed a new unclassified zombie/);
    const events = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.hostId === "compositor-9" && event.event === "zombie_open"));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function fakeSshFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scorecheck-pool-test-"));
  const ssh = path.join(directory, "ssh");
  await writeFile(ssh, `#!/usr/bin/env node
const args = process.argv.slice(2);
const role = args[args.indexOf("--role") + 1];
const host = args.find((value) => value.startsWith("root@"));
process.stdin.resume();
process.stdin.once("end", () => {
  const observedAt = new Date().toISOString();
  const machineFingerprint = host.split(".").at(-1).padStart(16, "0");
  process.stdout.write(JSON.stringify({ schemaVersion: 1, role, event: "watcher_started", observedAt, pollIntervalMs: 50, watcherPid: process.pid, machineFingerprint }) + "\\n");
  if (host === process.env.FAKE_FAIL_HOST) {
    process.stdout.write(JSON.stringify({
      schemaVersion: 1, role, event: "zombie_open", observedAt: new Date().toISOString(),
      identity: "999:1", pid: 999, ppid: 1, state: "Z", command: "bad-child",
      parentCommand: "init", executable: null, commandFingerprint: null,
      cgroupFingerprint: "0123456789abcdef", initialObservation: false,
      classification: "unclassified"
    }) + "\\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  await chmod(ssh, 0o755);
  return { directory };
}

function runPoolCli(fakePath, output, options = {}) {
  const script = fileURLToPath(new URL("./sample-host-pool.mjs", import.meta.url));
  const args = [
    script,
    "--host", "ingest,ingest,root@10.0.0.1",
    ...Array.from({ length: 9 }, (_, index) => ["--host", `compositor-${index + 1},compositor,root@10.0.0.${index + 2}`]).flat(),
    "--ssh-key", "/tmp/test-key",
    "--interval-seconds", "5",
    "--duration-seconds", options.duration ?? "0.15",
    "--process-poll-ms", "50",
    "--output", output
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, PATH: `${fakePath}:${process.env.PATH}`, FAKE_FAIL_HOST: options.FAKE_FAIL_HOST ?? "" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
