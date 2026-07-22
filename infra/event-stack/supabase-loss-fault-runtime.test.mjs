import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildSupabaseFaultCaddyfile, cleanupCommand, controlCommand, inspectCommand, prepareCommand, SupabaseLossFaultRuntime } from "./supabase-loss-fault-runtime.mjs";

const event = "production-event-20260722";
const generationId = "generation-20260722-abcd1234";

test("builds one exact generation-scoped Caddy route", async () => {
  const source = await readFile(new URL("../monitoring/Caddyfile", import.meta.url), "utf8");
  const prefix = `/_scorecheck-supabase-fault/${generationId}/`;
  const candidate = buildSupabaseFaultCaddyfile(source, prefix);
  assert.match(candidate, new RegExp(`path ${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\*`, "u"));
  assert.match(candidate, /reverse_proxy 127\.0\.0\.1:54329/u);
  assert.equal(candidate.match(/scorecheckSupabaseFault/gu)?.length, 2);
  assert.throws(() => buildSupabaseFaultCaddyfile(candidate, prefix), /already contains/u);
  assert.throws(() => buildSupabaseFaultCaddyfile(source, "/wrong/"), /path prefix is invalid/u);
});

test("host runtime prepares, faults, restores, and removes only its exact sidecar and route", async () => {
  const caddyfile = await readFile(new URL("../monitoring/Caddyfile", import.meta.url), "utf8");
  const proxyScript = await readFile(new URL("./supabase-fault-proxy.mjs", import.meta.url), "utf8");
  const serviceScript = await readFile(new URL("./supabase-fault-proxy-service.mjs", import.meta.url), "utf8");
  let status = "CLEAN";
  const commands = [];
  let target;
  const runner = async (command, args) => {
    assert.equal(command, "ssh");
    const body = args.at(-1);
    commands.push(body);
    if (body.includes("docker run --detach")) status = "HEALTHY";
    else if (body.includes("--signal='USR1'")) status = "FAULTED";
    else if (body.includes("--signal='USR2'")) status = "HEALTHY_RESTORED";
    else if (body.includes("docker stop --time 10")) status = "CLEAN";
    if (body.includes("printf '{\"status\":\"CLEAN\"}")) {
      if (status === "CLEAN") return { stdout: '{"status":"CLEAN"}\n', stderr: "", code: 0 };
      return { stdout: JSON.stringify({ status: "BOUND", state: serviceSnapshot(target, status) }) + "\n", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const runtime = new SupabaseLossFaultRuntime({
    sshKey: "/tmp/scorecheck-key",
    knownHosts: "/tmp/scorecheck-known-hosts",
    runner,
    fetchImpl: async () => new Response('{"status":"HEALTHY"}', { status: 200, headers: { "content-type": "application/json" } })
  });
  target = runtime.plan({
    host: "203.0.113.8",
    publicHost: "monitor.example.test",
    event,
    generationId,
    upstreamOrigin: "https://project.supabase.co",
    caddyfile,
    proxyScript,
    serviceScript
  });
  assert.equal(target.publicOrigin, `https://monitor.example.test/_scorecheck-supabase-fault/${generationId}/`);
  assert.equal((await runtime.inspect(target)).status, "CLEAN");
  assert.rejects(runtime.prepare({ target, confirmation: "yes" }), /confirmation must be exactly/u);
  assert.equal((await runtime.prepare({ target, confirmation: `PREPARE-SUPABASE-FAULT:${event}` })).status, "HEALTHY");
  assert.equal((await runtime.fault({ target, confirmation: `FAULT-SUPABASE:${generationId}` })).status, "FAULTED");
  assert.equal((await runtime.restore({ target, confirmation: `RESTORE-SUPABASE:${generationId}` })).status, "HEALTHY");
  assert.equal((await runtime.cleanup({ target, confirmation: `CLEANUP-SUPABASE-FAULT:${event}` })).status, "CLEAN");

  const prepare = commands.find((value) => value.includes("docker run --detach"));
  const cleanup = commands.find((value) => value.includes("docker stop --time 10"));
  assert.match(prepare, /--network "container:\$caddy_id"/u);
  assert.match(prepare, /--read-only/u);
  assert.match(prepare, /--cap-drop ALL/u);
  assert.match(prepare, /scorecheck-monitoring\/fault-gates/u);
  assert.match(cleanup, /exit 62/u);
  assert.match(cleanup, /caddy reload/u);
});

test("host runtime rejects unsafe targets before SSH", async () => {
  const runtime = new SupabaseLossFaultRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known", runner: async () => { throw new Error("unexpected"); } });
  const caddyfile = await readFile(new URL("../monitoring/Caddyfile", import.meta.url), "utf8");
  assert.throws(() => runtime.plan({
    host: "203.0.113.8",
    publicHost: "monitor.example.test",
    event,
    generationId,
    upstreamOrigin: "http://project.supabase.co",
    caddyfile,
    proxyScript: "proxy",
    serviceScript: "service"
  }), /credential-free HTTPS origin/u);
  assert.throws(() => runtime.plan({
    host: "203.0.113.999",
    publicHost: "monitor.example.test",
    event,
    generationId,
    upstreamOrigin: "https://project.supabase.co",
    caddyfile,
    proxyScript: "proxy",
    serviceScript: "service"
  }), /IPv4/u);
});

test("host runtime remote programs are valid POSIX shell", async () => {
  const caddyfile = await readFile(new URL("../monitoring/Caddyfile", import.meta.url), "utf8");
  const runtime = new SupabaseLossFaultRuntime({ sshKey: "/tmp/key", knownHosts: "/tmp/known" });
  const value = runtime.plan({
    host: "203.0.113.8",
    publicHost: "monitor.example.test",
    event,
    generationId,
    upstreamOrigin: "https://project.supabase.co",
    caddyfile,
    proxyScript: "proxy",
    serviceScript: "service"
  });
  for (const command of [inspectCommand(value), prepareCommand(value), controlCommand(value, "USR1", "FAULTED"), cleanupCommand(value)]) {
    const result = spawnSync("sh", ["-n"], { input: command, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

function serviceSnapshot(target, status) {
  const restored = status === "HEALTHY_RESTORED";
  const faulted = status === "FAULTED";
  return {
    schemaVersion: 1,
    generationId: target.generationId,
    status: faulted ? "FAULTED" : "HEALTHY",
    upstream: { protocol: "https:", hostname: "project.supabase.co", port: 443 },
    origin: "http://127.0.0.1:54329",
    pathPrefix: target.pathPrefix,
    startedAt: "2026-07-22T12:00:00.000Z",
    faultedAt: faulted || restored ? "2026-07-22T12:01:00.000Z" : null,
    restoredAt: restored ? "2026-07-22T12:02:00.000Z" : null,
    closedAt: null,
    writtenAt: "2026-07-22T12:02:01.000Z",
    counters: {
      httpRequestsForwarded: restored ? 2 : 1,
      webSocketsForwarded: restored ? 2 : 1,
      requestsRejectedDuringFault: faulted || restored ? 1 : 0,
      upstreamErrors: 0,
      faultCount: faulted || restored ? 1 : 0,
      restoreCount: restored ? 1 : 0,
      activeHttpRequests: 0,
      pendingWebSocketUpgrades: 0,
      activeWebSockets: faulted ? 0 : 1
    }
  };
}
