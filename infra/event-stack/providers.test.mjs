import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { firewallPayload } from "./network-contract.mjs";
import { DigitalOceanProvider, VercelDnsProvider } from "./providers.mjs";

const networkContract = JSON.parse(await readFile(new URL("./network-contract.json", import.meta.url), "utf8"));

test("read-only DigitalOcean operations do not require a provisioning SSH key", async () => {
  const fetchImpl = queueFetch([
    response(200, { account: { uuid: "account-uuid", status: "active", droplet_limit: 12 } })
  ]);
  const provider = new DigitalOceanProvider({ token: "token", sshKeys: [], cloudInitPaths: {}, fetchImpl });
  assert.deepEqual(await provider.getAccount(), { uuid: "account-uuid", status: "active", dropletLimit: 12 });
  await assert.rejects(() => provider.createDroplet({ userDataProfile: "canary" }), /SSH key/);
});

test("DigitalOcean create binds exact cloud-init bytes, tags, SSH keys, and safe defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-do-provider-"));
  const cloudInit = "#cloud-config\nruncmd: []\n";
  const path = join(root, "cloud-init.yaml");
  await writeFile(path, cloudInit);
  const requests = [];
  const fetchImpl = queueFetch([
    response(202, { droplet: apiDroplet(123, "canary") })
  ], requests);
  const provider = new DigitalOceanProvider({ token: "token", sshKeys: ["42", "fingerprint"], cloudInitPaths: { canary: path }, fetchImpl });
  const result = await provider.createDroplet({
    name: "canary",
    region: "sfo2",
    vpcUuid: "6ece4819-6f6a-4ab9-934c-f6a92660aab2",
    size: "c-4",
    image: "ubuntu-24-04-x64",
    tags: ["canary:test"],
    userDataProfile: "canary",
    userDataSha256: createHash("sha256").update(cloudInit).digest("hex")
  });
  assert.equal(result.id, "123");
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.ssh_keys, [42, "fingerprint"]);
  assert.deepEqual(body.tags, ["canary:test"]);
  assert.equal(body.vpc_uuid, "6ece4819-6f6a-4ab9-934c-f6a92660aab2");
  assert.equal(body.user_data, cloudInit);
  assert.equal(body.backups, false);
  assert.equal(body.ipv6, false);
  assert.equal(body.monitoring, true);
});

test("DigitalOcean pagination, reserved-IP actions, and snapshot lookup preserve exact identities", async () => {
  const requests = [];
  const fetchImpl = queueFetch([
    response(200, { droplets: [apiDroplet(1, "a")], meta: { total: 2 } }),
    response(200, { droplets: [apiDroplet(2, "b")], meta: { total: 2 } }),
    response(202, { action: { id: 9, status: "in-progress" } }),
    response(200, { images: [{ id: 88, name: "snap", regions: ["sfo2"] }], meta: { total: 1 } })
  ], requests);
  const provider = new DigitalOceanProvider({ token: "token", sshKeys: [], cloudInitPaths: {}, fetchImpl });
  assert.deepEqual((await provider.listAllDroplets()).map((entry) => entry.id), ["1", "2"]);
  await provider.assignReservedIpv4("192.0.2.5", "123");
  assert.deepEqual(JSON.parse(requests[2].options.body), { type: "assign", droplet_id: 123 });
  assert.deepEqual(await provider.findSnapshotsByName("snap"), [{ id: "88", name: "snap", regions: ["sfo2"] }]);
});

test("DigitalOcean creates an attached Reserved IPv4 and polls until a completed snapshot is listed", async () => {
  const requests = [];
  const fetchImpl = queueFetch([
    response(200, { reserved_ips: [{ ip: "192.0.2.1", region: { slug: "sfo2" }, droplet: null, locked: false }], meta: { total: 1 } }),
    response(202, { reserved_ip: { ip: "192.0.2.50", region: { slug: "sfo2" }, droplet: { id: 123 }, locked: false } }),
    response(202, { action: { id: 77, status: "in-progress" } }),
    response(200, { action: { id: 77, status: "completed" } }),
    response(200, { images: [], meta: { total: 0 } }),
    response(200, { images: [{ id: 99, name: "event-snapshot", regions: ["sfo2"] }], meta: { total: 1 } })
  ], requests);
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl,
    pollIntervalMs: 1,
    timeoutMs: 50
  });

  assert.deepEqual(await provider.listReservedIpv4s(), [{ ip: "192.0.2.1", region: "sfo2", dropletId: null, locked: false }]);
  assert.deepEqual(await provider.createReservedIpv4ForDroplet("123"), { ip: "192.0.2.50", region: "sfo2", dropletId: "123", locked: false });
  assert.deepEqual(await provider.snapshotDroplet("123", "event-snapshot"), { id: "99", name: "event-snapshot", regions: ["sfo2"] });
  assert.deepEqual(JSON.parse(requests[1].options.body), { droplet_id: 123 });
  assert.equal(requests.filter((entry) => entry.url.includes("/images?")).length, 2);
});

test("DigitalOcean waits for Reserved IPv4 assignment and detachment locks to clear", async () => {
  const requests = [];
  const attachedLocked = { ip: "192.0.2.50", region: { slug: "sfo2" }, droplet: { id: 123 }, locked: true };
  const attachedReady = { ...attachedLocked, locked: false };
  const detachedLocked = { ...attachedLocked, droplet: null, locked: true };
  const detachedReady = { ...detachedLocked, locked: false };
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { reserved_ip: attachedLocked }),
      response(200, { reserved_ip: attachedReady }),
      response(200, { reserved_ip: detachedLocked }),
      response(200, { reserved_ip: detachedReady })
    ], requests),
    pollIntervalMs: 1,
    timeoutMs: 50
  });

  assert.equal((await provider.waitReservedIpv4Assignment("192.0.2.50", "123")).locked, false);
  assert.equal((await provider.waitReservedIpv4Unassigned("192.0.2.50")).locked, false);
  assert.equal(requests.length, 4);
});

test("DigitalOcean proves an exact Reserved IPv4 is absent after deletion", async () => {
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([response(404, {})]),
    pollIntervalMs: 1,
    timeoutMs: 50
  });

  assert.equal(await provider.waitReservedIpv4Absent("192.0.2.50"), true);
});

test("DigitalOcean verifies the exact pinned VPC and tag-addressed firewall contract", async () => {
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { vpcs: [apiVpc()], meta: { total: 1 } }),
      response(200, { firewalls: networkContract.firewalls.map(apiFirewall), meta: { total: 4 } })
    ])
  });

  const result = await provider.verifyNetworkContract(networkContract);
  assert.equal(result.healthy, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.inventory.firewalls.length, 4);
});

test("DigitalOcean network apply updates drift, creates missing rules, and proves convergence", async () => {
  const requests = [];
  const initial = networkContract.firewalls.slice(0, 3).map(apiFirewall);
  initial[0].inbound_rules = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    pollIntervalMs: 1,
    timeoutMs: 50,
    fetchImpl: queueFetch([
      response(200, { vpcs: [apiVpc()], meta: { total: 1 } }),
      response(200, { firewalls: initial, meta: { total: 3 } }),
      response(200, { firewall: apiFirewall(networkContract.firewalls[0], 1) }),
      response(202, { firewall: apiFirewall(networkContract.firewalls[3], 4) }),
      response(200, { vpcs: [apiVpc()], meta: { total: 1 } }),
      response(200, { firewalls: networkContract.firewalls.map(apiFirewall), meta: { total: 4 } })
    ], requests)
  });

  const result = await provider.applyNetworkContract(networkContract);
  assert.equal(result.healthy, true);
  assert.deepEqual(requests.map((entry) => entry.options.method), ["GET", "GET", "PUT", "POST", "GET", "GET"]);
  const update = JSON.parse(requests[2].options.body);
  const create = JSON.parse(requests[3].options.body);
  assert.deepEqual(update, firewallPayload(networkContract.firewalls[0]));
  assert.deepEqual(create, firewallPayload(networkContract.firewalls[3]));
  assert.deepEqual(update.droplet_ids, []);
  assert.deepEqual(update.tags, ["bvm-preview-01"]);
});

test("DigitalOcean network apply refuses firewall mutation when the pinned VPC drifted", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { vpcs: [{ ...apiVpc(), ip_range: "10.121.0.0/20" }], meta: { total: 1 } })
    ], requests)
  });
  await assert.rejects(() => provider.applyNetworkContract(networkContract), /VPC identity drifted/u);
  assert.deepEqual(requests.map((entry) => entry.options.method), ["GET"]);
});

test("Vercel DNS accepts create uid, verifies exact A record and resolver, then deletes by owned id", async () => {
  const requests = [];
  const fetchImpl = queueFetch([
    response(200, { records: [] }),
    response(200, { uid: "rec-created", updated: 1 }),
    response(200, { records: [{ id: "rec-created", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 }] }),
    response(204, null),
    response(200, { records: [] })
  ], requests);
  const dns = new VercelDnsProvider({
    token: "token",
    teamId: "team_123",
    fetchImpl,
    resolver: async () => ["192.0.2.50"],
    pollIntervalMs: 1,
    timeoutMs: 20
  });
  const change = await dns.upsertARecord({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50", ttl: 60 });
  assert.deepEqual(change, { action: "created", recordId: "rec-created", previous: null });
  assert.equal(await dns.verifyARecord({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50" }), true);
  await dns.restoreRecord({ zone: "example.com", hostname: "lifecycle-test.example.com", change });
  assert.equal(await dns.waitHostnameAbsent({ zone: "example.com", hostname: "lifecycle-test.example.com" }), true);
  assert.match(requests[0].url, /teamId=team_123/);
  assert.match(requests[3].url, /\/v2\/domains\/example.com\/records\/rec-created\?teamId=team_123$/);
});

test("Vercel DNS updates and restores only the same record id", async () => {
  const requests = [];
  const original = { id: "rec-1", name: "monitor", type: "A", value: "192.0.2.1", ttl: 300 };
  const fetchImpl = queueFetch([
    response(200, { records: [original] }),
    response(200, { id: "rec-1", name: "monitor", recordType: "A", value: "192.0.2.2", ttl: 60 }),
    response(200, { id: "rec-1", name: "monitor", recordType: "A", value: "192.0.2.1", ttl: 300 })
  ], requests);
  const dns = new VercelDnsProvider({ token: "token", fetchImpl, resolver: async () => [] });
  const change = await dns.upsertARecord({ zone: "example.com", hostname: "monitor.example.com", value: "192.0.2.2", ttl: 60 });
  assert.deepEqual(change, { action: "updated", recordId: "rec-1", previous: original });
  await dns.restoreRecord({ zone: "example.com", hostname: "monitor.example.com", change });
  assert.equal(JSON.parse(requests[2].options.body).value, "192.0.2.1");
});

test("Vercel DNS applies and reconciles a prepared create without losing ownership", async () => {
  const requests = [];
  const fetchImpl = queueFetch([
    response(200, { records: [] }),
    response(200, { uid: "rec-new" }),
    response(200, { records: [{ id: "rec-new", name: "monitor", type: "A", value: "192.0.2.50", ttl: 60 }] })
  ], requests);
  const dns = new VercelDnsProvider({ token: "token", fetchImpl, resolver: async () => [] });
  const intent = { action: "created", recordId: null, previous: null };

  const applied = await dns.upsertARecord({
    zone: "example.com",
    hostname: "monitor.example.com",
    value: "192.0.2.50",
    ttl: 60,
    previousChange: intent
  });
  assert.deepEqual(applied, { action: "created", recordId: "rec-new", previous: null });
  const reconciled = await dns.upsertARecord({
    zone: "example.com",
    hostname: "monitor.example.com",
    value: "192.0.2.50",
    ttl: 60,
    previousChange: intent
  });
  assert.deepEqual(reconciled, applied);
  assert.equal(requests.filter((entry) => entry.options.method === "POST").length, 1);
});

test("Vercel DNS traverses every v4 cursor page before matching a hostname", async () => {
  const requests = [];
  const fetchImpl = queueFetch([
    response(200, {
      records: [{ id: "rec-first", name: "other", type: "A", value: "192.0.2.1", ttl: 60 }],
      pagination: { next: 1720000000000 }
    }),
    response(200, {
      records: [{ id: "rec-target", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 }],
      pagination: { next: null }
    })
  ], requests);
  const dns = new VercelDnsProvider({ token: "token", teamId: "team_123", fetchImpl, resolver: async () => [] });

  assert.deepEqual(await dns.inspectHostname({ zone: "example.com", hostname: "lifecycle-test.example.com" }), [
    { id: "rec-target", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 }
  ]);
  assert.match(requests[0].url, /\/v4\/domains\/example.com\/records\?limit=100&teamId=team_123$/);
  assert.match(requests[1].url, /\/v4\/domains\/example.com\/records\?limit=100&until=1720000000000&teamId=team_123$/);
});

test("Vercel DNS fails closed on repeated cursors or duplicate record identities", async () => {
  const repeatedCursor = new VercelDnsProvider({
    token: "token",
    fetchImpl: queueFetch([
      response(200, { records: [], pagination: { next: 10 } }),
      response(200, { records: [], pagination: { next: 10 } })
    ]),
    resolver: async () => []
  });
  await assert.rejects(
    () => repeatedCursor.inspectHostname({ zone: "example.com", hostname: "monitor.example.com" }),
    /cursor repeated/
  );

  const duplicateId = new VercelDnsProvider({
    token: "token",
    fetchImpl: queueFetch([
      response(200, {
        records: [{ id: "rec-1", name: "one", type: "A", value: "192.0.2.1", ttl: 60 }],
        pagination: { next: 20 }
      }),
      response(200, {
        records: [{ id: "rec-1", name: "two", type: "A", value: "192.0.2.2", ttl: 60 }],
        pagination: { next: null }
      })
    ]),
    resolver: async () => []
  });
  await assert.rejects(
    () => duplicateId.inspectHostname({ zone: "example.com", hostname: "monitor.example.com" }),
    /duplicate record ids/
  );
});

function queueFetch(responses, requests = []) {
  return async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (responses.length === 0) throw new Error(`unexpected request ${options.method ?? "GET"} ${url}`);
    return responses.shift();
  };
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (body === null) throw new Error("response has no body");
      return body;
    }
  };
}

function apiDroplet(id, name) {
  return {
    id,
    name,
    status: "active",
    region: { slug: "sfo2" },
    vpc_uuid: "6ece4819-6f6a-4ab9-934c-f6a92660aab2",
    size_slug: "c-4",
    image: { slug: "ubuntu-24-04-x64" },
    networks: { v4: [{ type: "public", ip_address: `198.51.100.${id}` }, { type: "private", ip_address: `10.20.0.${id}` }] },
    tags: ["canary:test"],
    created_at: "2026-07-15T00:00:00Z"
  };
}

function apiVpc() {
  return {
    id: networkContract.vpcUuid,
    name: "default-sfo2",
    region: { slug: networkContract.region },
    ip_range: networkContract.vpcCidr
  };
}

function apiFirewall(value, index = networkContract.firewalls.indexOf(value)) {
  const payload = firewallPayload(value);
  return {
    id: `firewall-${index + 1}`,
    name: payload.name,
    status: "succeeded",
    inbound_rules: payload.inbound_rules,
    outbound_rules: payload.outbound_rules,
    tags: payload.tags,
    droplet_ids: payload.droplet_ids
  };
}
