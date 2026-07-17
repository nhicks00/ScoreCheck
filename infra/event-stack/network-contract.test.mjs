import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertNetworkContractDeployable, firewallPayload, networkContractProblems, networkContractTags, validateNetworkContract } from "./network-contract.mjs";

const source = JSON.parse(await readFile(new URL("./network-contract.json", import.meta.url), "utf8"));

test("validates the exact persistent VPC and four tag-addressed firewalls", () => {
  const contract = validateNetworkContract(source);
  assert.equal(contract.vpcUuid, "6ece4819-6f6a-4ab9-934c-f6a92660aab2");
  assert.equal(contract.vpcCidr, "10.120.0.0/20");
  assert.deepEqual(contract.firewalls.map((entry) => entry.targetTag), [
    "bvm-preview-01",
    "bvm-commentary",
    "bvm-compositor",
    "bvm-observability"
  ]);
  assert.deepEqual(firewallPayload(contract.firewalls[0]).droplet_ids, []);
  assert.deepEqual(networkContractTags(contract), [
    "bvm-commentary",
    "bvm-compositor",
    "bvm-observability",
    "bvm-preview-01"
  ]);
  assert.equal(contract.firewalls.some((firewall) => firewall.inboundRules.some((rule) =>
    rule.protocol === "tcp" && rule.ports === "22" && rule.sources.addresses?.some((address) => address.endsWith("/0")))), false);
  assert.deepEqual(
    contract.firewalls[0].inboundRules.find((rule) => rule.ports === "8554"),
    { protocol: "tcp", ports: "8554", sources: { tags: ["bvm-compositor"] } }
  );
});

test("keeps the checked-in admin address nondeployable", () => {
  assert.throws(() => assertNetworkContractDeployable(source), /public operator host address/u);
});

test("rejects duplicate target tags and non-private VPC ranges", () => {
  const duplicate = structuredClone(source);
  duplicate.firewalls[1].targetTag = duplicate.firewalls[0].targetTag;
  assert.throws(() => validateNetworkContract(duplicate), /duplicated target tag/u);

  const publicVpc = structuredClone(source);
  publicVpc.vpcCidr = "203.0.113.0/24";
  assert.throws(() => validateNetworkContract(publicVpc), /VPC CIDR/u);
});

test("reports source-tag, direct-attachment, VPC, and rule drift", () => {
  const contract = validateNetworkContract(source);
  const inventory = {
    vpcs: [{ uuid: contract.vpcUuid, region: contract.region, ipRange: "10.121.0.0/20" }],
    firewalls: contract.firewalls.map((firewall, index) => ({
      id: String(index + 1),
      name: firewall.name,
      status: "succeeded",
      tags: [firewall.targetTag],
      dropletIds: [],
      inboundRules: firewall.inboundRules,
      outboundRules: firewall.outboundRules
    }))
  };
  inventory.firewalls[0].tags = ["wrong-tag"];
  inventory.firewalls[1].dropletIds = ["123"];
  inventory.firewalls[2].inboundRules = [];
  const problems = networkContractProblems(contract, inventory);
  assert.ok(problems.some((entry) => entry.includes("VPC CIDR changed")));
  assert.ok(problems.some((entry) => entry.includes("target tag drifted")));
  assert.ok(problems.some((entry) => entry.includes("direct Droplet attachments")));
  assert.ok(problems.some((entry) => entry.includes("inbound rules are structurally invalid")));
});
