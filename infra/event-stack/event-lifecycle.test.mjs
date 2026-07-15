import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import {
  EventLifecycleController,
  FileStateStore,
  MemoryStateStore,
  createInitialState,
  lifecycleTags,
  stateSummary,
  validateAnchorConfig
} from "./event-lifecycle.mjs";
import { fakeProvisioningAttestation, FakeDigitalOceanProvider, FakeDnsProvider, FakeNotifier, FakeStackDeployer } from "./fake-providers.mjs";

const inputs = await loadManifestInputs();

function fixture(overrides = {}) {
  const now = overrides.now ?? new Date("2026-08-01T12:00:00.000Z");
  const manifest = buildEventManifest({ event: "turnkey-test", destroyAfter: "2026-08-01", ...inputs });
  const anchors = {
    schemaVersion: 1,
    provider: "digitalocean",
    region: "sfo2",
    reservedIpv4: { ingest: "192.0.2.10", commentary: "192.0.2.11" }
  };
  const cloud = overrides.cloud ?? new FakeDigitalOceanProvider();
  const dns = overrides.dns ?? new FakeDnsProvider({
    "preview.beachvolleyballmedia.com": "203.0.113.10",
    "rtc.beachvolleyballmedia.com": "203.0.113.11",
    "turn.beachvolleyballmedia.com": "203.0.113.11",
    "monitor.beachvolleyballmedia.com": "203.0.113.12"
  });
  const deployer = overrides.deployer ?? new FakeStackDeployer();
  const notifier = overrides.notifier ?? new FakeNotifier();
  const store = overrides.store ?? new MemoryStateStore();
  const provisioningGuard = overrides.provisioningGuard ?? { async verify() { return fakeProvisioningAttestation(); } };
  const controller = new EventLifecycleController({ store, cloud, dns, deployer, notifier, provisioningGuard, now: () => new Date(now) });
  return { controller, manifest, anchors, cloud, dns, deployer, notifier, store };
}

test("runs the production-shaped 12-Droplet lifecycle without changing critical IPs", async () => {
  const { controller, manifest, anchors, cloud, dns, deployer, notifier } = fixture();
  const planned = await controller.plan(manifest);
  assert.equal(stateSummary(planned).phase, "planned");

  const ready = await controller.up(manifest, anchors);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.provisioningAttestation.canaryRunId, "offlinecanary");
  assert.equal(Object.keys(ready.droplets).length, 12);
  assert.equal(new Set(Object.values(ready.droplets).map((entry) => entry.id)).size, 12);
  assert.equal(cloud.droplets.size, 12);
  assert.deepEqual(deployer.deployCalls, [
    "bvm-commentary-01",
    "bvm-preview-01",
    "bvm-compositor-a",
    "bvm-compositor-b",
    "bvm-compositor-c",
    "bvm-compositor-d",
    "bvm-compositor-e",
    "bvm-compositor-f",
    "bvm-compositor-g",
    "bvm-compositor-h",
    "bvm-compositor-spare",
    "bvm-observability-01"
  ]);
  assert.equal(dns.records.get("preview.beachvolleyballmedia.com").value, anchors.reservedIpv4.ingest);
  assert.equal(dns.records.get("rtc.beachvolleyballmedia.com").value, anchors.reservedIpv4.commentary);
  assert.equal(dns.records.get("turn.beachvolleyballmedia.com").value, anchors.reservedIpv4.commentary);
  assert.equal(notifier.messages.length, 1);
  assert.match(notifier.messages[0].message, /all event servers/);

  const live = await controller.beginCoverage(manifest, "START:turnkey-test");
  assert.equal(live.phase, "live");
  await assert.rejects(() => controller.destroy(manifest, "/tmp/does-not-matter", "DESTROY:turnkey-test"), /phase is live/);
  await controller.closeCoverage(manifest, "CLOSE:turnkey-test");

  const root = await mkdtemp(join(tmpdir(), "scorecheck-lifecycle-evidence-"));
  await chmod(root, 0o700);
  const evidence = join(root, "evidence");
  await controller.captureEvidence(manifest, evidence);
  const marker = JSON.parse(await readFile(join(evidence, "EVIDENCE_COMPLETE.json"), "utf8"));
  assert.equal(marker.event, manifest.event);

  const destroyed = await controller.destroy(manifest, evidence, "DESTROY:turnkey-test");
  assert.equal(destroyed.phase, "destroyed");
  assert.equal(cloud.droplets.size, 0);
  assert.equal(cloud.deleteCalls.length, 12);
  assert.equal((await cloud.getReservedIpv4(anchors.reservedIpv4.ingest)).dropletId, null);
  assert.equal((await cloud.getReservedIpv4(anchors.reservedIpv4.commentary)).dropletId, null);
  assert.equal(dns.records.get("preview.beachvolleyballmedia.com").value, anchors.reservedIpv4.ingest);
  assert.equal(dns.records.get("rtc.beachvolleyballmedia.com").value, anchors.reservedIpv4.commentary);
  assert.equal(dns.records.get("monitor.beachvolleyballmedia.com").value, "203.0.113.12");
  assert.deepEqual(dns.restores, ["monitor.beachvolleyballmedia.com"]);
  assert.equal(notifier.messages.length, 2);
});

test("resumes after a definite partial create without duplicates", async () => {
  const cloud = new FakeDigitalOceanProvider();
  cloud.failCreateAt = 5;
  const setup = fixture({ cloud });
  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /definite create failure/);
  assert.equal(cloud.droplets.size, 4);
  const failed = await setup.store.load();
  assert.equal(failed.phase, "provisioning");
  assert.equal(Object.keys(failed.droplets).length, 4);
  cloud.failCreateAt = null;
  const ready = await setup.controller.up(setup.manifest, setup.anchors);
  assert.equal(ready.phase, "ready");
  assert.equal(cloud.droplets.size, 12);
  assert.equal(new Set([...cloud.droplets.values()].map((entry) => entry.name)).size, 12);
});

test("reconciles an ambiguous create by exact name, shape, tags, and event", async () => {
  const cloud = new FakeDigitalOceanProvider();
  cloud.ambiguousCreateAt = 3;
  const setup = fixture({ cloud });
  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /ambiguous create result/);
  assert.equal(cloud.droplets.size, 3);
  assert.equal(Object.keys((await setup.store.load()).droplets).length, 2);
  cloud.ambiguousCreateAt = null;
  const ready = await setup.controller.up(setup.manifest, setup.anchors);
  assert.equal(ready.phase, "ready");
  assert.equal(cloud.droplets.size, 12);
  assert.equal(cloud.createCalls, 12);
});

test("DNS failure retains the exact fleet and resumes without recreating Droplets", async () => {
  const dns = new FakeDnsProvider();
  dns.failHostname = "monitor.beachvolleyballmedia.com";
  const setup = fixture({ dns });
  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /injected DNS failure/);
  assert.equal(setup.cloud.droplets.size, 12);
  assert.equal(setup.cloud.createCalls, 12);
  dns.failHostname = null;
  const ready = await setup.controller.up(setup.manifest, setup.anchors);
  assert.equal(ready.phase, "ready");
  assert.equal(setup.cloud.createCalls, 12);
});

test("reconciles an ambiguous DNS response from protected pre-change evidence and restores it on teardown", async () => {
  const dns = new FakeDnsProvider({ "monitor.beachvolleyballmedia.com": "203.0.113.12" });
  dns.ambiguousHostname = "monitor.beachvolleyballmedia.com";
  const setup = fixture({ dns });
  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /ambiguous DNS response/);
  const interrupted = await setup.store.load();
  assert.equal(interrupted.endpoints["monitor.beachvolleyballmedia.com"].status, "pending");
  assert.equal(interrupted.endpoints["monitor.beachvolleyballmedia.com"].change.previous.value, "203.0.113.12");

  const ready = await setup.controller.up(setup.manifest, setup.anchors);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.endpoints["monitor.beachvolleyballmedia.com"].change.action, "updated");
  await setup.controller.beginCoverage(setup.manifest, "START:turnkey-test");
  await setup.controller.closeCoverage(setup.manifest, "CLOSE:turnkey-test");
  const root = await mkdtemp(join(tmpdir(), "scorecheck-lifecycle-dns-evidence-"));
  await chmod(root, 0o700);
  const evidence = join(root, "evidence");
  await setup.controller.captureEvidence(setup.manifest, evidence);
  await setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test");
  assert.equal(dns.records.get("monitor.beachvolleyballmedia.com").value, "203.0.113.12");
});

test("does not become ready until Pushover accepts the readiness notification", async () => {
  const notifier = new FakeNotifier();
  notifier.failNext = 2;
  const setup = fixture({ notifier });
  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /Pushover did not accept/);
  const blocked = await setup.store.load();
  assert.equal(blocked.phase, "provisioning");
  assert.equal(blocked.notifications[`ready:${blocked.event}:${blocked.generationId}`].status, "failed");
  assert.equal(setup.cloud.createCalls, 12);

  const ready = await setup.controller.up(setup.manifest, setup.anchors);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.notifications[`ready:${ready.event}:${ready.generationId}`].status, "sent");
  assert.equal(setup.cloud.createCalls, 12);
  assert.equal(notifier.messages.length, 1);
});

test("refuses before creating anything when existing account occupancy cannot fit the complete stack", async () => {
  const cloud = new FakeDigitalOceanProvider({ dropletLimit: 12 });
  await cloud.createDroplet({
    name: "unrelated-existing-server",
    region: "sfo2",
    size: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    tags: ["unrelated"],
    userDataProfile: "none",
    userDataSha256: "0".repeat(64)
  });
  cloud.createCalls = 0;
  const setup = fixture({ cloud });

  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /current plus 12 missing event resources requires 13/);
  assert.equal(cloud.createCalls, 0);
  assert.equal(cloud.droplets.size, 1);
});

test("refuses before state or provider mutation when lifecycle attestation verification fails", async () => {
  const cloud = new FakeDigitalOceanProvider();
  const store = new MemoryStateStore();
  const setup = fixture({
    cloud,
    store,
    provisioningGuard: { async verify() { throw new Error("lifecycle attestation token mismatch"); } }
  });

  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /token mismatch/);
  assert.equal(cloud.createCalls, 0);
  assert.equal(cloud.droplets.size, 0);
  assert.equal(await store.load(), null);
});

test("hard-cuts pre-attestation lifecycle state before provider mutation", async () => {
  const initial = fixture();
  const legacy = createInitialState(initial.manifest, new Date("2026-08-01T12:00:00.000Z"));
  legacy.schemaVersion = 1;
  delete legacy.provisioningAttestation;
  const cloud = new FakeDigitalOceanProvider();
  const setup = fixture({ cloud, store: new MemoryStateStore(legacy) });

  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /schemaVersion must be 2/);
  assert.equal(cloud.createCalls, 0);
  assert.equal(cloud.droplets.size, 0);
});

test("refuses a same-name provider replacement and an extra event-tagged Droplet", async () => {
  const setup = fixture();
  const ready = await setup.controller.up(setup.manifest, setup.anchors);
  setup.cloud.replaceDropletId("bvm-compositor-a");
  await assert.rejects(() => setup.controller.status(setup.manifest), /provider ID changed/);

  const extra = await setup.cloud.createDroplet({
    name: "unexpected",
    region: "sfo2",
    size: "c-4",
    image: "ubuntu-24-04-x64",
    tags: lifecycleTags(setup.manifest, setup.manifest.droplets[0]),
    userDataProfile: "compositor",
    userDataSha256: setup.manifest.droplets[0].cloudInitSha256
  });
  assert.ok(extra.id);
  await assert.rejects(() => setup.controller.status(setup.manifest), /inventory mismatch/);
  assert.equal(ready.phase, "ready");
});

test("requires exact anchor slots, region, and unique IPv4 values", () => {
  const { manifest, anchors } = fixture();
  assert.equal(validateAnchorConfig(anchors, manifest), anchors);
  assert.throws(() => validateAnchorConfig({ ...anchors, region: "nyc3" }, manifest), /region/);
  assert.throws(() => validateAnchorConfig({ ...anchors, reservedIpv4: { ingest: "192.0.2.10" } }, manifest), /slots/);
  assert.throws(() => validateAnchorConfig({ ...anchors, reservedIpv4: { ingest: "192.0.2.10", commentary: "192.0.2.10" } }, manifest), /duplicated/);
});

test("FileStateStore writes protected atomic state and rejects concurrent lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-lifecycle-state-"));
  const statePath = join(root, "protected", "state.json");
  const store = new FileStateStore(statePath);
  const { manifest } = fixture();
  const controller = new EventLifecycleController({
    store,
    cloud: new FakeDigitalOceanProvider(),
    dns: new FakeDnsProvider(),
    deployer: new FakeStackDeployer(),
    now: () => new Date("2026-08-01T12:00:00.000Z")
  });
  await controller.plan(manifest);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "protected"))).mode & 0o777, 0o700);
  await store.withLock(async () => {
    await assert.rejects(() => store.withLock(async () => {}), /lock already exists/);
  });
});
