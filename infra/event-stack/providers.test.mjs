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

test("DigitalOcean returns an exact normalized size contract", async () => {
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, {
        sizes: [{ slug: "c-4", vcpus: 4, memory: 8192, disk: 50, available: true, regions: ["sfo2", "nyc3", "sfo2"] }],
        meta: { total: 1 }
      })
    ])
  });

  assert.deepEqual(await provider.getSize("c-4"), {
    slug: "c-4",
    vcpus: 4,
    memory: 8192,
    disk: 50,
    available: true,
    regions: ["nyc3", "sfo2"]
  });
});

test("DigitalOcean includes a sanitized provider reason for rejected actions", async () => {
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(422, { id: "unprocessable_entity", message: "target disk is too small\nretry with another size" })
    ])
  });

  await assert.rejects(
    () => provider.resizeDroplet("123", "c-2"),
    /HTTP 422: target disk is too small retry with another size/u
  );
});

test("DigitalOcean retries transient GET transport failures and succeeds", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      response(200, { account: { uuid: "account-uuid", status: "active", droplet_limit: 12 } })
    ], requests),
    requestRetryBaseMs: 0
  });

  assert.deepEqual(await provider.getAccount(), { uuid: "account-uuid", status: "active", dropletLimit: 12 });
  assert.equal(requests.length, 3);
});

test("DigitalOcean retries a transient GET provider response and succeeds", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(503, { message: "temporarily unavailable" }),
      response(200, { account: { uuid: "account-uuid", status: "active", droplet_limit: 12 } })
    ], requests),
    requestRetryBaseMs: 0
  });

  assert.deepEqual(await provider.getAccount(), { uuid: "account-uuid", status: "active", dropletLimit: 12 });
  assert.equal(requests.length, 2);
});

test("DigitalOcean never retries an ambiguous POST transport failure", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([new TypeError("fetch failed"), response(202, { reserved_ip: {} })], requests),
    requestRetryBaseMs: 0
  });

  await assert.rejects(
    () => provider.createReservedIpv4("sfo2"),
    /DigitalOcean POST \/reserved_ips transport failed after 1 attempt: fetch failed/u
  );
  assert.equal(requests.length, 1);
});

test("DigitalOcean bounds exhausted GET transport retries with sanitized context", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed")
    ], requests),
    requestAttempts: 3,
    requestRetryBaseMs: 0
  });

  await assert.rejects(
    () => provider.getAccount(),
    /DigitalOcean GET \/account transport failed after 3 attempts: fetch failed/u
  );
  assert.equal(requests.length, 3);
});

test("DigitalOcean convergence polling survives exhausted transient GET retries", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      new TypeError("fetch failed"),
      response(200, { droplet: apiDroplet(123, "rehearsal", { status: "active", publicIpv4: "203.0.113.10" }) })
    ], requests),
    requestAttempts: 1,
    requestRetryBaseMs: 0,
    pollIntervalMs: 0,
    timeoutMs: 100
  });

  assert.equal((await provider.waitDropletActive("123")).id, "123");
  assert.equal(requests.length, 2);
});

test("DigitalOcean convergence polling still fails immediately for non-retryable responses", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([response(403, { message: "forbidden" })], requests),
    requestAttempts: 1,
    requestRetryBaseMs: 0,
    pollIntervalMs: 0,
    timeoutMs: 100
  });

  await assert.rejects(() => provider.waitDropletActive("123"), /DigitalOcean GET \/droplets\/123 failed with HTTP 403/u);
  assert.equal(requests.length, 1);
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
  assert.equal(body.monitoring, false);
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

test("DigitalOcean moves an exact Reserved IPv4 only after ownership and topology checks", async () => {
  const requests = [];
  const assignedToSource = { ip: "192.0.2.50", region: { slug: "sfo2" }, droplet: { id: 123 }, locked: false };
  const assignedToDestination = { ...assignedToSource, droplet: { id: 456 } };
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { reserved_ip: assignedToSource }),
      response(200, { droplet: apiDroplet(123, "primary-ingest") }),
      response(200, { droplet: apiDroplet(456, "warm-spare") }),
      response(202, { action: { id: 9, status: "in-progress" } }),
      response(200, { action: { id: 9, status: "completed" } }),
      response(200, { reserved_ip: assignedToDestination })
    ], requests),
    pollIntervalMs: 1,
    timeoutMs: 50
  });

  assert.deepEqual(await provider.moveReservedIpv4({ ip: "192.0.2.50", fromDropletId: "123", toDropletId: "456" }), {
    ip: "192.0.2.50",
    region: "sfo2",
    fromDropletId: "123",
    toDropletId: "456",
    actionId: "9",
    status: "assigned"
  });
  assert.deepEqual(JSON.parse(requests[3].options.body), { type: "assign", droplet_id: 456 });
  assert.match(requests[4].url, /\/actions\/9$/u);
  assert.equal(requests.length, 6);
});

test("DigitalOcean refuses Reserved IPv4 movement on ownership or lock drift", async () => {
  for (const reservedIp of [
    { ip: "192.0.2.50", region: { slug: "sfo2" }, droplet: { id: 999 }, locked: false },
    { ip: "192.0.2.50", region: { slug: "sfo2" }, droplet: { id: 123 }, locked: true }
  ]) {
    const requests = [];
    const provider = new DigitalOceanProvider({
      token: "token",
      sshKeys: [],
      cloudInitPaths: {},
      fetchImpl: queueFetch([
        response(200, { reserved_ip: reservedIp }),
        response(200, { droplet: apiDroplet(123, "primary-ingest") }),
        response(200, { droplet: apiDroplet(456, "warm-spare") })
      ], requests)
    });
    await assert.rejects(
      () => provider.moveReservedIpv4({ ip: "192.0.2.50", fromDropletId: "123", toDropletId: "456" }),
      reservedIp.locked ? /locked; refusing reassignment/u : /not expected source/u
    );
    assert.equal(requests.some((entry) => entry.options.method === "POST"), false);
  }
});

test("DigitalOcean refuses Reserved IPv4 movement to an incompatible or inactive destination", async () => {
  for (const { destination, expected } of [
    { destination: { ...apiDroplet(456, "warm-spare"), region: { slug: "nyc3" } }, expected: /same region/u },
    { destination: { ...apiDroplet(456, "warm-spare"), vpc_uuid: "another-vpc" }, expected: /same VPC/u },
    { destination: { ...apiDroplet(456, "warm-spare"), status: "off" }, expected: /not active/u }
  ]) {
    const requests = [];
    const provider = new DigitalOceanProvider({
      token: "token",
      sshKeys: [],
      cloudInitPaths: {},
      fetchImpl: queueFetch([
        response(200, { reserved_ip: { ip: "192.0.2.50", region: { slug: "sfo2" }, droplet: { id: 123 }, locked: false } }),
        response(200, { droplet: apiDroplet(123, "primary-ingest") }),
        response(200, { droplet: destination })
      ], requests)
    });
    await assert.rejects(
      () => provider.moveReservedIpv4({ ip: "192.0.2.50", fromDropletId: "123", toDropletId: "456" }),
      expected
    );
    assert.equal(requests.some((entry) => entry.options.method === "POST"), false);
  }
});

test("DigitalOcean Reserved IPv4 movement fails when the provider action does not complete", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { reserved_ip: { ip: "192.0.2.50", region: { slug: "sfo2" }, droplet: { id: 123 }, locked: false } }),
      response(200, { droplet: apiDroplet(123, "primary-ingest") }),
      response(200, { droplet: apiDroplet(456, "warm-spare") }),
      response(202, { action: { id: 9, status: "in-progress" } }),
      response(200, { action: { id: 9, status: "errored" } })
    ], requests),
    pollIntervalMs: 1,
    timeoutMs: 50
  });

  await assert.rejects(
    () => provider.moveReservedIpv4({ ip: "192.0.2.50", fromDropletId: "123", toDropletId: "456" }),
    /action 9 failed/u
  );
  assert.equal(requests.length, 5);
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

test("DigitalOcean retries Reserved IPv4 release across asynchronous unassignment races", async () => {
  const requests = [];
  const detached = { ip: "192.0.2.50", region: { slug: "sfo2" }, droplet: null, locked: false };
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { reserved_ip: detached }),
      response(204, null),
      response(200, { reserved_ip: detached }),
      response(422, { id: "unprocessable_entity" }),
      response(200, { reserved_ip: detached }),
      response(204, null),
      response(404, {})
    ], requests),
    pollIntervalMs: 1,
    timeoutMs: 100
  });

  assert.equal(await provider.deleteReservedIpv4("192.0.2.50"), true);
  assert.deepEqual(requests.map((entry) => entry.options.method), ["GET", "DELETE", "GET", "DELETE", "GET", "DELETE", "GET"]);
});

test("DigitalOcean deletes only an exact empty event tag and proves absence", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { tag: { name: "scorecheck-event:test", resources: { count: 0 } } }),
      response(204, null),
      response(404, { message: "not found" })
    ], requests)
  });
  assert.deepEqual(await provider.deleteEmptyTag("scorecheck-event:test"), {
    name: "scorecheck-event:test",
    status: "deleted"
  });
  assert.deepEqual(requests.map((entry) => entry.options.method), ["GET", "DELETE", "GET"]);
  assert.match(requests[1].url, /\/tags\/scorecheck-event%3Atest$/u);
});

test("DigitalOcean refuses to remove a tag that still owns resources", async () => {
  const requests = [];
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { tag: { name: "scorecheck-event:test", resources: { count: 1 } } })
    ], requests)
  });
  await assert.rejects(() => provider.deleteEmptyTag("scorecheck-event:test"), /still owns 1 resources/u);
  assert.equal(requests.length, 1);
});

test("DigitalOcean retains a shared lifecycle tag while another resource uses it", async () => {
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { tag: { name: "scorecheck-role:compositor", resources: { count: 2 } } })
    ])
  });
  assert.deepEqual(await provider.deleteEmptyTag("scorecheck-role:compositor", { allowInUse: true }), {
    name: "scorecheck-role:compositor",
    status: "retained-in-use",
    resourceCount: 2
  });
});

test("DigitalOcean reconciles a lost empty-tag delete response", async () => {
  const provider = new DigitalOceanProvider({
    token: "token",
    sshKeys: [],
    cloudInitPaths: {},
    fetchImpl: queueFetch([
      response(200, { tag: { name: "scorecheck-event:test", resources: { count: 0 } } }),
      response(500, { message: "lost response" }),
      response(404, { message: "not found" }),
      response(404, { message: "not found" })
    ]),
    requestRetryBaseMs: 0
  });
  assert.deepEqual(await provider.deleteEmptyTag("scorecheck-event:test"), {
    name: "scorecheck-event:test",
    status: "reconciled-absent"
  });
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
      response(201, {}),
      response(201, {}),
      response(201, {}),
      response(201, {}),
      response(200, { firewalls: initial, meta: { total: 3 } }),
      response(200, { firewall: apiFirewall(networkContract.firewalls[0], 1) }),
      response(202, { firewall: apiFirewall(networkContract.firewalls[3], 4) }),
      response(200, { vpcs: [apiVpc()], meta: { total: 1 } }),
      response(200, { firewalls: networkContract.firewalls.map(apiFirewall), meta: { total: 4 } })
    ], requests)
  });

  const result = await provider.applyNetworkContract(networkContract);
  assert.equal(result.healthy, true);
  assert.deepEqual(requests.map((entry) => entry.options.method), ["GET", "POST", "POST", "POST", "POST", "GET", "PUT", "POST", "GET", "GET"]);
  assert.deepEqual(requests.slice(1, 5).map((entry) => JSON.parse(entry.options.body).name), [
    "bvm-commentary", "bvm-compositor", "bvm-observability", "bvm-preview-01"
  ]);
  const update = JSON.parse(requests[6].options.body);
  const create = JSON.parse(requests[7].options.body);
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
    resolutionProbes: [{ name: "test", resolve: async () => [{ address: "192.0.2.50", ttl: 60 }] }],
    pollIntervalMs: 1,
    timeoutMs: 20
  });
  const change = await dns.upsertARecord({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50", ttl: 60 });
  assert.deepEqual(change, { action: "created", recordId: "rec-created", previous: null });
  assert.equal((await dns.waitARecordReady({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50" })).status, "ready");
  await dns.restoreRecord({ zone: "example.com", hostname: "lifecycle-test.example.com", change });
  assert.equal(await dns.waitHostnameAbsent({ zone: "example.com", hostname: "lifecycle-test.example.com" }), true);
  assert.match(requests[0].url, /teamId=team_123/);
  assert.match(requests[3].url, /\/v2\/domains\/example.com\/records\/rec-created\?teamId=team_123$/);
});

test("Vercel DNS waits until every resolver retires a cached wildcard answer", async () => {
  const exact = { id: "rec-created", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 };
  let systemAttempts = 0;
  const dns = new VercelDnsProvider({
    token: "token",
    fetchImpl: queueFetch([
      response(200, { records: [exact] }),
      response(200, { records: [exact] })
    ]),
    resolutionProbes: [
      {
        name: "system",
        resolve: async () => systemAttempts++ === 0
          ? [{ address: "64.29.17.1", ttl: 1725 }]
          : [{ address: "192.0.2.50", ttl: 60 }]
      },
      { name: "cloudflare", resolve: async () => [{ address: "192.0.2.50", ttl: 60 }] },
      { name: "google", resolve: async () => [{ address: "192.0.2.50", ttl: 60 }] }
    ],
    pollIntervalMs: 1,
    timeoutMs: 50
  });

  const readiness = await dns.waitARecordReady({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50" });
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.attempts, 2);
  assert.deepEqual(readiness.resolvers.map((entry) => entry.name), ["system", "cloudflare", "google"]);
  assert.deepEqual(readiness.staleAnswers, [{ resolver: "system", address: "64.29.17.1", maxTtlSeconds: 1725 }]);
});

test("Vercel DNS defers recursive queries until authoritative DNS is ready", async () => {
  const exact = { id: "rec-created", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 };
  let authoritativeCalls = 0;
  let recursiveCalls = 0;
  const dns = new VercelDnsProvider({
    token: "token",
    fetchImpl: queueFetch([
      response(200, { records: [exact] }),
      response(200, { records: [exact] })
    ]),
    resolutionProbes: [
      {
        name: "authoritative",
        authoritative: true,
        resolve: async () => authoritativeCalls++ === 0
          ? [{ address: "64.29.17.1", ttl: 1800 }]
          : [{ address: "192.0.2.50", ttl: 60 }]
      },
      {
        name: "recursive",
        resolve: async () => {
          recursiveCalls += 1;
          return [{ address: "192.0.2.50", ttl: 60 }];
        }
      }
    ],
    pollIntervalMs: 1,
    timeoutMs: 50
  });

  const readiness = await dns.waitARecordReady({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50" });
  assert.equal(readiness.attempts, 2);
  assert.equal(authoritativeCalls, 2);
  assert.equal(recursiveCalls, 1);
  assert.deepEqual(readiness.staleAnswers, [{ resolver: "authoritative", address: "64.29.17.1", maxTtlSeconds: 1800 }]);
});

test("Vercel DNS fails closed while any required resolver remains stale", async () => {
  const exact = { id: "rec-created", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 };
  const dns = new VercelDnsProvider({
    token: "token",
    fetchImpl: async () => response(200, { records: [exact] }),
    resolutionProbes: [
      { name: "system", resolve: async () => [{ address: "192.0.2.50", ttl: 60 }] },
      { name: "public", resolve: async () => [{ address: "64.29.17.1", ttl: 1700 }] }
    ],
    pollIntervalMs: 1,
    timeoutMs: 5
  });

  await assert.rejects(
    () => dns.waitARecordReady({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50" }),
    /public:64\.29\.17\.1/u
  );
});

test("Vercel DNS fails closed on mixed intended and stale resolver answers", async () => {
  const exact = { id: "rec-created", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 };
  const dns = new VercelDnsProvider({
    token: "token",
    fetchImpl: async () => response(200, { records: [exact] }),
    resolutionProbes: [{
      name: "mixed",
      resolve: async () => [
        { address: "192.0.2.50", ttl: 60 },
        { address: "64.29.17.1", ttl: 1700 }
      ]
    }],
    pollIntervalMs: 1,
    timeoutMs: 5
  });

  await assert.rejects(
    () => dns.waitARecordReady({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50" }),
    /mixed:192\.0\.2\.50,64\.29\.17\.1/u
  );
});

test("Vercel DNS rejects invalid IPv4 resolver answers", async () => {
  const exact = { id: "rec-created", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 };
  const dns = new VercelDnsProvider({
    token: "token",
    fetchImpl: async () => response(200, { records: [exact] }),
    resolutionProbes: [{ name: "invalid", resolve: async () => [{ address: "999.0.2.50", ttl: 60 }] }],
    pollIntervalMs: 1,
    timeoutMs: 5
  });

  await assert.rejects(
    () => dns.waitARecordReady({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50" }),
    /invalid:error/u
  );
});

test("Vercel DNS fails closed on conflicting control-plane records", async () => {
  const dns = new VercelDnsProvider({
    token: "token",
    fetchImpl: async () => response(200, {
      records: [
        { id: "rec-target", name: "lifecycle-test", type: "A", value: "192.0.2.50", ttl: 60 },
        { id: "rec-stale", name: "lifecycle-test", type: "A", value: "192.0.2.51", ttl: 60 }
      ]
    }),
    resolutionProbes: [{ name: "test", resolve: async () => [{ address: "192.0.2.50", ttl: 60 }] }],
    pollIntervalMs: 1,
    timeoutMs: 5
  });

  await assert.rejects(
    () => dns.waitARecordReady({ zone: "example.com", hostname: "lifecycle-test.example.com", value: "192.0.2.50" }),
    /2 conflicting records/u
  );
});

test("Vercel DNS restores an updated record after Vercel replaces its record id", async () => {
  const requests = [];
  const original = { id: "rec-1", name: "monitor", type: "A", value: "192.0.2.1", ttl: 300 };
  const updated = { id: "rec-2", name: "monitor", type: "A", value: "192.0.2.2", ttl: 60 };
  const fetchImpl = queueFetch([
    response(200, { records: [original] }),
    response(200, { id: "rec-2", name: "monitor", recordType: "A", value: "192.0.2.2", ttl: 60 }),
    response(200, { records: [updated] }),
    response(200, { id: "rec-3", name: "monitor", recordType: "A", value: "192.0.2.1", ttl: 300 })
  ], requests);
  const dns = new VercelDnsProvider({ token: "token", fetchImpl, resolutionProbes: [{ name: "test", resolve: async () => [] }] });
  const change = await dns.upsertARecord({ zone: "example.com", hostname: "monitor.example.com", value: "192.0.2.2", ttl: 60 });
  assert.deepEqual(change, { action: "updated", recordId: "rec-1", previous: original });
  await dns.restoreRecord({
    zone: "example.com",
    hostname: "monitor.example.com",
    change,
    expectedCurrent: { type: "A", value: "192.0.2.2", ttl: 60 }
  });
  assert.match(requests[3].url, /\/v1\/domains\/records\/rec-2$/u);
  assert.equal(JSON.parse(requests[3].options.body).value, "192.0.2.1");
});

test("Vercel DNS restoration is idempotent after a replacement id reaches the previous value", async () => {
  const requests = [];
  const previous = { id: "rec-old", name: "monitor", type: "A", value: "192.0.2.1", ttl: 300 };
  const fetchImpl = queueFetch([
    response(200, { records: [{ ...previous, id: "rec-restored" }] })
  ], requests);
  const dns = new VercelDnsProvider({ token: "token", fetchImpl, resolutionProbes: [{ name: "test", resolve: async () => [] }] });
  await dns.restoreRecord({
    zone: "example.com",
    hostname: "monitor.example.com",
    change: { action: "updated", recordId: "rec-old", previous },
    expectedCurrent: { type: "A", value: "192.0.2.2", ttl: 60 }
  });
  assert.deepEqual(requests.map((entry) => entry.options.method), ["GET"]);
});

test("Vercel DNS restoration fails closed when replacement content is not the lifecycle target", async () => {
  const requests = [];
  const previous = { id: "rec-old", name: "monitor", type: "A", value: "192.0.2.1", ttl: 300 };
  const fetchImpl = queueFetch([
    response(200, { records: [{ id: "rec-external", name: "monitor", type: "A", value: "192.0.2.99", ttl: 60 }] })
  ], requests);
  const dns = new VercelDnsProvider({ token: "token", fetchImpl, resolutionProbes: [{ name: "test", resolve: async () => [] }] });
  await assert.rejects(() => dns.restoreRecord({
    zone: "example.com",
    hostname: "monitor.example.com",
    change: { action: "updated", recordId: "rec-old", previous },
    expectedCurrent: { type: "A", value: "192.0.2.2", ttl: 60 }
  }), /changed outside lifecycle control/u);
  assert.deepEqual(requests.map((entry) => entry.options.method), ["GET"]);
});

test("Vercel DNS applies and reconciles a prepared create without losing ownership", async () => {
  const requests = [];
  const fetchImpl = queueFetch([
    response(200, { records: [] }),
    response(200, { uid: "rec-new" }),
    response(200, { records: [{ id: "rec-new", name: "monitor", type: "A", value: "192.0.2.50", ttl: 60 }] })
  ], requests);
  const dns = new VercelDnsProvider({ token: "token", fetchImpl, resolutionProbes: [{ name: "test", resolve: async () => [] }] });
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
  const dns = new VercelDnsProvider({ token: "token", teamId: "team_123", fetchImpl, resolutionProbes: [{ name: "test", resolve: async () => [] }] });

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
    resolutionProbes: [{ name: "test", resolve: async () => [] }]
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
    resolutionProbes: [{ name: "test", resolve: async () => [] }]
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
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
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
