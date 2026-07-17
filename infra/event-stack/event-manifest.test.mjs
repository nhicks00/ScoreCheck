import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    kind: "rehearsal",
    destroyAfter: "2026-07-20",
    ...inputs
  });
}

test("generates isolated provider services, endpoints, eight assigned workers, and warm spare", () => {
  const value = manifest();
  assert.equal(value.schemaVersion, 5);
  assert.equal(value.kind, "rehearsal");
  assert.equal(value.droplets.length, 12);
  assert.deepEqual(value.droplets.slice(0, 3).map((entry) => entry.name), [
    "bvm-commentary-01",
    "bvm-observability-01",
    "bvm-preview-01"
  ]);
  assert.equal(new Set(value.droplets.map((entry) => entry.providerName)).size, 12);
  assert.ok(value.droplets.every((entry) => entry.providerName.startsWith(`${value.namespace}-`)));
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
    providerName: `${value.namespace}-bvm-compositor-spare`,
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
  assert.equal(value.endpoints.filter((entry) => entry.addressMode === "reserved-ipv4").length, 0);
  assert.equal(value.endpoints.filter((entry) => entry.addressMode === "dynamic-ipv4").length, 4);
  assert.ok(value.endpoints.every((entry) => entry.addressSlot === undefined));
  assert.ok(value.endpoints.filter((entry) => entry.role !== "commentary").every((entry) => entry.hostname.includes(value.namespace)));
  assert.ok(value.endpoints.filter((entry) => entry.role === "commentary").every((entry) => entry.hostname.includes("-rehearsal.")));
  assert.match(value.sourceBindings.compositorPoolSpecSha256, /^[a-f0-9]{64}$/);
  assert.match(value.sourceBindings.serviceSpecSha256, /^[a-f0-9]{64}$/);
  assert.match(value.sourceBindings.networkSpecSha256, /^[a-f0-9]{64}$/);
  assert.equal(value.network.vpcUuid, value.provider.vpcUuid);
  assert.equal(value.network.vpcCidr, value.provider.vpcCidr);
  assert.deepEqual(validateEventManifest(value, inputs), value);
});

for (const [name, mutate] of [
  ["missing worker", (value) => value.droplets.pop()],
  ["extra worker", (value) => value.droplets.push({ name: "rogue", role: "compositor", court: 8 })],
  ["changed court", (value) => { value.droplets.find((entry) => entry.name === "bvm-compositor-h").court = 7; }],
  ["changed fixed role", (value) => { value.droplets[0].role = "ingest"; }],
  ["changed fixed size", (value) => { value.droplets[0].size = "c-4"; }],
  ["changed pool digest", (value) => { value.sourceBindings.compositorPoolSpecSha256 = "0".repeat(64); }],
  ["changed network digest", (value) => { value.sourceBindings.networkSpecSha256 = "0".repeat(64); }],
  ["changed firewall target", (value) => { value.network.firewalls[0].targetTag = "wrong"; }],
  ["changed endpoint mode", (value) => { value.endpoints[0].addressMode = "reserved-ipv4"; value.endpoints[0].addressSlot = "ingest"; }],
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
    () => buildEventManifest({ event: "NOT VALID", kind: "rehearsal", destroyAfter: "2026-07-20", ...inputs }),
    /event slug/
  );
  assert.throws(
    () => buildEventManifest({ event: "valid", kind: "rehearsal", destroyAfter: "2026-02-30", ...inputs }),
    /real calendar date/
  );
  assert.throws(
    () => buildEventManifest({ event: "valid", destroyAfter: "2026-07-20", ...inputs }),
    /event kind/
  );
});

test("hard-cuts schema-v4 event bundles", () => {
  const value = manifest();
  value.schemaVersion = 4;
  assert.throws(() => validateEventManifest(value, inputs), /schemaVersion must be 5/u);
});

test("production keeps canonical endpoints while rehearsal is isolated by deterministic bounded identity", () => {
  const production = buildEventManifest({
    event: "same-event",
    kind: "production",
    destroyAfter: "2026-07-20",
    ...inputs
  });
  const rehearsal = buildEventManifest({
    event: "same-event",
    kind: "rehearsal",
    destroyAfter: "2026-07-20",
    ...inputs
  });
  assert.deepEqual(production.endpoints.map((entry) => entry.hostname), inputs.serviceSpec.endpoints.map((entry) => entry.hostname));
  assert.equal(production.endpoints.filter((entry) => entry.addressMode === "reserved-ipv4").length, 3);
  assert.ok(rehearsal.endpoints.every((entry) => !production.endpoints.some((candidate) => candidate.hostname === entry.hostname)));
  assert.ok(rehearsal.endpoints.every((entry) => entry.addressMode === "dynamic-ipv4" && entry.addressSlot === undefined));
  assert.deepEqual(rehearsal.endpoints.filter((entry) => entry.role === "commentary").map((entry) => entry.hostname).sort(), [
    "rtc-rehearsal.beachvolleyballmedia.com",
    "turn-rehearsal.beachvolleyballmedia.com"
  ]);
  assert.deepEqual(production.droplets.map((entry) => entry.name), rehearsal.droplets.map((entry) => entry.name));
  assert.notDeepEqual(production.droplets.map((entry) => entry.providerName), rehearsal.droplets.map((entry) => entry.providerName));

  const longest = buildEventManifest({
    event: `a${"b".repeat(61)}c`,
    kind: "rehearsal",
    destroyAfter: "2026-07-20",
    ...inputs
  });
  assert.ok(longest.namespace.length <= 24);
  assert.ok(longest.droplets.every((entry) => entry.providerName.length <= 63));
  assert.ok(longest.endpoints.every((entry) => entry.hostname.split(".")[0].length <= 63));
  assert.deepEqual(validateEventManifest(longest, inputs), longest);
});

test("binds service and pool bytes while canonicalizing the embedded network", () => {
  const value = manifest();
  assert.throws(
    () => validateEventManifest(value, { ...inputs, poolSpecSource: `${inputs.poolSpecSource}\n` }),
    /does not exactly match/
  );
  assert.throws(
    () => validateEventManifest(value, { ...inputs, serviceSpecSource: `${inputs.serviceSpecSource}\n` }),
    /does not exactly match/
  );
  assert.deepEqual(validateEventManifest(value, { ...inputs, networkSpecSource: `${inputs.networkSpecSource}\n` }), value);
});

test("validates a rendered manifest from its canonical embedded network", async () => {
  const effectiveNetwork = structuredClone(inputs.networkSpec);
  for (const firewall of effectiveNetwork.firewalls) {
    firewall.inboundRules.find((rule) => rule.protocol === "tcp" && rule.ports === "22" && rule.sources.addresses).sources.addresses = ["1.1.1.1/32"];
  }
  const effectiveInputs = { ...inputs, networkSpec: effectiveNetwork, networkSpecSource: JSON.stringify(effectiveNetwork) };
  const value = buildEventManifest({ event: "embedded-network", kind: "production", destroyAfter: "2026-07-20", ...effectiveInputs });
  const embeddedInputs = await loadManifestInputs({ networkFromManifest: value.network });
  assert.deepEqual(validateEventManifest(value, embeddedInputs), value);
  await assert.rejects(() => loadManifestInputs({ networkSpec: "/tmp/network.json", networkFromManifest: value.network }), /mutually exclusive/u);
});

test("rejects source objects not derived from bound bytes", () => {
  const changedPool = structuredClone(inputs.poolSpec);
  changedPool.region = "nyc3";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      kind: "rehearsal",
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
      kind: "rehearsal",
      destroyAfter: "2026-07-20",
      ...inputs,
      serviceSpec: changedServices
    }),
    /does not match the bound source bytes/
  );

  const changedNetwork = structuredClone(inputs.networkSpec);
  changedNetwork.region = "nyc3";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      kind: "rehearsal",
      destroyAfter: "2026-07-20",
      ...inputs,
      networkSpec: changedNetwork
    }),
    /does not match the bound source bytes/
  );
});

test("rejects service-to-network VPC and target-tag drift", () => {
  const changedVpcs = structuredClone(inputs.networkSpec);
  changedVpcs.vpcCidr = "10.121.0.0/20";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      kind: "rehearsal",
      destroyAfter: "2026-07-20",
      ...inputs,
      networkSpec: changedVpcs,
      networkSpecSource: JSON.stringify(changedVpcs)
    }),
    /VPC identity must match exactly/u
  );

  const changedTags = structuredClone(inputs.networkSpec);
  changedTags.firewalls[0].targetTag = "bvm-preview-wrong";
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      kind: "rehearsal",
      destroyAfter: "2026-07-20",
      ...inputs,
      networkSpec: changedTags,
      networkSpecSource: JSON.stringify(changedTags)
    }),
    /target tags must exactly match/u
  );
});

test("rejects a weakened pool and fixed-resource name collision", () => {
  const weakenedPool = structuredClone(inputs.poolSpec);
  weakenedPool.desiredCompositors = 7;
  weakenedPool.workers = weakenedPool.workers.filter((worker) => worker.court !== 8);
  assert.throws(
    () => buildEventManifest({
      event: "valid",
      kind: "rehearsal",
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
      kind: "rehearsal",
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
      "--kind", "rehearsal",
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
  const network = structuredClone(inputs.networkSpec);
  for (const firewall of network.firewalls) {
    firewall.inboundRules.find((rule) => rule.protocol === "tcp" && rule.ports === "22" && rule.sources.addresses).sources.addresses = ["1.1.1.1/32"];
  }
  const networkPath = join(directory, "network.json");
  await writeFile(networkPath, `${JSON.stringify(network, null, 2)}\n`, { mode: 0o600 });
  await chmod(networkPath, 0o600);
  const tool = fileURLToPath(new URL("./event-manifest.mjs", import.meta.url));
  const args = [
    tool,
    "generate",
    "--event", "valid",
    "--kind", "rehearsal",
    "--destroy-after", "2026-07-20",
    "--output", output,
    "--network-spec", networkPath
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
