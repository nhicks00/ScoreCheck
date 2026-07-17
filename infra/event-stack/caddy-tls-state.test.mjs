import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CaddyTlsStateStore, inspectCaddyTlsState } from "./caddy-tls-state.mjs";

const run = promisify(execFile);
const hosts = ["rtc-rehearsal.beachvolleyballmedia.com", "turn-rehearsal.beachvolleyballmedia.com"];

test("captures, verifies, restores, and integrity-binds protected multi-host Caddy TLS state", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-tls-"));
  await chmod(root, 0o700);
  const remote = join(root, "remote");
  const certificateDirectory = join(remote, "caddy", "certificates", "test");
  await mkdir(certificateDirectory, { recursive: true, mode: 0o700 });
  await run("openssl", [
    "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "3650",
    "-subj", `/CN=${hosts[0]}`,
    "-addext", `subjectAltName=DNS:${hosts[0]},DNS:${hosts[1]}`,
    "-keyout", join(root, "fixture.key"),
    "-out", join(certificateDirectory, "fixture.crt")
  ]);
  await writeFile(join(remote, "acme-account.json"), "{}\n", { mode: 0o600 });
  const commands = [];
  const runner = async (command, args) => {
    commands.push([command, args]);
    if (command === "rsync" && String(args.at(-2)).startsWith("root@")) {
      await cp(remote, args.at(-1), { recursive: true, force: true });
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const stateDirectory = join(root, "retained", "state");
  const store = new CaddyTlsStateStore({
    directory: stateDirectory,
    sshPrivateKey: join(root, "fixture.key"),
    knownHostsPath: join(root, "known_hosts"),
    runner,
    now: () => new Date("2026-08-01T12:00:00.000Z")
  });

  assert.deepEqual(await store.inspect(hosts, { allowMissing: true }), { status: "missing", hosts: [...hosts].sort() });
  const captured = await store.capture({ publicIpv4: "192.0.2.10", hosts });
  assert.equal(captured.status, "ready");
  assert.equal(captured.fileCount, 2);
  assert.equal(Object.keys(captured.certificates).length, 2);
  assert.match(captured.stateSha256, /^[a-f0-9]{64}$/u);

  const restored = await store.restore({ publicIpv4: "192.0.2.11", hosts });
  assert.equal(restored.status, "restored");
  assert.ok(commands.some(([command, args]) => command === "rsync" && String(args.at(-2)).endsWith("/data/")));

  await writeFile(join(stateDirectory, "data", "acme-account.json"), "tampered\n", { mode: 0o600 });
  await assert.rejects(() => inspectCaddyTlsState({ directory: stateDirectory, hosts }), /integrity verification/u);
});

test("supports a single observability hostname binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-observability-tls-"));
  await chmod(root, 0o700);
  const remote = join(root, "remote");
  const host = "monitor-rehearsal.beachvolleyballmedia.com";
  const certificateDirectory = join(remote, "caddy", "certificates", "test");
  await mkdir(certificateDirectory, { recursive: true, mode: 0o700 });
  await run("openssl", [
    "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "3650",
    "-subj", `/CN=${host}`,
    "-addext", `subjectAltName=DNS:${host}`,
    "-keyout", join(root, "fixture.key"),
    "-out", join(certificateDirectory, "fixture.crt")
  ]);
  const runner = async (command, args) => {
    if (command === "rsync" && String(args.at(-2)).startsWith("root@")) await cp(remote, args.at(-1), { recursive: true, force: true });
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = new CaddyTlsStateStore({
    directory: join(root, "retained", "state"),
    sshPrivateKey: join(root, "fixture.key"),
    knownHostsPath: join(root, "known_hosts"),
    runner,
    remoteDirectory: "/opt/scorecheck-monitoring",
    now: () => new Date("2026-08-01T12:00:00.000Z")
  });
  const captured = await store.capture({ publicIpv4: "192.0.2.12", hosts: [host] });
  assert.equal(captured.status, "ready");
  assert.deepEqual(captured.hosts, [host]);
});

test("fails closed on endpoint binding drift and incomplete retained state", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-tls-invalid-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "data"), { mode: 0o700 });
  await assert.rejects(
    () => inspectCaddyTlsState({ directory: root, hosts }),
    /TLS_STATE_COMPLETE|no such file|ENOENT|marker/u
  );
  assert.throws(
    () => new CaddyTlsStateStore({ directory: "relative", sshPrivateKey: "/key", knownHostsPath: "/known", runner: async () => {} }),
    /normalized absolute/u
  );
});
