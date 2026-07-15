import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildEventManifest,
  loadManifestInputs,
  parseArgs,
  validateEventManifest,
  validateServiceSpec
} from "./event-manifest.mjs";

const inputs = await loadManifestInputs();

function manifest() {
  return buildEventManifest({
    event: "next-shadow-event",
    destroyAfter: "2026-07-20",
    ...inputs
  });
}

test("generates exact services, endpoints, eight assigned workers, and warm spare", () => {
  const value = manifest();
  assert.equal(value.schemaVersion, 2);
  assert.equal(value.droplets.length, 12);
  assert.deepEqual(value.droplets.slice(0, 3).map((entry) => entry.name), [
    "bvm-commentary-01",
    "bvm-observability-01",
    "bvm-preview-01"
  ]);
  assert.deepEqual(value.droplets.slice(0, 3).map((entry) => entry.size), [
    "s-2vcpu-2gb",
    "s-2vcpu-4gb",
    "c-4"
  ]);
  assert.deepEqual(
    value.droplets.filter((entry) => entry.role === "compositor").map((entry) => entry.court),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );
  assert.deepEqual(value.droplets.at(-1), {
    name: "bvm-compositor-spare",
    role: "compositor-spare",
    warmSpare: true,
    region: "sfo2",
    size: "c-4",
    image: "ubuntu-24-04-x64",
    tag: "bvm-compositor",
    cloudInitProfile: "compositor",
    cloudInitSha256: value.sourceBindings.cloudInitSha256.compositor
  });
  assert.equal(value.provider.minimumAccountDropletLimit, 12);
  assert.equal(value.endpoints.filter((entry) => entry.addressMode === "reserved-ipv4").length, 3);
  assert.equal(value.endpoints.filter((entry) => entry.addressMode === "dynamic-ipv4").length, 1);
  assert.match(value.sourceBindings.compositorPoolSpecSha256, /^[a-f0-9]{64}$/);
  assert.match(value.sourceBindings.serviceSpecSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateEventManifest(value, inputs), value);
});

for (const [name, mutate] of [
  ["missing worker", (value) => value.droplets.pop()],
  ["extra worker", (value) => value.droplets.push({ name: "rogue", role: "compositor", court: 8 })],
  ["changed court", (value) => { value.droplets.find((entry) => entry.name === "bvm-compositor-h").court = 7; }],
  ["changed fixed role", (value) => { value.droplets[0].role = "ingest"; }],
  ["changed fixed size", (value) => { value.droplets[0].size = "c-4"; }],
  ["changed pool digest", (value) => { value.sourceBindings.compositorPoolSpecSha256 = "0".repeat(64); }],
  ["changed endpoint mode", (value) => { value.endpoints[0].addressMode = "dynamic-ipv4"; delete value.endpoints[0].addressSlot; }],
  ["extra property", (value) => { value.untracked = true; }]
]) {
  test(`rejects an event manifest with ${name}`, () => {
    const value = structuredClone(manifest());
    mutate(value);
    assert.throws(
      () => validateEventManifest(value, inputs),
      /does not exactly match/
    );
  });
}

test("rejects invalid event and calendar values", () => {
  assert.throws(
    () => buildEventManifest({ event: "NOT VALID", destroyAfter: "2026-07-20", ...inputs }),
    /event slug/
  );
  assert.throws(
    () => buildEventManifest({ event: "valid", destroyAfter: "2026-02-30", ...inputs }),
    /real calendar date/
  );
});

test("binds the manifest to exact service and pool file bytes", () => {
  const value = manifest();
  assert.throws(
    () => validateEventManifest(value, { ...inputs, poolSpecSource: `${inputs.poolSpecSource}\n` }),
    /does not exactly match/
  );
  assert.throws(
    () => validateEventManifest(value, { ...inputs, serviceSpecSource: `${inputs.serviceSpecSource}\n` }),
    /does not exactly match/
  );
});

test("rejects source objects not derived from bound bytes", () => {
  const changedPool = structuredClone(inputs.poolSpec);
  changedPool.region = "nyc3";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      destroyAfter: "2026-07-20",
      ...inputs,
      poolSpec: changedPool
    }),
    /does not match the bound source bytes/
  );

  const changedServices = structuredClone(inputs.serviceSpec);
  changedServices.region = "nyc3";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      destroyAfter: "2026-07-20",
      ...inputs,
      serviceSpec: changedServices
    }),
    /does not match the bound source bytes/
  );
});

test("rejects a weakened pool and fixed-resource name collision", () => {
  const weakenedPool = structuredClone(inputs.poolSpec);
  weakenedPool.desiredCompositors = 7;
  weakenedPool.workers = weakenedPool.workers.filter((worker) => worker.court !== 8);
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      destroyAfter: "2026-07-20",
      ...inputs,
      poolSpec: weakenedPool,
      poolSpecSource: JSON.stringify(weakenedPool)
    }),
    /desired compositor count/
  );

  const collidingPool = structuredClone(inputs.poolSpec);
  collidingPool.workers[0].name = "bvm-preview-01";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      destroyAfter: "2026-07-20",
      ...inputs,
      poolSpec: collidingPool,
      poolSpecSource: JSON.stringify(collidingPool)
    }),
    /collides with a fixed event resource/
  );
});

test("rejects endpoint and fixed-service drift in the service pool", () => {
  const duplicateEndpoint = structuredClone(inputs.serviceSpec);
  duplicateEndpoint.endpoints.push(structuredClone(duplicateEndpoint.endpoints[0]));
  assert.throws(() => validateServiceSpec(duplicateEndpoint), /duplicated/);

  const wrongProfile = structuredClone(inputs.serviceSpec);
  wrongProfile.fixedServices[0].cloudInitProfile = "ingest";
  assert.throws(() => validateServiceSpec(wrongProfile), /role bootstrap profile/);

  const crossRoleSlot = structuredClone(inputs.serviceSpec);
  crossRoleSlot.endpoints.find((entry) => entry.role === "commentary").addressSlot = "ingest";
  assert.throws(() => validateServiceSpec(crossRoleSlot), /spans multiple roles/);
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
