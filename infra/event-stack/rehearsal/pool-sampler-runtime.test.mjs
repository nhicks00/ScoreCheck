import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "../event-manifest.mjs";
import { PoolSamplerRuntime, poolHostArguments } from "./pool-sampler-runtime.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "sampler-test", kind: "rehearsal", destroyAfter: "2026-08-01", ...inputs });
const lifecycleState = { droplets: Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, { publicIpv4: `198.51.100.${index + 1}` }])) };

test("binds exactly one ingest and nine compositor provider identities", () => {
  const args = poolHostArguments(manifest, lifecycleState);
  assert.equal(args.filter((value) => value === "--host").length, 10);
  assert.ok(args.some((value) => value.includes(",ingest,root@")));
  assert.equal(args.filter((value) => value.includes(",compositor,root@")).length, 9);
  assert.ok(args.some((value) => value.startsWith(`${manifest.namespace}-bvm-compositor-spare,`)));
});

test("starts, adopts, and exactly stops the protected pool sampler", async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "scorecheck-pool-runtime-"));
  let processLines = "800 unrelated";
  const signals = [];
  const runtime = new PoolSamplerRuntime({
    repoRoot: "/repo",
    sshKey: "/keys/event",
    knownHosts: "/keys/known",
    nodePath: "/usr/bin/node",
    sleep: async () => {},
    spawnImpl: (_command, args) => { processLines += `\n700 /usr/bin/node ${args.join(" ")}`; return { pid: 700 }; },
    runner: async () => ({ stdout: processLines, stderr: "" }),
    killImpl: (pid, signal) => { signals.push({ pid, signal }); processLines = processLines.split("\n").filter((line) => !line.startsWith("700 ")).join("\n"); }
  });
  const started = await runtime.ensure({ manifest, lifecycleState, evidenceDirectory });
  assert.equal(started.pid, 700);
  assert.equal(started.adopted, false);
  assert.equal((await runtime.ensure({ manifest, lifecycleState, evidenceDirectory })).adopted, true);
  const stopped = await runtime.stop(started);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(signals, [{ pid: -700, signal: "SIGTERM" }]);
  assert.match(processLines, /unrelated/);
});

test("fails closed if a prior evidence file is orphaned", async () => {
  const evidenceDirectory = await mkdtemp(join(tmpdir(), "scorecheck-pool-orphan-"));
  const output = join(evidenceDirectory, "pool-host-samples.jsonl");
  await (await import("node:fs/promises")).writeFile(output, "orphan\n", { mode: 0o600 });
  const runtime = new PoolSamplerRuntime({ repoRoot: "/repo", sshKey: "/keys/event", knownHosts: "/keys/known", nodePath: "/usr/bin/node", runner: async () => ({ stdout: "", stderr: "" }) });
  await assert.rejects(() => runtime.ensure({ manifest, lifecycleState, evidenceDirectory }), /evidence exists without its owning process/);
});
