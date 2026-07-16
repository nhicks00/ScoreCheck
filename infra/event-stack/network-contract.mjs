import { isDeepStrictEqual } from "node:util";
import { isIP } from "node:net";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const TAG = /^[A-Za-z0-9._:-]{1,100}$/u;
const PROTOCOLS = new Set(["icmp", "tcp", "udp"]);

export function validateNetworkContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("network contract must be an object");
  if (value.schemaVersion !== 1) throw new Error("network contract schemaVersion must be 1");
  if (typeof value.region !== "string" || !/^[a-z0-9-]{1,20}$/u.test(value.region)) throw new Error("network contract region is invalid");
  if (!UUID.test(value.vpcUuid ?? "")) throw new Error("network contract VPC UUID is invalid");
  if (!isPrivateIpv4Cidr(value.vpcCidr)) throw new Error("network contract VPC CIDR is invalid");
  if (!Array.isArray(value.firewalls) || value.firewalls.length !== 4) throw new Error("network contract must contain exactly four firewalls");
  const names = new Set();
  const tags = new Set();
  const firewalls = value.firewalls.map((firewall, index) => normalizeFirewall(firewall, index, names, tags));
  assertHardenedSshContract(firewalls);
  return { schemaVersion: 1, region: value.region, vpcUuid: value.vpcUuid, vpcCidr: value.vpcCidr, firewalls };
}

export function assertNetworkContractDeployable(value) {
  const contract = validateNetworkContract(value);
  const addresses = sshAddressSources(contract.firewalls[0]);
  for (const address of addresses) assertPublicAdminHostCidr(address);
  return contract;
}

export function renderAdminSshNetworkContract(templateInput, adminSshInput) {
  const template = validateNetworkContract(templateInput);
  const addresses = validateAdminSshCidrs(adminSshInput);
  const rendered = structuredClone(template);
  for (const firewall of rendered.firewalls) {
    const addressRule = firewall.inboundRules.find((rule) => isSshRule(rule) && rule.sources.addresses);
    addressRule.sources.addresses = [...addresses];
  }
  return assertNetworkContractDeployable(rendered);
}

export function validateAdminSshCidrs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new Error("admin SSH CIDR document schemaVersion must be 1");
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["addresses", "schemaVersion"])) {
    throw new Error("admin SSH CIDR document must contain exactly schemaVersion and addresses");
  }
  if (!Array.isArray(value.addresses) || value.addresses.length < 1 || value.addresses.length > 8) {
    throw new Error("admin SSH CIDR document must contain 1-8 host CIDRs");
  }
  const addresses = [...new Set(value.addresses)].sort();
  if (addresses.length !== value.addresses.length) throw new Error("admin SSH CIDRs must be unique");
  for (const address of addresses) assertPublicAdminHostCidr(address);
  return addresses;
}

export function networkContractProblems(contractInput, inventory) {
  const contract = validateNetworkContract(contractInput);
  const problems = [];
  const vpc = (inventory.vpcs ?? []).find((entry) => entry.uuid === contract.vpcUuid);
  if (!vpc) problems.push("the pinned DigitalOcean VPC is missing");
  else {
    if (vpc.region !== contract.region) problems.push("the pinned DigitalOcean VPC region changed");
    if (vpc.ipRange !== contract.vpcCidr) problems.push("the pinned DigitalOcean VPC CIDR changed");
  }
  const providerNames = new Set();
  for (const firewall of inventory.firewalls ?? []) {
    if (providerNames.has(firewall.name)) problems.push(`DigitalOcean returned duplicate firewall name ${firewall.name}`);
    providerNames.add(firewall.name);
  }
  for (const desired of contract.firewalls) {
    const actual = (inventory.firewalls ?? []).filter((entry) => entry.name === desired.name);
    if (actual.length !== 1) {
      problems.push(`firewall ${desired.name} is ${actual.length === 0 ? "missing" : "duplicated"}`);
      continue;
    }
    const candidate = actual[0];
    if (candidate.status !== "succeeded") problems.push(`firewall ${desired.name} status is ${candidate.status}`);
    if (!isDeepStrictEqual([...candidate.tags].sort(), [desired.targetTag])) problems.push(`firewall ${desired.name} target tag drifted`);
    if ((candidate.dropletIds ?? []).length !== 0) problems.push(`firewall ${desired.name} has direct Droplet attachments`);
    compareInventoryRules({ candidate, desired, direction: "inbound", peerKey: "sources", problems });
    compareInventoryRules({ candidate, desired, direction: "outbound", peerKey: "destinations", problems });
  }
  return problems;
}

function compareInventoryRules({ candidate, desired, direction, peerKey, problems }) {
  try {
    if (!isDeepStrictEqual(normalizeRules(candidate[`${direction}Rules`], peerKey, desired.name), desired[`${direction}Rules`])) {
      problems.push(`firewall ${desired.name} ${direction} rules drifted`);
    }
  } catch {
    problems.push(`firewall ${desired.name} ${direction} rules are structurally invalid`);
  }
}

export function firewallPayload(value) {
  const firewall = normalizeFirewall(value, 0, new Set(), new Set());
  return {
    name: firewall.name,
    inbound_rules: firewall.inboundRules.map((rule) => providerRule(rule, "sources")),
    outbound_rules: firewall.outboundRules.map((rule) => providerRule(rule, "destinations")),
    tags: [firewall.targetTag],
    droplet_ids: []
  };
}

function normalizeFirewall(firewall, index, names, tags) {
  if (!firewall || typeof firewall !== "object" || Array.isArray(firewall)) throw new Error(`firewall ${index + 1} is invalid`);
  if (typeof firewall.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(firewall.name) || names.has(firewall.name)) {
    throw new Error(`firewall ${index + 1} has an invalid or duplicated name`);
  }
  if (typeof firewall.targetTag !== "string" || !TAG.test(firewall.targetTag) || tags.has(firewall.targetTag)) {
    throw new Error(`firewall ${firewall.name} has an invalid or duplicated target tag`);
  }
  names.add(firewall.name);
  tags.add(firewall.targetTag);
  return {
    name: firewall.name,
    targetTag: firewall.targetTag,
    inboundRules: normalizeRules(firewall.inboundRules, "sources", firewall.name),
    outboundRules: normalizeRules(firewall.outboundRules, "destinations", firewall.name)
  };
}

function assertHardenedSshContract(firewalls) {
  let expectedAddresses = null;
  for (const firewall of firewalls) {
    const sshRules = firewall.inboundRules.filter(isSshRule);
    const addressRules = sshRules.filter((rule) => rule.sources.addresses);
    const tagRules = sshRules.filter((rule) => rule.sources.tags);
    if (addressRules.length !== 1) throw new Error(`firewall ${firewall.name} must have exactly one admin-address SSH rule`);
    const addresses = addressRules[0].sources.addresses;
    if (!addresses.every(isHostCidr)) throw new Error(`firewall ${firewall.name} SSH addresses must be /32 or /128 host CIDRs`);
    if (addresses.some((address) => address === "0.0.0.0/0" || address === "::/0")) {
      throw new Error(`firewall ${firewall.name} cannot expose SSH globally`);
    }
    if (expectedAddresses && !isDeepStrictEqual(addresses, expectedAddresses)) {
      throw new Error("all firewalls must use the same admin SSH CIDRs");
    }
    expectedAddresses = addresses;
    if (firewall.targetTag === "bvm-observability") {
      if (tagRules.length !== 0 || sshRules.length !== 1) throw new Error("observability SSH must use only protected admin CIDRs");
    } else if (tagRules.length !== 1
      || !isDeepStrictEqual(tagRules[0].sources.tags, ["bvm-observability"])
      || sshRules.length !== 2) {
      throw new Error(`firewall ${firewall.name} must allow SSH only from protected admin CIDRs and the observability bastion`);
    }
  }
}

function sshAddressSources(firewall) {
  return firewall.inboundRules.find((rule) => isSshRule(rule) && rule.sources.addresses)?.sources.addresses ?? [];
}

function isSshRule(rule) {
  return rule.protocol === "tcp" && rule.ports === "22";
}

function isHostCidr(value) {
  if (typeof value !== "string") return false;
  const separator = value.lastIndexOf("/");
  if (separator < 1) return false;
  const address = value.slice(0, separator);
  const prefix = value.slice(separator + 1);
  const family = isIP(address);
  return (family === 4 && prefix === "32") || (family === 6 && prefix === "128");
}

function assertPublicAdminHostCidr(value) {
  if (!isHostCidr(value)) throw new Error(`admin SSH source ${value} must be an IPv4 /32 or IPv6 /128 host CIDR`);
  const address = value.slice(0, value.lastIndexOf("/")).toLowerCase();
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    const forbidden = a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && c === 2)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
    if (forbidden) throw new Error(`admin SSH source ${value} must be a public operator host address`);
  } else if (!/^[23]/u.test(address) || address.startsWith("2001:db8")) {
    throw new Error(`admin SSH source ${value} must be a public operator host address`);
  }
}

function providerRule(rule, direction) {
  return { protocol: rule.protocol, ports: rule.ports, [direction]: structuredClone(rule[direction]) };
}

function normalizeRules(value, direction, firewallName) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`firewall ${firewallName} ${direction} rules are required`);
  const normalized = value.map((rule) => {
    if (!rule || typeof rule !== "object" || !PROTOCOLS.has(rule.protocol)) throw new Error(`firewall ${firewallName} has an invalid protocol`);
    const ports = String(rule.ports ?? "");
    if (!/^0|\d+(?:-\d+)?$/u.test(ports)) throw new Error(`firewall ${firewallName} has invalid ports`);
    const peers = rule[direction];
    if (!peers || typeof peers !== "object" || Array.isArray(peers)) throw new Error(`firewall ${firewallName} has invalid ${direction}`);
    const keys = Object.keys(peers).sort();
    if (keys.length !== 1 || !["addresses", "tags"].includes(keys[0])) throw new Error(`firewall ${firewallName} has unsupported ${direction}`);
    const entries = peers[keys[0]];
    if (!Array.isArray(entries) || entries.length === 0 || !entries.every((entry) => typeof entry === "string" && entry)) {
      throw new Error(`firewall ${firewallName} has invalid ${direction} entries`);
    }
    return { protocol: rule.protocol, ports, [direction]: { [keys[0]]: [...new Set(entries)].sort() } };
  });
  return normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function isPrivateIpv4Cidr(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  return octets.every((entry) => entry >= 0 && entry <= 255) && prefix >= 16 && prefix <= 28 && (
    octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  );
}
