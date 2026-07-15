import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildEventManifest, parseArgs, validateEventManifest } from "./event-manifest.mjs";

const poolPath = fileURLToPath(new URL("./compositor-pool.json", import.meta.url));
const poolSpecSource = await readFile(poolPath, "utf8");
const poolSpec = JSON.parse(poolSpecSource);

function manifest() {
  return buildEventManifest({
    event: "next-shadow-event",
    destroyAfter: "2026-07-20",
    poolSpec,
    poolSpecSource
  });
}

test("generates the exact fixed services, eight assigned workers, and warm spare", () => {
  const value = manifest();
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.droplets.length, 12);
  assert.deepEqual(value.droplets.slice(0, 3).map((entry) => entry.name), [
    "bvm-commentary-01",
    "bvm-observability-01",
    "bvm-preview-01"
  ]);
  assert.deepEqual(
    value.droplets.filter((entry) => entry.role === "compositor").map((entry) => entry.court),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.deepEqual(value.droplets.at(-1), {
    name: "bvm-compositor-spare",
    role: "compositor-spare",
    warmSpare: true
  });
  assert.match(value.compositorPool.specSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateEventManifest(value, { poolSpec, poolSpecSource }), value);
});

for (const [name, mutate] of [
  ["missing worker", (value) => value.droplets.pop()],
  ["extra worker", (value) => value.droplets.push({ name: "rogue", role: "compositor", court: 8 })],
  ["changed court", (value) => { value.droplets.find((entry) => entry.name === "bvm-compositor-h").court = 7; }],
  ["changed fixed role", (value) => { value.droplets[0].role = "ingest"; }],
  ["changed pool digest", (value) => { value.compositorPool.specSha256 = "0".repeat(64); }],
  ["extra property", (value) => { value.untracked = true; }]
]) {
  test(`rejects an event manifest with ${name}`, () => {
    const value = structuredClone(manifest());
    mutate(value);
    assert.throws(
      () => validateEventManifest(value, { poolSpec, poolSpecSource }),
      /does not exactly match/
    );
  });
}

test("rejects invalid event and calendar values", () => {
  assert.throws(
    () => buildEventManifest({ event: "NOT VALID", destroyAfter: "2026-07-20", poolSpec, poolSpecSource }),
    /event slug/
  );
  assert.throws(
    () => buildEventManifest({ event: "valid", destroyAfter: "2026-02-30", poolSpec, poolSpecSource }),
    /real calendar date/
  );
});

test("binds the manifest to the exact pool file bytes", () => {
  const value = manifest();
  assert.throws(
    () => validateEventManifest(value, { poolSpec, poolSpecSource: `${poolSpecSource}\n` }),
    /does not exactly match/
  );
});

test("rejects a pool object that is not derived from the bound source", () => {
  const changedPool = structuredClone(poolSpec);
  changedPool.region = "nyc3";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      destroyAfter: "2026-07-20",
      poolSpec: changedPool,
      poolSpecSource
    }),
    /does not match the bound source bytes/
  );
});

test("rejects a weakened pool and fixed-resource name collision", () => {
  const weakenedPool = structuredClone(poolSpec);
  weakenedPool.desiredCompositors = 7;
  weakenedPool.workers = weakenedPool.workers.filter((worker) => worker.court !== 8);
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      destroyAfter: "2026-07-20",
      poolSpec: weakenedPool,
      poolSpecSource: JSON.stringify(weakenedPool)
    }),
    /desired compositor count/
  );

  const collidingPool = structuredClone(poolSpec);
  collidingPool.workers[0].name = "bvm-preview-01";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      destroyAfter: "2026-07-20",
      poolSpec: collidingPool,
      poolSpecSource: JSON.stringify(collidingPool)
    }),
    /collides with a fixed event resource/
  );
});

test("requires an absolute protected output path", () => {
  assert.throws(
    () => parseArgs([
      "generate",
      "--event", "valid",
      "--destroy-after", "2026-07-20",
      "--output", "relative.json"
    ]),
    /absolute path/
  );
});

test("CLI writes mode 0600 and refuses to overwrite", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-event-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "event.json");
  const tool = fileURLToPath(new URL("./event-manifest.mjs", import.meta.url));
  const args = [
    tool,
    "generate",
    "--event", "valid",
    "--destroy-after", "2026-07-20",
    "--output", output
  ];
  const first = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(output, "utf8")).droplets.length, 12);
  const validation = spawnSync(process.execPath, [tool, "validate", "--manifest", output], { encoding: "utf8" });
  assert.equal(validation.status, 0, validation.stderr);
  assert.equal(JSON.parse(validation.stdout).dropletCount, 12);

  const sentinel = await readFile(output, "utf8");
  const second = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /EEXIST/);
  assert.equal(await readFile(output, "utf8"), sentinel);
});
