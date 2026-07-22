import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  activateCommand,
  buildOverlayDebugEgressConfig,
  cleanupCommand,
  completeCommand,
  inspectCommand,
  overlayFaultArmExpression,
  overlayFaultInstallExpression,
  overlayFaultStatusExpression,
  OverlayExceptionDebugRuntime,
  prepareCommand,
  selectOverlayCdpTarget,
  validateDebugTarget,
  validateEgressOwner
} from "./overlay-exception-debug-runtime.mjs";

const BASELINE_CONFIG = await readFile(new URL("../compositor/egress.yaml", import.meta.url), "utf8");

test("debug config preserves the ordinary Chrome flags and adds one bounded debug endpoint", () => {
  const result = buildOverlayDebugEgressConfig(BASELINE_CONFIG);
  assert.match(result, /chrome_flags:\n  disable-dev-shm-usage: false\n  # Isolated overlay-exception rehearsal only\./u);
  assert.equal(matches(result, /remote-debugging-address:/gu), 1);
  assert.equal(matches(result, /remote-debugging-port:/gu), 1);
  assert.match(result, /remote-debugging-address: "0\.0\.0\.0"/u);
  assert.match(result, /remote-debugging-port: 9222/u);
  assert.match(result, /health_port: 9091/u);
  assert.throws(() => buildOverlayDebugEgressConfig(result), /already enables remote debugging/u);
});

test("debug config adds a root Chrome flag map when the baseline has none", () => {
  const baseline = `${"# baseline\n".repeat(20)}ws_url: ws://livekit:7880\nredis:\n  address: redis:6379\nhealth_port: 9091\n`;
  const result = buildOverlayDebugEgressConfig(baseline);
  assert.match(result, /health_port: 9091\n\nchrome_flags:\n/u);
  assert.equal(matches(result, /^chrome_flags:/gmu), 1);
});

test("debug target is digest-bound to the exact baseline and generated config", () => {
  const value = target();
  assert.deepEqual(validateDebugTarget(value), value);
  assert.throws(() => validateDebugTarget({ ...value, host: "example.com" }), /IPv4/u);
  assert.throws(() => validateDebugTarget({ ...value, rendererOrigin: "https://www.beachvolleyballmedia.com" }), /immutable Vercel/u);
  assert.throws(() => validateDebugTarget({ ...value, debugConfigSha256: "f".repeat(64) }), /digest/u);
  assert.throws(() => validateDebugTarget({ ...value, debugPort: 9223 }), /debug port/u);
});

test("CDP selection accepts only one exact immutable Program page", () => {
  const value = target();
  const exact = {
    type: "page",
    url: `${value.rendererOrigin}/program/court/1?build=${value.rendererGitSha}&deployment=${value.rendererDeploymentId}`,
    webSocketDebuggerUrl: "ws://172.20.0.7:9222/devtools/page/exact"
  };
  assert.deepEqual(selectOverlayCdpTarget([exact], value), { webSocketDebuggerUrl: exact.webSocketDebuggerUrl });
  for (const url of [
    `${value.rendererOrigin}/program/court/2?build=${value.rendererGitSha}&deployment=${value.rendererDeploymentId}`,
    `${value.rendererOrigin}/program/court/1?build=${"b".repeat(40)}&deployment=${value.rendererDeploymentId}`,
    `${value.rendererOrigin}/program/court/1?build=${value.rendererGitSha}&deployment=dpl_other`,
    `${value.rendererOrigin}/program/court/1?build=${value.rendererGitSha}&deployment=${value.rendererDeploymentId}#token=forbidden`
  ]) {
    assert.throws(() => selectOverlayCdpTarget([{ ...exact, url }], value), /found 0/u);
  }
  assert.throws(() => selectOverlayCdpTarget([exact, { ...exact }], value), /found 2/u);
});

test("Egress owner and generated host commands are exact-generation fail closed", () => {
  const value = target();
  const owner = egressOwner();
  assert.deepEqual(validateEgressOwner(owner, value), owner);
  assert.throws(() => validateEgressOwner({ ...owner, event: "event-other" }, value), /does not match/u);

  const prepare = prepareCommand(value);
  assert.match(prepare, /list-egress\.sh --active --json/u);
  assert.match(prepare, /test ! -e "\$marker" && test ! -L "\$marker".*test ! -e "\$backup" && test ! -L "\$backup"/u);
  assert.match(prepare, /active_count.*\n.*test "\$active_count" -eq 0/su);
  assert.match(prepare, new RegExp(value.baselineConfigSha256, "u"));
  assert.match(prepare, /docker compose up -d --force-recreate egress/u);
  assert.ok(prepare.indexOf("--arg phase PREPARING") < prepare.indexOf("mv \"$temporary\" \"$config\""), "recovery marker must precede the config swap");

  const activate = activateCommand(value, owner);
  assert.match(activate, /list-egress\.sh --active --json/u);
  assert.match(activate, /test -f "\$marker" && test ! -L "\$marker" && test -f "\$backup" && test ! -L "\$backup"/u);
  assert.match(activate, /length == 1 and \.\[0\]\.egress_id == \$id/u);
  for (const binding of Object.values(owner)) assert.match(activate, new RegExp(String(binding).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.ok(activate.indexOf("mv \"$temporary\" \"$config\"") < activate.indexOf("--arg phase ACTIVE"));
  assert.doesNotMatch(activate, /docker compose up/u, "active Egress must not be recreated");

  const complete = completeCommand(value);
  assert.match(complete, /test -f "\$marker" && test ! -L "\$marker"/u);
  assert.match(complete, /phase' "\$marker"\)" = ACTIVE/u);
  assert.match(complete, /--arg phase COMPLETE/u);

  const cleanup = cleanupCommand(value);
  assert.match(cleanup, /list-egress\.sh --active --json/u);
  assert.match(cleanup, /test -f "\$marker" && test ! -L "\$marker" && test -f "\$backup" && test ! -L "\$backup"/u);
  assert.match(cleanup, /test "\$active_count" -eq 0/u);
  assert.match(cleanup, /docker compose up -d --force-recreate egress/u);
  assert.match(cleanup, /! curl .*9222\/json\/version/u);
  assert.match(cleanup, /rm -f "\$marker" "\$backup"/u);

  const inspect = inspectCommand(value);
  for (const status of ["CLEAN", "PREPARED", "ACTIVE", "COMPLETE", "DIRTY", "UNAVAILABLE"]) assert.match(inspect, new RegExp(status, "u"));
});

test("all generated remote commands are valid POSIX shell programs", () => {
  const value = target();
  for (const command of [inspectCommand(value), prepareCommand(value), activateCommand(value, egressOwner()), completeCommand(value), cleanupCommand(value)]) {
    const result = spawnSync("sh", ["-n"], { input: command, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("cleanup can recover an exact unavailable prepared worker only after its host command succeeds", async () => {
  const statuses = ["UNAVAILABLE", "CLEAN"];
  const commands = [];
  const runtime = new OverlayExceptionDebugRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    runner: async (_command, args) => {
      const remote = args.at(-1);
      commands.push(remote);
      return { stdout: remote.includes("scorecheck_overlay_debug_inspect=1") ? `${statuses.shift()}\n` : "", stderr: "" };
    }
  });
  const result = await runtime.cleanup({ target: target(), confirmation: "CLEANUP-OVERLAY-DEBUG:event-test:CAMERA-1" });
  assert.equal(result.status, "CLEAN");
  assert.ok(commands.some((command) => command.includes("scorecheck_overlay_debug_cleanup=1")));
});

test("browser control installs dormant, mutates only the target repair response, and throws only for score-set rendering", async () => {
  let boardPresent = true;
  const ordinaryResponse = new Response("ordinary", { status: 200 });
  const authoritative = {
    phase: "IDLE",
    projection: { scoreRevision: 7, sourceRevision: "7", sourceTimestamp: "2026-07-22T00:00:00.000Z" },
    score: { teamAScore: 0, teamBScore: 0, currentSet: 1, setScores: [] },
    health: { stale: false }
  };
  const context = vm.createContext({
    URL,
    Headers,
    Request,
    Response,
    Date,
    console,
    location: new URL("https://renderer.test/program/court/1"),
    document: {
      querySelector(selector) {
        if (selector === ".program-root") return {};
        if (selector === "[data-scorebug-shape]") return boardPresent ? {} : null;
        if (selector === "video") return { paused: false, readyState: 4, currentTime: 12.5, videoWidth: 1920, videoHeight: 1080 };
        return null;
      }
    },
    fetch: async (input) => {
      const url = new URL(String(input), "https://renderer.test/program/court/1");
      return url.origin === "https://renderer.test" && url.pathname === "/api/overlay/court/1/state"
        ? new Response(JSON.stringify(authoritative), { status: 200, headers: { etag: "test", "content-type": "application/json" } })
        : ordinaryResponse;
    }
  });

  const installed = vm.runInContext(overlayFaultInstallExpression(1), context);
  assert.equal(installed.installed, true);
  assert.equal(installed.armed, false);
  assert.equal(vm.runInContext("[1, 2, 3].at(-1)", context), 3);
  assert.equal(await vm.runInContext("fetch('https://renderer.test/ordinary')", context), ordinaryResponse);
  assert.equal(await vm.runInContext("fetch('https://other.test/proxy/api/overlay/court/1/state')", context), ordinaryResponse);

  const armed = vm.runInContext(overlayFaultArmExpression(), context);
  assert.equal(armed.armed, true);
  const response = await vm.runInContext("fetch('/api/overlay/court/1/state')", context);
  const body = await response.json();
  assert.equal(body.phase, "LIVE");
  assert.equal(body.projection.scoreRevision, 8);
  assert.equal(body.projection.sourceRevision, "8");
  assert.deepEqual(body.score.setScores, [{ setNumber: 1, teamAScore: 1, teamBScore: 0, isComplete: false }]);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(vm.runInContext("[1, 2, 3].at(-1)", context), 3, "ordinary arrays remain unaffected");
  assert.throws(() => vm.runInContext("[{setNumber:1,teamAScore:1,teamBScore:0}].at(-1)", context), /isolated overlay exception rehearsal/u);
  boardPresent = false;
  const status = vm.runInContext(overlayFaultStatusExpression(), context);
  assert.equal(status.interceptCount, 1);
  assert.equal(status.throwCount, 1);
  assert.equal(status.programRootPresent, true);
  assert.equal(status.boardPresent, false);
  assert.deepEqual(structuredClone(status.video), { paused: false, readyState: 4, currentTime: 12.5, width: 1920, height: 1080 });
});

function target() {
  const debug = buildOverlayDebugEgressConfig(BASELINE_CONFIG);
  return {
    schemaVersion: 1,
    host: "203.0.113.21",
    event: "event-test",
    generationId: "generation-test-01",
    camera: 1,
    gateId: "overlay-exception-123e4567-e89b-12d3-a456-426614174000",
    rendererGitSha: "a".repeat(40),
    rendererDeploymentId: "dpl_renderer123",
    rendererOrigin: "https://scorecheck-renderer-test.vercel.app",
    baselineConfigSha256: sha256(BASELINE_CONFIG),
    debugConfigSha256: sha256(debug),
    debugConfigBase64: Buffer.from(debug).toString("base64"),
    debugPort: 9222
  };
}

function egressOwner() {
  return {
    event: "event-test",
    camera: 1,
    rendererGitSha: "a".repeat(40),
    rendererDeploymentId: "dpl_renderer123",
    egressId: "EG_exact123",
    destinationId: "broadcast-test",
    outputGeneration: "generation-test-01"
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function matches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}
