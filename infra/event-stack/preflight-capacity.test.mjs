import assert from "node:assert/strict";
import test from "node:test";

import { completeCollection, evaluateCapacity } from "./preflight-capacity.mjs";

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
