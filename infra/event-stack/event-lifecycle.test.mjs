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
import { sealRehearsalEvidence } from "./rehearsal/rehearsal-evidence.mjs";

const inputs = await loadManifestInputs();

function fixture(overrides = {}) {
  const now = overrides.now ?? new Date("2026-08-01T12:00:00.000Z");
  const manifest = buildEventManifest({
    event: "turnkey-test",
    kind: overrides.kind ?? "production",
    destroyAfter: "2026-08-01",
    ...inputs
  });
  const anchors = {
    schemaVersion: 2,
    provider: "digitalocean",
    region: "sfo2",
    retention: (overrides.kind ?? "production") === "rehearsal" ? "ephemeral" : "persistent",
    reservedIpv4: (overrides.kind ?? "production") === "rehearsal"
      ? {}
      : { ingest: "192.0.2.10", commentary: "192.0.2.11" }
  };
  const cloud = overrides.cloud ?? new FakeDigitalOceanProvider({
    reservedIpv4: (overrides.kind ?? "production") === "rehearsal"
      ? {}
      : { ingest: "192.0.2.10", commentary: "192.0.2.11" }
  });
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

async function prepareDestroyableLifecycle(setup, label) {
  await setup.controller.up(setup.manifest, setup.anchors);
  await setup.controller.beginCoverage(setup.manifest, `START:${setup.manifest.event}`);
  await setup.controller.closeCoverage(setup.manifest, `CLOSE:${setup.manifest.event}`);
  const root = await mkdtemp(join(tmpdir(), `scorecheck-${label}-`));
  await chmod(root, 0o700);
  const evidence = join(root, "evidence");
  const rehearsalEvidence = setup.manifest.kind === "rehearsal" ? await fakeCleanedRehearsalEvidence(setup, root) : null;
  await setup.controller.captureEvidence(setup.manifest, evidence, rehearsalEvidence);
  return evidence;
}

async function fakeCleanedRehearsalEvidence(setup, root) {
  const lifecycle = await setup.store.load();
  const directory = join(root, "rehearsal-evidence");
  await mkdir(directory, { mode: 0o700 });
  const state = {
    phase: "cleaned",
    event: lifecycle.event,
    generationId: lifecycle.generationId,
    manifestSha256: lifecycle.manifestSha256,
    createdAt: lifecycle.createdAt,
    preparedAt: null,
    startedAt: null,
    stoppedAt: null,
    cleanedAt: "2026-08-01T12:00:00.000Z",
    program: { project: { id: "project-test", status: "deleted" } },
    courts: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, {
      stream: { id: `stream-${index + 1}`, status: "deleted" },
      broadcast: { id: `broadcast-${index + 1}`, status: "deleted" }
    }])),
    startEvidence: null,
    soakEvidence: null,
    endpointEvidence: null,
    stopEvidence: null
  };
  await sealRehearsalEvidence({ state, manifest: setup.manifest, evidenceDirectory: directory, now: new Date("2026-08-01T12:00:00.000Z") });
  return directory;
}

async function protectedEvidencePath(label) {
  const root = await mkdtemp(join(tmpdir(), `scorecheck-${label}-`));
  await chmod(root, 0o700);
  return join(root, "evidence");
}

async function protectedRehearsalEvidencePath(setup, label) {
  const root = await mkdtemp(join(tmpdir(), `scorecheck-${label}-`));
  await chmod(root, 0o700);
  return fakeCleanedRehearsalEvidence(setup, root);
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

test("allows an isolated rehearsal to tear down before a production-style review date", async () => {
  const setup = fixture({ kind: "rehearsal", now: new Date("2026-07-16T12:00:00.000Z") });
  const evidence = await prepareDestroyableLifecycle(setup, "early-rehearsal-destroy");
  const destroyed = await setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test");
  assert.equal(destroyed.phase, "destroyed");
  assert.equal(setup.cloud.droplets.size, 0);
  assert.equal(setup.cloud.deleteCalls.length, 12);
});

test("still rejects early production teardown", async () => {
  const setup = fixture({ now: new Date("2026-07-16T12:00:00.000Z") });
  const evidence = await prepareDestroyableLifecycle(setup, "early-production-destroy");
  await assert.rejects(
    () => setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test"),
    /destroy review date is 2026-08-01/
  );
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

test("rehearsal teardown removes every event DNS record without allocating Reserved IPv4s", async () => {
  const setup = fixture({ kind: "rehearsal" });
  const evidence = await prepareDestroyableLifecycle(setup, "rehearsal-cleanup");
  const eventHostnames = setup.manifest.endpoints.map((entry) => entry.hostname);
  assert.ok(eventHostnames.every((hostname) => setup.dns.records.has(hostname)));

  const destroyed = await setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test");

  assert.equal(destroyed.phase, "destroyed");
  assert.ok(eventHostnames.every((hostname) => !setup.dns.records.has(hostname)));
  assert.deepEqual([...setup.dns.restores].sort(), [...eventHostnames].sort());
  assert.equal(setup.cloud.reserved.size, 0);
  assert.deepEqual(setup.cloud.reservedDeleteCalls, []);
  assert.deepEqual(destroyed.addressSlots, {});
});

test("destroy resumes after an ambiguous Droplet deletion without duplicates or broad deletion", async () => {
  const setup = fixture();
  const evidence = await prepareDestroyableLifecycle(setup, "ambiguous-droplet-delete");
  setup.cloud.ambiguousDeleteAt = 3;

  await assert.rejects(
    () => setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test"),
    /ambiguous delete result/
  );
  assert.equal((await setup.store.load()).phase, "destroying");
  assert.equal(setup.cloud.droplets.size, 9);

  setup.cloud.ambiguousDeleteAt = null;
  const destroyed = await setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test");
  assert.equal(destroyed.phase, "destroyed");
  assert.equal(setup.cloud.droplets.size, 0);
  assert.equal(new Set(setup.cloud.deleteCalls).size, 12);
  assert.equal(setup.cloud.deleteCalls.length, 12);
});

test("rehearsal destroy resumes after an ambiguous DNS cleanup result", async () => {
  const setup = fixture({ kind: "rehearsal" });
  const evidence = await prepareDestroyableLifecycle(setup, "ambiguous-rehearsal-cleanup");
  const firstHostname = setup.manifest.endpoints[0].hostname;
  setup.dns.ambiguousRestoreHostname = firstHostname;

  await assert.rejects(
    () => setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test"),
    /ambiguous DNS restoration/
  );
  assert.equal(setup.cloud.droplets.size, 0);
  assert.equal(setup.dns.records.has(firstHostname), false);

  const destroyed = await setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test");
  assert.equal(destroyed.phase, "destroyed");
  assert.equal(setup.cloud.reserved.size, 0);
  assert.ok(setup.manifest.endpoints.every((entry) => !setup.dns.records.has(entry.hostname)));
});

test("teardown remains retryable until Pushover accepts exactly one completion message", async () => {
  const setup = fixture({ kind: "rehearsal" });
  const evidence = await prepareDestroyableLifecycle(setup, "teardown-notification");
  setup.notifier.failNext = 1;

  await assert.rejects(
    () => setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test"),
    /Pushover did not accept/
  );
  assert.equal((await setup.store.load()).phase, "destroying");
  assert.equal(setup.cloud.droplets.size, 0);
  assert.equal(setup.cloud.reserved.size, 0);

  const destroyed = await setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test");
  assert.equal(destroyed.phase, "destroyed");
  assert.equal(setup.notifier.messages.filter((entry) => /removed/.test(entry.title)).length, 1);
  assert.equal(setup.cloud.deleteCalls.length, 12);
});

test("rehearsal setup refuses to adopt any pre-existing event-scoped DNS record", async () => {
  const seed = fixture({ kind: "rehearsal" });
  const hostname = seed.manifest.endpoints[0].hostname;
  const dns = new FakeDnsProvider({ [hostname]: "203.0.113.99" });
  const setup = fixture({ kind: "rehearsal", dns });

  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /refusing ambiguous ownership/);
  assert.equal(dns.records.get(hostname).value, "203.0.113.99");
});

test("abort removes a partial dynamic-address rehearsal before the first endpoint", async () => {
  const cloud = new FakeDigitalOceanProvider({ reservedIpv4: {} });
  cloud.failCreateAt = 5;
  const setup = fixture({ kind: "rehearsal", cloud });
  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /definite create failure/);
  assert.equal(cloud.droplets.size, 4);
  assert.equal((await setup.store.load()).addressSlots && Object.keys((await setup.store.load()).addressSlots).length, 0);
  const evidence = await protectedEvidencePath("partial-abort");
  const rehearsalEvidence = await protectedRehearsalEvidencePath(setup, "partial-abort-provider-cleanup");

  const aborted = await setup.controller.abort(setup.manifest, evidence, "ABORT:turnkey-test", rehearsalEvidence);

  assert.equal(aborted.phase, "aborted");
  assert.equal(cloud.droplets.size, 0);
  assert.equal(cloud.reserved.size, 0);
  assert.deepEqual(aborted.addressSlots, {});
  assert.equal(JSON.parse(await readFile(join(evidence, "ABORT_COMPLETE.json"), "utf8")).event, "turnkey-test");
  assert.equal((await stat(evidence)).mode & 0o777, 0o700);
});

test("abort adopts only an exact event-tagged ambiguous create before deleting it", async () => {
  const cloud = new FakeDigitalOceanProvider();
  cloud.ambiguousCreateAt = 3;
  const setup = fixture({ kind: "rehearsal", cloud });
  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /ambiguous create result/);
  assert.equal(cloud.droplets.size, 3);
  assert.equal(Object.keys((await setup.store.load()).droplets).length, 2);

  const aborted = await setup.controller.abort(
    setup.manifest,
    await protectedEvidencePath("ambiguous-create-abort"),
    "ABORT:turnkey-test",
    await protectedRehearsalEvidencePath(setup, "ambiguous-create-provider-cleanup")
  );

  assert.equal(aborted.phase, "aborted");
  assert.equal(cloud.droplets.size, 0);
  assert.equal(cloud.deleteCalls.length, 3);
  assert.ok(Object.values(aborted.droplets).some((entry) => entry.adoptedForAbort === true));
});

test("ready production abort restores every changed DNS record and retains stable Reserved IPv4s", async () => {
  const initialDns = {
    "preview.beachvolleyballmedia.com": "203.0.113.10",
    "rtc.beachvolleyballmedia.com": "203.0.113.11",
    "turn.beachvolleyballmedia.com": "203.0.113.11",
    "monitor.beachvolleyballmedia.com": "203.0.113.12"
  };
  const setup = fixture({ dns: new FakeDnsProvider(initialDns) });
  await setup.controller.up(setup.manifest, setup.anchors);

  const aborted = await setup.controller.abort(
    setup.manifest,
    await protectedEvidencePath("ready-production-abort"),
    "ABORT:turnkey-test"
  );

  assert.equal(aborted.phase, "aborted");
  assert.equal(setup.cloud.reserved.size, 2);
  assert.ok(Object.values(aborted.addressSlots).every((entry) => entry.status === "retained"));
  assert.deepEqual(
    Object.fromEntries([...setup.dns.records].map(([hostname, record]) => [hostname, record.value])),
    initialDns
  );
});

test("abort is resumable after an ambiguous deletion and is permanently unavailable after coverage starts", async () => {
  const setup = fixture({ kind: "rehearsal" });
  await setup.controller.up(setup.manifest, setup.anchors);
  const evidence = await protectedEvidencePath("resumable-abort");
  const rehearsalEvidence = await protectedRehearsalEvidencePath(setup, "resumable-abort-provider-cleanup");
  setup.cloud.ambiguousDeleteAt = 2;
  await assert.rejects(() => setup.controller.abort(setup.manifest, evidence, "ABORT:turnkey-test", rehearsalEvidence), /ambiguous delete result/);
  assert.equal((await setup.store.load()).phase, "aborting");
  setup.cloud.ambiguousDeleteAt = null;
  assert.equal((await setup.controller.abort(setup.manifest, evidence, "ABORT:turnkey-test", rehearsalEvidence)).phase, "aborted");
  assert.equal(setup.cloud.deleteCalls.length, 12);

  const live = fixture();
  await live.controller.up(live.manifest, live.anchors);
  await live.controller.beginCoverage(live.manifest, "START:turnkey-test");
  const forbiddenEvidence = await protectedEvidencePath("forbidden-live-abort");
  await assert.rejects(
    () => live.controller.abort(live.manifest, forbiddenEvidence, "ABORT:turnkey-test"),
    /phase is live/
  );
  assert.equal(live.cloud.droplets.size, 12);
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

test("status accepts an exact empty plan and exact partial provisioning inventory", async () => {
  const setup = fixture();
  await setup.controller.plan(setup.manifest);

  const planned = await setup.controller.status(setup.manifest);
  assert.equal(planned.state.phase, "planned");
  assert.deepEqual(planned.inventory, []);
  assert.equal(planned.networkContract.healthy, true);

  const spec = setup.manifest.droplets[0];
  const created = await setup.cloud.createDroplet({
    name: spec.providerName,
    region: spec.region,
    vpcUuid: setup.manifest.provider.vpcUuid,
    size: spec.size,
    image: spec.image,
    tags: lifecycleTags(setup.manifest, spec),
    userDataProfile: spec.cloudInitProfile,
    userDataSha256: spec.cloudInitSha256
  });
  const state = await setup.store.load();
  state.phase = "provisioning";
  state.provisioningAttestation = fakeProvisioningAttestation();
  await setup.store.save(state);

  const provisioning = await setup.controller.status(setup.manifest);
  assert.equal(provisioning.state.phase, "provisioning");
  assert.deepEqual(provisioning.inventory.map((entry) => entry.id), [created.id]);
});

test("status rejects unexpected event resources before provisioning", async () => {
  const setup = fixture();
  await setup.controller.plan(setup.manifest);
  const spec = setup.manifest.droplets[0];
  await setup.cloud.createDroplet({
    name: "unexpected-planned-resource",
    region: spec.region,
    vpcUuid: setup.manifest.provider.vpcUuid,
    size: spec.size,
    image: spec.image,
    tags: lifecycleTags(setup.manifest, spec),
    userDataProfile: spec.cloudInitProfile,
    userDataSha256: spec.cloudInitSha256
  });

  await assert.rejects(() => setup.controller.status(setup.manifest), /unexpected resource/);
});

test("status rejects a provider survivor after terminal teardown", async () => {
  const setup = fixture();
  const evidence = await prepareDestroyableLifecycle(setup, "terminal-inventory");
  await setup.controller.destroy(setup.manifest, evidence, "DESTROY:turnkey-test");

  const spec = setup.manifest.droplets[0];
  await setup.cloud.createDroplet({
    name: spec.providerName,
    region: spec.region,
    vpcUuid: setup.manifest.provider.vpcUuid,
    size: spec.size,
    image: spec.image,
    tags: lifecycleTags(setup.manifest, spec),
    userDataProfile: spec.cloudInitProfile,
    userDataSha256: spec.cloudInitSha256
  });

  await assert.rejects(() => setup.controller.status(setup.manifest), /terminal event inventory is not empty/);
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

test("refuses before creating anything when the persistent network contract drifted", async () => {
  const cloud = new FakeDigitalOceanProvider({ dropletLimit: 19 });
  cloud.networkHealthy = false;
  cloud.networkProblems = ["firewall bvm-preview-firewall inbound rules drifted"];
  const setup = fixture({ cloud, kind: "rehearsal" });

  await assert.rejects(
    () => setup.controller.up(setup.manifest, setup.anchors),
    /network contract is unhealthy.*preview-firewall/u
  );
  assert.equal(cloud.networkVerifyCalls, 1);
  assert.equal(cloud.createCalls, 0);
  assert.equal(cloud.droplets.size, 0);
  assert.equal((await setup.store.load()).networkContract.status, "unhealthy");
});

test("creates a 12-Droplet rehearsal beside seven legacy servers without adopting or renaming them", async () => {
  const cloud = new FakeDigitalOceanProvider({ dropletLimit: 19 });
  const legacyNames = [
    "bvm-commentary-01",
    "bvm-observability-01",
    "bvm-preview-01",
    "bvm-compositor-a",
    "bvm-compositor-b",
    "bvm-compositor-c",
    "bvm-compositor-d"
  ];
  for (const name of legacyNames) {
    await cloud.createDroplet({
      name,
      region: "sfo2",
      size: "c-4",
      image: "ubuntu-24-04-x64",
      tags: ["legacy-production"],
      userDataProfile: "none",
      userDataSha256: "0".repeat(64)
    });
  }
  const legacyBefore = [...cloud.droplets.values()].map((entry) => structuredClone(entry));
  cloud.createCalls = 0;
  const setup = fixture({ cloud, kind: "rehearsal" });
  const ready = await setup.controller.up(setup.manifest, setup.anchors);

  assert.equal(ready.phase, "ready");
  assert.equal(cloud.droplets.size, 19);
  assert.equal(cloud.createCalls, 12);
  assert.deepEqual(
    [...cloud.droplets.values()].filter((entry) => entry.tags.includes("legacy-production")),
    legacyBefore
  );
  assert.ok(setup.manifest.endpoints.every((entry) => entry.hostname.includes(setup.manifest.namespace)));
  assert.match(setup.notifier.messages[0].title, /TEST rehearsal/);
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

  await assert.rejects(() => setup.controller.up(setup.manifest, setup.anchors), /schemaVersion must be 6/);
  assert.equal(cloud.createCalls, 0);
  assert.equal(cloud.droplets.size, 0);
});

test("refuses a same-name provider replacement and an extra event-tagged Droplet", async () => {
  const setup = fixture();
  const ready = await setup.controller.up(setup.manifest, setup.anchors);
  const compositor = setup.manifest.droplets.find((entry) => entry.name === "bvm-compositor-a");
  setup.cloud.replaceDropletId(compositor.providerName);
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
  assert.throws(() => validateAnchorConfig({ ...anchors, retention: "ephemeral" }, manifest), /retention/);
  assert.throws(() => validateAnchorConfig({ ...anchors, reservedIpv4: { ingest: "192.0.2.10" } }, manifest), /slots/);
  assert.throws(() => validateAnchorConfig({ ...anchors, reservedIpv4: { ingest: "192.0.2.10", commentary: "192.0.2.10" } }, manifest), /duplicated/);
});

test("requires an empty rehearsal anchor binding because every rehearsal endpoint is dynamic", () => {
  const { manifest, anchors } = fixture({ kind: "rehearsal" });
  assert.equal(validateAnchorConfig(anchors, manifest), anchors);
  assert.throws(
    () => validateAnchorConfig({ ...anchors, reservedIpv4: { ingest: "192.0.2.10" } }, manifest),
    /slots/
  );
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
