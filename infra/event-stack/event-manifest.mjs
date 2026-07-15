#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { isPrivateIpv4Cidr, validateNetworkContract } from "./network-contract.mjs";
import { validateFleetSpec } from "./preflight-capacity.mjs";

const DEFAULT_POOL_SPEC = fileURLToPath(new URL("./compositor-pool.json", import.meta.url));
const DEFAULT_SERVICE_SPEC = fileURLToPath(new URL("./service-pool.json", import.meta.url));
const DEFAULT_NETWORK_SPEC = fileURLToPath(new URL("./network-contract.json", import.meta.url));
const CLOUD_INIT_PATHS = Object.freeze({
  commentary: fileURLToPath(new URL("../commentary/cloud-init.yaml", import.meta.url)),
  observability: fileURLToPath(new URL("../monitoring/cloud-init.yaml", import.meta.url)),
  ingest: fileURLToPath(new URL("../mediamtx/cloud-init.yaml", import.meta.url)),
  compositor: fileURLToPath(new URL("../compositor/cloud-init.yaml", import.meta.url))
});
const EVENT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROVIDER_VALUE = /^[A-Za-z0-9._-]{1,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_FIXED_ROLES = Object.freeze(["commentary", "observability", "ingest"]);
const MANIFEST_KINDS = new Set(["production", "rehearsal"]);
const EVENT_NAMESPACE_PREFIX_LENGTH = 15;

export function buildEventManifest({
  event,
  destroyAfter,
  kind,
  poolSpec,
  poolSpecSource,
  serviceSpec,
  serviceSpecSource,
  networkSpec,
  networkSpecSource,
  cloudInitSources
}) {
  assertEvent(event);
  assertDate(destroyAfter);
  assertKind(kind);
  assertBoundSource(poolSpec, poolSpecSource, "pool spec");
  assertBoundSource(serviceSpec, serviceSpecSource, "service spec");
  assertBoundSource(networkSpec, networkSpecSource, "network spec");
  const pool = validateFleetSpec(poolSpec, { desiredCompositors: 8, warmSpares: 1 });
  const services = validateServiceSpec(serviceSpec);
  const network = validateNetworkContract(networkSpec);
  if (pool.region !== services.region) throw new Error("service and compositor regions must match");
  if (network.region !== services.region || network.vpcUuid !== services.vpcUuid || network.vpcCidr !== services.vpcCidr) {
    throw new Error("service and network VPC identity must match exactly");
  }
  const desiredTargetTags = [...services.fixedServices.map((resource) => resource.tag), "bvm-compositor"].sort();
  const networkTargetTags = network.firewalls.map((firewall) => firewall.targetTag).sort();
  if (!isDeepStrictEqual(networkTargetTags, desiredTargetTags)) {
    throw new Error("network firewall target tags must exactly match the event service tags");
  }
  const cloudInitBindings = validateCloudInitSources(cloudInitSources);
  if (!cloudInitSources.ingest.includes(network.vpcCidr)) {
    throw new Error("ingest cloud-init does not allow the bound event VPC CIDR");
  }

  const fixedNames = new Set(services.fixedServices.map((resource) => resource.name));
  const collision = pool.workers.find((worker) => fixedNames.has(worker.name));
  if (collision) throw new Error(`fleet worker ${collision.name} collides with a fixed event resource`);

  const namespace = eventNamespace({ event, destroyAfter, kind });
  const fixed = services.fixedServices.map((resource) => ({
    ...resource,
    providerName: providerResourceName(namespace, resource.name),
    region: services.region,
    image: services.image,
    cloudInitSha256: cloudInitBindings[resource.cloudInitProfile]
  }));
  const workers = pool.workers.map((worker) => ({
    name: worker.name,
    providerName: providerResourceName(namespace, worker.name),
    role: worker.warmSpare ? "compositor-spare" : "compositor",
    ...(worker.warmSpare ? { warmSpare: true } : { court: worker.court }),
    region: pool.region,
    size: pool.size,
    image: pool.image,
    tag: "bvm-compositor",
    cloudInitProfile: "compositor",
    cloudInitSha256: cloudInitBindings.compositor
  }));
  const droplets = [...fixed, ...workers];
  if (droplets.length > services.minimumAccountDropletLimit) {
    throw new Error("minimum account Droplet limit cannot fit the declared stack");
  }

  return {
    schemaVersion: 4,
    event,
    kind,
    namespace,
    destroyAfter,
    provider: {
      name: "digitalocean",
      region: services.region,
      vpcUuid: services.vpcUuid,
      vpcCidr: services.vpcCidr,
      minimumAccountDropletLimit: services.minimumAccountDropletLimit
    },
    dns: {
      provider: "vercel",
      zone: services.dnsZone
    },
    network,
    sourceBindings: {
      serviceSpecSha256: sha256(serviceSpecSource),
      compositorPoolSpecSha256: sha256(poolSpecSource),
      networkSpecSha256: sha256(networkSpecSource),
      cloudInitSha256: cloudInitBindings
    },
    compositorPool: {
      region: pool.region,
      size: pool.size,
      image: pool.image,
      desiredCompositors: pool.desiredCompositors,
      warmSpares: pool.warmSpares
    },
    endpoints: scopedEndpoints(services.endpoints, services.dnsZone, kind, namespace),
    droplets
  };
}

export function validateEventManifest(manifest, inputs) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("event manifest must be an object");
  }
  if (manifest.schemaVersion !== 4) throw new Error("event manifest schemaVersion must be 4");
  const bindings = manifest.sourceBindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error("event manifest source bindings are required");
  }
  for (const digest of [bindings.serviceSpecSha256, bindings.compositorPoolSpecSha256, bindings.networkSpecSha256]) {
    if (!SHA256.test(digest ?? "")) throw new Error("event manifest source digest is invalid");
  }
  const expected = buildEventManifest({
    event: manifest.event,
    destroyAfter: manifest.destroyAfter,
    kind: manifest.kind,
    ...inputs
  });
  if (!isDeepStrictEqual(manifest, expected)) {
    throw new Error("event manifest does not exactly match the bound service, compositor, endpoint, and bootstrap specifications");
  }
  return expected;
}

export function validateServiceSpec(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service spec must be an object");
  if (value.schemaVersion !== 2) throw new Error("service spec schemaVersion must be 2");
  if (typeof value.region !== "string" || !/^[a-z0-9-]{1,20}$/.test(value.region)) {
    throw new Error("service spec region is invalid");
  }
  if (typeof value.image !== "string" || !PROVIDER_VALUE.test(value.image)) throw new Error("service spec image is invalid");
  if (typeof value.vpcUuid !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.vpcUuid)) {
    throw new Error("service spec VPC UUID is invalid");
  }
  if (!isPrivateIpv4Cidr(value.vpcCidr)) {
    throw new Error("service spec VPC CIDR is invalid");
  }
  if (!Number.isInteger(value.minimumAccountDropletLimit) || value.minimumAccountDropletLimit < 1) {
    throw new Error("service spec minimum account Droplet limit is invalid");
  }
  if (typeof value.dnsZone !== "string" || !isDnsName(value.dnsZone)) throw new Error("service spec DNS zone is invalid");
  if (!Array.isArray(value.fixedServices) || value.fixedServices.length !== REQUIRED_FIXED_ROLES.length) {
    throw new Error("service spec must contain exactly three fixed services");
  }

  const names = new Set();
  const roles = new Set();
  const fixedServices = value.fixedServices.map((service, index) => {
    if (!service || typeof service !== "object" || Array.isArray(service)) {
      throw new Error(`fixed service ${index + 1} must be an object`);
    }
    if (typeof service.name !== "string" || !RESOURCE_NAME.test(service.name)) {
      throw new Error(`fixed service ${index + 1} has an invalid name`);
    }
    if (names.has(service.name)) throw new Error(`fixed service name ${service.name} is duplicated`);
    names.add(service.name);
    if (!REQUIRED_FIXED_ROLES.includes(service.role)) throw new Error(`fixed service ${service.name} has an invalid role`);
    if (roles.has(service.role)) throw new Error(`fixed service role ${service.role} is duplicated`);
    roles.add(service.role);
    for (const [key, raw] of [["size", service.size], ["tag", service.tag], ["cloudInitProfile", service.cloudInitProfile]]) {
      if (typeof raw !== "string" || !PROVIDER_VALUE.test(raw)) throw new Error(`fixed service ${service.name} has an invalid ${key}`);
    }
    if (service.cloudInitProfile !== service.role) {
      throw new Error(`fixed service ${service.name} must use its role bootstrap profile`);
    }
    return {
      name: service.name,
      role: service.role,
      size: service.size,
      tag: service.tag,
      cloudInitProfile: service.cloudInitProfile
    };
  });
  if (!REQUIRED_FIXED_ROLES.every((role) => roles.has(role))) throw new Error("service spec fixed roles are incomplete");

  if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) throw new Error("service spec endpoints are required");
  const hostnames = new Set();
  const endpoints = value.endpoints.map((endpoint, index) => {
    if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) {
      throw new Error(`endpoint ${index + 1} must be an object`);
    }
    const hostname = endpoint.hostname;
    if (typeof hostname !== "string" || !isDnsName(hostname) || !hostname.endsWith(`.${value.dnsZone}`)) {
      throw new Error(`endpoint ${index + 1} has an invalid hostname`);
    }
    if (hostnames.has(hostname)) throw new Error(`endpoint hostname ${hostname} is duplicated`);
    hostnames.add(hostname);
    if (!roles.has(endpoint.role)) throw new Error(`endpoint ${hostname} references an unknown role`);
    if (!new Set(["reserved-ipv4", "dynamic-ipv4"]).has(endpoint.addressMode)) {
      throw new Error(`endpoint ${hostname} has an invalid address mode`);
    }
    if (!Number.isInteger(endpoint.ttl) || endpoint.ttl < 60 || endpoint.ttl > 300) {
      throw new Error(`endpoint ${hostname} TTL must be from 60 through 300 seconds`);
    }
    if (endpoint.addressMode === "reserved-ipv4") {
      if (typeof endpoint.addressSlot !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(endpoint.addressSlot)) {
        throw new Error(`endpoint ${hostname} requires a valid reserved address slot`);
      }
    } else if (endpoint.addressSlot !== undefined) {
      throw new Error(`dynamic endpoint ${hostname} cannot declare an address slot`);
    }
    return {
      hostname,
      role: endpoint.role,
      addressMode: endpoint.addressMode,
      ...(endpoint.addressMode === "reserved-ipv4" ? { addressSlot: endpoint.addressSlot } : {}),
      ttl: endpoint.ttl
    };
  });
  const reservedRoles = new Map();
  for (const endpoint of endpoints.filter((entry) => entry.addressMode === "reserved-ipv4")) {
    const previous = reservedRoles.get(endpoint.addressSlot);
    if (previous && previous !== endpoint.role) throw new Error(`reserved address slot ${endpoint.addressSlot} spans multiple roles`);
    reservedRoles.set(endpoint.addressSlot, endpoint.role);
  }

  return {
    schemaVersion: 2,
    region: value.region,
    vpcUuid: value.vpcUuid,
    vpcCidr: value.vpcCidr,
    image: value.image,
    minimumAccountDropletLimit: value.minimumAccountDropletLimit,
    dnsZone: value.dnsZone,
    fixedServices,
    endpoints
  };
}

export function parseArgs(argv) {
  const command = argv[0];
  if (["-h", "--help", "help"].includes(command)) return null;
  if (!new Set(["generate", "validate"]).has(command)) throw new Error("command must be generate or validate");
  const options = {
    command,
    event: null,
    kind: null,
    destroyAfter: null,
    output: null,
    manifest: null,
    poolSpec: DEFAULT_POOL_SPEC,
    serviceSpec: DEFAULT_SERVICE_SPEC,
    networkSpec: DEFAULT_NETWORK_SPEC
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--event") options.event = requiredValue(argv, ++index, argument);
    else if (argument === "--kind") options.kind = requiredValue(argv, ++index, argument);
    else if (argument === "--destroy-after") options.destroyAfter = requiredValue(argv, ++index, argument);
    else if (argument === "--output") {
      const output = requiredValue(argv, ++index, argument);
      if (!isAbsolute(output)) throw new Error("--output must be an absolute path");
      options.output = resolve(output);
    } else if (argument === "--manifest") options.manifest = resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--pool-spec") options.poolSpec = resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--service-spec") options.serviceSpec = resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--network-spec") options.networkSpec = resolve(requiredValue(argv, ++index, argument));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (command === "generate") {
    assertEvent(options.event);
    assertDate(options.destroyAfter);
    assertKind(options.kind);
    if (!options.output) throw new Error("--output must be an absolute path");
    if (options.manifest) throw new Error("--manifest is not valid for generate");
  } else {
    if (!options.manifest) throw new Error("--manifest is required for validate");
    if (options.event || options.kind || options.destroyAfter || options.output) {
      throw new Error("--event, --kind, --destroy-after, and --output are not valid for validate");
    }
  }
  return options;
}

export async function loadManifestInputs({
  poolSpec: poolPath = DEFAULT_POOL_SPEC,
  serviceSpec: servicePath = DEFAULT_SERVICE_SPEC,
  networkSpec: networkPath = DEFAULT_NETWORK_SPEC
} = {}) {
  const [poolSpecSource, serviceSpecSource, networkSpecSource, entries] = await Promise.all([
    readFile(poolPath, "utf8"),
    readFile(servicePath, "utf8"),
    readFile(networkPath, "utf8"),
    Promise.all(Object.entries(CLOUD_INIT_PATHS).map(async ([profile, path]) => [profile, await readFile(path, "utf8")]))
  ]);
  return {
    poolSpec: JSON.parse(poolSpecSource),
    poolSpecSource,
    serviceSpec: JSON.parse(serviceSpecSource),
    serviceSpecSource,
    networkSpec: JSON.parse(networkSpecSource),
    networkSpecSource,
    cloudInitSources: Object.fromEntries(entries)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(
      "Usage:\n"
      + "  node infra/event-stack/event-manifest.mjs generate --event SLUG --kind production|rehearsal --destroy-after YYYY-MM-DD --output /ABSOLUTE/PATH [--pool-spec FILE] [--service-spec FILE] [--network-spec FILE]\n"
      + "  node infra/event-stack/event-manifest.mjs validate --manifest FILE [--pool-spec FILE] [--service-spec FILE] [--network-spec FILE]\n"
    );
    return;
  }
  const inputs = await loadManifestInputs(options);
  if (options.command === "generate") {
    const manifest = buildEventManifest({ event: options.event, kind: options.kind, destroyAfter: options.destroyAfter, ...inputs });
    await writeFile(options.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary(manifest))}\n`);
    return;
  }
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  const validated = validateEventManifest(manifest, inputs);
  process.stdout.write(`${JSON.stringify(summary(validated))}\n`);
}

function summary(manifest) {
  return {
    event: manifest.event,
    kind: manifest.kind,
    namespace: manifest.namespace,
    destroyAfter: manifest.destroyAfter,
    dropletCount: manifest.droplets.length,
    reservedIpv4Slots: [...new Set(manifest.endpoints.filter((endpoint) => endpoint.addressMode === "reserved-ipv4").map((endpoint) => endpoint.addressSlot))].length,
    dynamicDnsRecords: manifest.endpoints.filter((endpoint) => endpoint.addressMode === "dynamic-ipv4").length,
    assignedCompositors: manifest.compositorPool.desiredCompositors,
    warmSpares: manifest.compositorPool.warmSpares,
    serviceSpecSha256: manifest.sourceBindings.serviceSpecSha256,
    compositorPoolSpecSha256: manifest.sourceBindings.compositorPoolSpecSha256,
    networkSpecSha256: manifest.sourceBindings.networkSpecSha256
  };
}

function validateCloudInitSources(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cloud-init sources are required");
  const expectedProfiles = Object.keys(CLOUD_INIT_PATHS);
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...expectedProfiles].sort())) {
    throw new Error("cloud-init source profiles are incomplete or unexpected");
  }
  return Object.fromEntries(expectedProfiles.map((profile) => {
    const source = value[profile];
    if (typeof source !== "string" || !source.startsWith("#cloud-config\n")) {
      throw new Error(`cloud-init profile ${profile} is invalid`);
    }
    return [profile, sha256(source)];
  }));
}

function assertBoundSource(value, source, label) {
  if (typeof source !== "string" || source.length === 0) throw new Error(`${label} source is required`);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} source is not valid JSON`);
  }
  if (!isDeepStrictEqual(value, parsed)) throw new Error(`${label} object does not match the bound source bytes`);
}

function assertEvent(value) {
  if (typeof value !== "string" || !EVENT_SLUG.test(value)) throw new Error("event slug is invalid");
}

function assertKind(value) {
  if (!MANIFEST_KINDS.has(value)) throw new Error("event kind must be production or rehearsal");
}

export function eventNamespace({ event, destroyAfter, kind }) {
  assertEvent(event);
  assertDate(destroyAfter);
  assertKind(kind);
  const prefix = event.slice(0, EVENT_NAMESPACE_PREFIX_LENGTH).replace(/-+$/u, "") || "event";
  return `${prefix}-${sha256(`${kind}:${event}:${destroyAfter}`).slice(0, 8)}`;
}

function providerResourceName(namespace, logicalName) {
  const name = `${namespace}-${logicalName}`;
  if (!RESOURCE_NAME.test(name)) throw new Error(`provider resource name for ${logicalName} is invalid`);
  return name;
}

function scopedEndpoints(endpoints, dnsZone, kind, namespace) {
  if (kind === "production") return endpoints;
  return endpoints.map((endpoint) => {
    const suffix = `.${dnsZone}`;
    const relative = endpoint.hostname.slice(0, -suffix.length).replaceAll(".", "-");
    const label = `${relative}-${namespace}`;
    if (label.length > 63) throw new Error(`rehearsal endpoint label for ${endpoint.hostname} is too long`);
    return {
      hostname: `${label}.${dnsZone}`,
      role: endpoint.role,
      addressMode: "dynamic-ipv4",
      ttl: endpoint.ttl
    };
  });
}

function assertDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("destroy-after date must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("destroy-after date is not a real calendar date");
  }
}

function isDnsName(value) {
  return value.length <= 253 && value.split(".").length >= 2 && value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
