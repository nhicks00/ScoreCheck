#!/usr/bin/env node

import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { EventLifecycleController, MemoryStateStore } from "./event-lifecycle.mjs";
import { FakeDigitalOceanProvider, FakeDnsProvider, FakeNotifier, FakeStackDeployer } from "./fake-providers.mjs";

const inputs = await loadManifestInputs();
const today = new Date().toISOString().slice(0, 10);
const manifest = buildEventManifest({ event: "offline-production-rehearsal", destroyAfter: today, ...inputs });
const anchors = {
  schemaVersion: 1,
  provider: "digitalocean",
  region: manifest.provider.region,
  reservedIpv4: { ingest: "192.0.2.10", commentary: "192.0.2.11" }
};

const scenarios = [];
scenarios.push(await fullLifecycle());
scenarios.push(await partialCreateResume());
scenarios.push(await ambiguousCreateResume());
scenarios.push(await dnsFailureResume());

const passed = scenarios.every((entry) => entry.status === "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  simulation: "ScoreCheck 12-Droplet production lifecycle",
  mutationBoundary: "in-memory fake providers only",
  passed,
  scenarios
}, null, 2)}\n`);
if (!passed) process.exitCode = 1;

async function fullLifecycle() {
  const cloud = new FakeDigitalOceanProvider();
  const dns = new FakeDnsProvider({ "monitor.beachvolleyballmedia.com": "203.0.113.25" });
  const notifier = new FakeNotifier();
  const controller = new EventLifecycleController({
    store: new MemoryStateStore(), cloud, dns, deployer: new FakeStackDeployer(), notifier
  });
  const root = await mkdtemp(join(tmpdir(), "scorecheck-offline-rehearsal-"));
  await chmod(root, 0o700);
  const evidence = join(root, "evidence");
  try {
    await controller.plan(manifest);
    const ready = await controller.up(manifest, anchors);
    await controller.beginCoverage(manifest, `START:${manifest.event}`);
    let liveDestroyBlocked = false;
    try {
      await controller.destroy(manifest, evidence, `DESTROY:${manifest.event}`);
    } catch (error) {
      liveDestroyBlocked = /phase is live/.test(error.message);
    }
    await controller.closeCoverage(manifest, `CLOSE:${manifest.event}`);
    await controller.captureEvidence(manifest, evidence);
    const destroyed = await controller.destroy(manifest, evidence, `DESTROY:${manifest.event}`);
    const checks = {
      exactReadyDroplets: Object.keys(ready.droplets).length === 12,
      stableIngestIpv4: dns.records.get("preview.beachvolleyballmedia.com")?.value === anchors.reservedIpv4.ingest,
      stableCommentaryIpv4: dns.records.get("rtc.beachvolleyballmedia.com")?.value === anchors.reservedIpv4.commentary,
      liveDestroyBlocked,
      exactDeleteCount: cloud.deleteCalls.length === 12,
      computeInventoryEmpty: cloud.droplets.size === 0,
      retainedAddressesUnassigned: [...cloud.reserved.values()].every((entry) => entry.dropletId === null),
      finalPhaseDestroyed: destroyed.phase === "destroyed",
      plainLifecycleNotifications: notifier.messages.length === 2
    };
    return outcome("full production-shaped lifecycle", checks);
  } catch (error) {
    return failure("full production-shaped lifecycle", error);
  }
}

async function partialCreateResume() {
  const cloud = new FakeDigitalOceanProvider();
  cloud.failCreateAt = 6;
  const store = new MemoryStateStore();
  const controller = new EventLifecycleController({ store, cloud, dns: new FakeDnsProvider(), deployer: new FakeStackDeployer() });
  try {
    try { await controller.up(manifest, anchors); } catch {}
    const partialCount = cloud.droplets.size;
    cloud.failCreateAt = null;
    const ready = await controller.up(manifest, anchors);
    return outcome("definite partial-create resume", {
      partialInventoryPreserved: partialCount === 5,
      exactFinalInventory: cloud.droplets.size === 12,
      noDuplicateNames: new Set([...cloud.droplets.values()].map((entry) => entry.name)).size === 12,
      ready: ready.phase === "ready"
    });
  } catch (error) {
    return failure("definite partial-create resume", error);
  }
}

async function ambiguousCreateResume() {
  const cloud = new FakeDigitalOceanProvider();
  cloud.ambiguousCreateAt = 4;
  const controller = new EventLifecycleController({ store: new MemoryStateStore(), cloud, dns: new FakeDnsProvider(), deployer: new FakeStackDeployer() });
  try {
    try { await controller.up(manifest, anchors); } catch {}
    const providerCount = cloud.droplets.size;
    cloud.ambiguousCreateAt = null;
    const ready = await controller.up(manifest, anchors);
    return outcome("ambiguous-create exact reconciliation", {
      ambiguousResourcePreserved: providerCount === 4,
      exactFinalInventory: cloud.droplets.size === 12,
      onlyTwelveCreateCalls: cloud.createCalls === 12,
      ready: ready.phase === "ready"
    });
  } catch (error) {
    return failure("ambiguous-create exact reconciliation", error);
  }
}

async function dnsFailureResume() {
  const cloud = new FakeDigitalOceanProvider();
  const dns = new FakeDnsProvider();
  dns.failHostname = "monitor.beachvolleyballmedia.com";
  const controller = new EventLifecycleController({ store: new MemoryStateStore(), cloud, dns, deployer: new FakeStackDeployer() });
  try {
    try { await controller.up(manifest, anchors); } catch {}
    const createdBeforeRetry = cloud.createCalls;
    dns.failHostname = null;
    const ready = await controller.up(manifest, anchors);
    return outcome("DNS failure resume", {
      fleetRetainedOnDnsFailure: cloud.droplets.size === 12,
      noDropletRecreateDuringRetry: createdBeforeRetry === 12 && cloud.createCalls === 12,
      ready: ready.phase === "ready"
    });
  } catch (error) {
    return failure("DNS failure resume", error);
  }
}

function outcome(name, checks) {
  return { name, status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks };
}

function failure(name, error) {
  return { name, status: "FAIL", error: error instanceof Error ? error.message : String(error) };
}
