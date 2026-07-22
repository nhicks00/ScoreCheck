import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { parseArgs, runSupabaseFaultProxyService } from "./supabase-fault-proxy-service.mjs";

const generation = "generation-supabase-12345678";
const event = "supabase-loss-event";
const pathPrefix = `/_scorecheck-supabase-fault/${event}/`;

test("service parser requires exact protected runtime inputs", () => {
  assert.deepEqual(parseArgs([
    "--upstream", "https://project.supabase.co",
    "--event", event,
    "--generation", generation,
    "--path-prefix", pathPrefix,
    "--state", "/state/state.json",
    "--port", "54329"
  ]), {
    upstream: "https://project.supabase.co",
    event,
    generation,
    pathPrefix,
    state: "/state/state.json",
    port: 54329
  });
  assert.throws(() => parseArgs(["--generation", generation]), /--upstream is required/u);
  assert.throws(() => parseArgs([
    "--upstream", "https://project.supabase.co", "--event", event, "--generation", generation, "--path-prefix", pathPrefix,
    "--state", "relative.json"
  ]), /normalized absolute path/u);
  assert.throws(() => parseArgs([
    "--upstream", "https://project.supabase.co", "--event", event, "--generation", generation, "--path-prefix", pathPrefix,
    "--state", "/state/state.json", "--port", "54329", "--port", "54330"
  ]), /only once/u);
});

test("service serializes signal controls and persists aggregate snapshots", async () => {
  const processImpl = new EventEmitter();
  processImpl.stderr = { write() {} };
  processImpl.exitCode = 0;
  const exits = [];
  processImpl.exit = (code) => exits.push(code);
  const snapshots = [];
  const proxy = new FakeProxy();
  let intervalCleared = false;
  const service = await runSupabaseFaultProxyService({
    upstream: "https://project.supabase.co",
    event,
    generation,
    pathPrefix,
    state: "/state/state.json",
    port: 54329
  }, {
    proxy,
    processImpl,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    writeSnapshot: async (value) => snapshots.push(structuredClone(value)),
    setIntervalImpl: () => 17,
    clearIntervalImpl: (value) => { assert.equal(value, 17); intervalCleared = true; }
  });

  assert.equal(proxy.status, "HEALTHY");
  assert.equal(snapshots.at(-1).writtenAt, "2026-07-22T12:00:00.000Z");
  processImpl.emit("SIGUSR1");
  await service.settle();
  assert.equal(proxy.status, "FAULTED");
  assert.equal(snapshots.at(-1).counters.faultCount, 1);
  processImpl.emit("SIGUSR2");
  await service.settle();
  assert.equal(proxy.status, "HEALTHY");
  assert.equal(snapshots.at(-1).counters.restoreCount, 1);
  processImpl.emit("SIGTERM");
  await service.settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(intervalCleared, true);
  assert.equal(proxy.status, "STOPPED");
  assert.deepEqual(exits, [0]);
});

test("a failed snapshot write does not block a later restore signal", async () => {
  const processImpl = new EventEmitter();
  const errors = [];
  processImpl.stderr = { write: (value) => errors.push(value) };
  processImpl.exitCode = 0;
  processImpl.exit = () => {};
  const proxy = new FakeProxy();
  const snapshots = [];
  let writes = 0;
  const service = await runSupabaseFaultProxyService({
    upstream: "https://project.supabase.co",
    event,
    generation,
    pathPrefix,
    state: "/state/state.json",
    port: 54329
  }, {
    proxy,
    processImpl,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    writeSnapshot: async (value) => {
      writes += 1;
      if (writes === 2) throw new Error("synthetic state write failure");
      snapshots.push(structuredClone(value));
    },
    setIntervalImpl: () => 18,
    clearIntervalImpl() {}
  });

  processImpl.emit("SIGUSR1");
  await assert.rejects(service.settle(), /synthetic state write failure/u);
  assert.equal(proxy.status, "FAULTED");
  processImpl.emit("SIGUSR2");
  await service.settle();
  assert.equal(proxy.status, "HEALTHY");
  assert.equal(snapshots.at(-1).counters.restoreCount, 1);
  assert.equal(errors.length, 1);
});

class FakeProxy {
  constructor() {
    this.status = "STOPPED";
    this.faultCount = 0;
    this.restoreCount = 0;
  }
  async start() { this.status = "HEALTHY"; }
  fault(value) { assert.equal(value, `FAULT-SUPABASE:${generation}`); this.status = "FAULTED"; this.faultCount += 1; }
  restore(value) { assert.equal(value, `RESTORE-SUPABASE:${generation}`); this.status = "HEALTHY"; this.restoreCount += 1; }
  async close() { this.status = "STOPPED"; }
  snapshot() {
    return {
      schemaVersion: 1,
      event,
      generationId: generation,
      status: this.status,
      upstream: { protocol: "https:", hostname: "project.supabase.co", port: 443 },
      origin: "http://127.0.0.1:54329",
      pathPrefix,
      startedAt: "2026-07-22T12:00:00.000Z",
      faultedAt: this.faultCount ? "2026-07-22T12:00:00.000Z" : null,
      restoredAt: this.restoreCount ? "2026-07-22T12:00:00.000Z" : null,
      closedAt: this.status === "STOPPED" ? "2026-07-22T12:00:00.000Z" : null,
      counters: {
        httpRequestsForwarded: 0,
        webSocketsForwarded: 0,
        requestsRejectedDuringFault: 0,
        upstreamErrors: 0,
        faultCount: this.faultCount,
        restoreCount: this.restoreCount,
        activeHttpRequests: 0,
        pendingWebSocketUpgrades: 0,
        activeWebSockets: 0
      }
    };
  }
}
