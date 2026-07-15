import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DigitalOceanProvider, VercelDnsProvider } from "./providers.mjs";

test("read-only DigitalOcean operations do not require a provisioning SSH key", async () => {
  const fetchImpl = queueFetch([
    response(200, { account: { status: "active", droplet_limit: 12 } })
  ]);
  const provider = new DigitalOceanProvider({ token: "token", sshKeys: [], cloudInitPaths: {}, fetchImpl });
  assert.deepEqual(await provider.getAccount(), { status: "active", dropletLimit: 12 });
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
    size_slug: "c-4",
    image: { slug: "ubuntu-24-04-x64" },
    networks: { v4: [{ type: "public", ip_address: `198.51.100.${id}` }, { type: "private", ip_address: `10.20.0.${id}` }] },
    tags: ["canary:test"],
    created_at: "2026-07-15T00:00:00Z"
  };
}
