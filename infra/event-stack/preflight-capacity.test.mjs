import assert from "node:assert/strict";
import test from "node:test";

import { completeCollection, evaluateCapacity, validateFleetSpec } from "./preflight-capacity.mjs";

test("blocks an eight-compositor pool before partial provisioning exceeds quota", () => {
  const result = evaluateCapacity(fixture({ dropletLimit: 10, dropletCount: 7, compositorCount: 4 }));
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.compositors.additionsRequired, 4);
  assert.equal(result.compositors.totalDropletsAfterProvisioning, 11);
  assert.match(result.blockers.join(" "), /limit 10 cannot fit 11/);
});

test("passes when quota and the requested regional size can fit the complete pool", () => {
  const result = evaluateCapacity(fixture({ dropletLimit: 12, dropletCount: 7, compositorCount: 4 }));
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.incrementalCost.hourly, 0.5);
  assert.equal(result.incrementalCost.monthlyEquivalent, 336);
});

test("includes a warm spare in quota and cost calculations", () => {
  const result = evaluateCapacity(fixture({ dropletLimit: 12, dropletCount: 7, compositorCount: 4, warmSpares: 1 }));
  assert.equal(result.status, "PASS");
  assert.equal(result.compositors.target, 9);
  assert.equal(result.compositors.additionsRequired, 5);
  assert.equal(result.compositors.totalDropletsAfterProvisioning, 12);
});

test("does not count inactive or incompatible tagged workers as qualified capacity", () => {
  const input = fixture({ dropletLimit: 15, dropletCount: 7, compositorCount: 4 });
  input.dropletsPayload.droplets[0].status = "off";
  input.dropletsPayload.droplets[1].size_slug = "s-4vcpu-8gb";
  const result = evaluateCapacity(input);
  assert.equal(result.compositors.matchingActive, 2);
  assert.equal(result.compositors.additionsRequired, 6);
  assert.equal(result.compositors.incompatibleTagged.length, 2);
});

test("fails closed when the size is absent or unavailable in the region", () => {
  const missing = evaluateCapacity(fixture({ sizeSlug: "c-8" }));
  assert.equal(missing.status, "BLOCKED");
  assert.match(missing.blockers.join(" "), /not exposed/);

  const wrongRegionInput = fixture({ region: "nyc2" });
  const wrongRegion = evaluateCapacity(wrongRegionInput);
  assert.equal(wrongRegion.status, "BLOCKED");
  assert.match(wrongRegion.blockers.join(" "), /not available in nyc2/);
});

test("does not report missing provider pricing as zero cost", () => {
  const input = fixture({ dropletLimit: 12 });
  delete input.sizesPayload.sizes[0].price_hourly;
  delete input.sizesPayload.sizes[0].price_monthly;
  const result = evaluateCapacity(input);
  assert.equal(result.incrementalCost.hourly, null);
  assert.equal(result.incrementalCost.monthlyEquivalent, null);
});

test("blocks provisioning when the provider account is not active", () => {
  const input = fixture({ dropletLimit: 12 });
  input.account.status = "locked";
  const result = evaluateCapacity(input);
  assert.equal(result.status, "BLOCKED");
  assert.match(result.blockers.join(" "), /status is locked/);
});

test("rejects truncated provider collections instead of undercounting", () => {
  assert.throws(
    () => completeCollection({ droplets: [{}], meta: { total: 2 } }, "droplets"),
    /incomplete \(1\/2\)/
  );
});

test("plans the exact approved worker slots instead of treating arbitrary tagged capacity as interchangeable", () => {
  const input = exactFleetFixture({ dropletLimit: 10 });
  const result = evaluateCapacity(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.compositors.matchingActive, 4);
  assert.deepEqual(result.compositors.exactPlan.matchedNames, [
    "bvm-compositor-a",
    "bvm-compositor-b",
    "bvm-compositor-c",
    "bvm-compositor-d"
  ]);
  assert.deepEqual(result.compositors.exactPlan.missingSlots, [
    { name: "bvm-compositor-e", court: 5 },
    { name: "bvm-compositor-f", court: 6 },
    { name: "bvm-compositor-g", court: 7 },
    { name: "bvm-compositor-h", court: 8 },
    { name: "bvm-compositor-spare", warmSpare: true }
  ]);
  assert.equal(result.compositors.additionsRequired, 5);
  assert.equal(result.compositors.totalDropletsAfterProvisioning, 12);
  assert.equal(result.compositors.exactPlan.complete, false);
});

test("marks only the full nine-worker exact pool complete", () => {
  const result = evaluateCapacity(exactFleetFixture({
    dropletLimit: 12,
    dropletCount: 12,
    matchingCompositors: 9
  }));
  assert.equal(result.status, "PASS");
  assert.equal(result.compositors.matchingActive, 9);
  assert.equal(result.compositors.additionsRequired, 0);
  assert.equal(result.compositors.totalDropletsAfterProvisioning, 12);
  assert.equal(result.compositors.exactPlan.complete, true);
  assert.deepEqual(result.compositors.exactPlan.missingSlots, []);
});

test("fails closed when a planned name exists with the wrong shape instead of creating a duplicate name", () => {
  const input = exactFleetFixture({ dropletLimit: 15, dropletCount: 8 });
  input.dropletsPayload.droplets[4] = {
    ...input.dropletsPayload.droplets[4],
    name: "bvm-compositor-e",
    status: "off",
    image: { id: 999, slug: "debian-13-x64" },
    tags: ["bvm-compositor"]
  };
  const result = evaluateCapacity(input);
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.compositors.exactPlan.conflicts.length, 1);
  assert.equal(result.compositors.exactPlan.conflicts[0].name, "bvm-compositor-e");
  assert.match(result.blockers.join(" "), /status is off/);
  assert.match(result.blockers.join(" "), /image is debian-13-x64/);
  assert.equal(result.compositors.exactPlan.missingSlots.some((slot) => slot.name === "bvm-compositor-e"), false);
});

test("fails closed when a tagged compositor exists outside the approved pool", () => {
  const input = exactFleetFixture({ dropletLimit: 15, dropletCount: 8 });
  input.dropletsPayload.droplets[4] = {
    ...input.dropletsPayload.droplets[4],
    name: "bvm-compositor-legacy",
    size_slug: "c-4",
    tags: ["bvm-compositor"]
  };
  const result = evaluateCapacity(input);
  assert.equal(result.status, "BLOCKED");
  assert.deepEqual(result.compositors.exactPlan.extraTagged, ["bvm-compositor-legacy"]);
  assert.match(result.blockers.join(" "), /outside the approved pool/);
});

test("rejects duplicate names and incomplete court assignments in the fleet specification", () => {
  const duplicate = approvedFleetSpec();
  duplicate.workers[1].name = duplicate.workers[0].name;
  assert.throws(() => validateFleetSpec(duplicate), /duplicated/);

  const duplicateCourt = approvedFleetSpec();
  duplicateCourt.workers[1].court = 1;
  assert.throws(() => validateFleetSpec(duplicateCourt), /court 1 is duplicated/);

  const numericName = approvedFleetSpec();
  numericName.workers[0].name = 123;
  assert.throws(() => validateFleetSpec(numericName), /invalid name/);
});

function fixture({
  dropletLimit = 12,
  dropletCount = 7,
  compositorCount = 4,
  desiredCompositors = 8,
  warmSpares = 0,
  sizeSlug = "c-4",
  region = "sfo2"
} = {}) {
  const droplets = Array.from({ length: dropletCount }, (_, index) => ({
    id: index + 1,
    name: index < compositorCount ? `bvm-compositor-${index + 1}` : `bvm-service-${index + 1}`,
    status: "active",
    size_slug: index < compositorCount ? "c-4" : "s-2vcpu-4gb",
    region: { slug: "sfo2" },
    image: { id: 235153036, slug: "ubuntu-24-04-x64" },
    tags: index < compositorCount ? ["bvm-compositor"] : []
  }));
  return {
    account: { status: "active", droplet_limit: dropletLimit },
    dropletsPayload: { droplets, meta: { total: droplets.length } },
    sizesPayload: {
      sizes: [{
        slug: "c-4",
        available: true,
        regions: ["sfo2"],
        vcpus: 4,
        memory: 8192,
        price_hourly: 0.125,
        price_monthly: 84
      }],
      meta: { total: 1 }
    },
    desiredCompositors,
    warmSpares,
    sizeSlug,
    region
  };
}

function exactFleetFixture({ dropletLimit = 12, dropletCount = 7, matchingCompositors = 4 } = {}) {
  const input = fixture({
    dropletLimit,
    dropletCount,
    compositorCount: matchingCompositors,
    desiredCompositors: 8,
    warmSpares: 1
  });
  const fleetSpec = approvedFleetSpec();
  for (let index = 0; index < matchingCompositors; index += 1) {
    input.dropletsPayload.droplets[index].name = fleetSpec.workers[index].name;
  }
  input.fleetSpec = fleetSpec;
  return input;
}

function approvedFleetSpec() {
  return {
    schemaVersion: 1,
    region: "sfo2",
    size: "c-4",
    image: "ubuntu-24-04-x64",
    desiredCompositors: 8,
    warmSpares: 1,
    workers: [
      { name: "bvm-compositor-a", court: 1 },
      { name: "bvm-compositor-b", court: 2 },
      { name: "bvm-compositor-c", court: 3 },
      { name: "bvm-compositor-d", court: 4 },
      { name: "bvm-compositor-e", court: 5 },
      { name: "bvm-compositor-f", court: 6 },
      { name: "bvm-compositor-g", court: 7 },
      { name: "bvm-compositor-h", court: 8 },
      { name: "bvm-compositor-spare", warmSpare: true }
    ]
  };
}
