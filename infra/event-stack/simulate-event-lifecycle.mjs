#!/usr/bin/env node

import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { EventLifecycleController, MemoryStateStore } from "./event-lifecycle.mjs";
import { fakeProvisioningAttestation, FakeDigitalOceanProvider, FakeDnsProvider, FakeNotifier, FakeStackDeployer } from "./fake-providers.mjs";
import { sealRehearsalEvidence } from "./rehearsal/rehearsal-evidence.mjs";

const inputs = await loadManifestInputs();
const today = new Date().toISOString().slice(0, 10);
const manifest = buildEventManifest({ event: "offline-production-rehearsal", kind: "rehearsal", destroyAfter: today, ...inputs });
const ingestHostname = endpointHostname("ingest", "preview");
const rtcHostname = endpointHostname("commentary", "rtc");
const monitorHostname = endpointHostname("observability", "monitor");
const anchors = {
  schemaVersion: 2,
  provider: "digitalocean",
  region: manifest.provider.region,
  retention: "ephemeral",
  reservedIpv4: {}
};
const PASSING_PROVISIONING_GUARD = { async verify() { return fakeProvisioningAttestation(); } };

const scenarios = [];
scenarios.push(await fullLifecycle());
scenarios.push(await partialCreateResume());
scenarios.push(await ambiguousCreateResume());
scenarios.push(await dnsFailureResume());
scenarios.push(await partialBuildAbort());

const passed = scenarios.every((entry) => entry.status === "PASS");
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  simulation: "ScoreCheck isolated 12-Droplet rehearsal lifecycle",
  mutationBoundary: "in-memory fake providers only",
  passed,
  scenarios
}, null, 2)}\n`);
if (!passed) process.exitCode = 1;

async function fullLifecycle() {
  const cloud = rehearsalCloud();
  const dns = new FakeDnsProvider();
  const notifier = new FakeNotifier();
  const store = new MemoryStateStore();
  const controller = new EventLifecycleController({
    store, cloud, dns, deployer: new FakeStackDeployer(), notifier,
    provisioningGuard: PASSING_PROVISIONING_GUARD
  });
  const root = await mkdtemp(join(tmpdir(), "scorecheck-offline-rehearsal-"));
  await chmod(root, 0o700);
  const evidence = join(root, "evidence");
  try {
    const initialComputeInventoryEmpty = cloud.droplets.size === 0;
    await controller.plan(manifest);
    const ready = await controller.up(manifest, anchors);
    const isolatedIngestIpv4 = dns.records.get(ingestHostname)?.value === roleIpv4(ready, "ingest");
    const isolatedCommentaryIpv4 = dns.records.get(rtcHostname)?.value === roleIpv4(ready, "commentary");
    await controller.beginCoverage(manifest, `START:${manifest.event}`);
    let liveDestroyBlocked = false;
    try {
      await controller.destroy(manifest, evidence, `DESTROY:${manifest.event}`);
    } catch (error) {
      liveDestroyBlocked = /phase is live/.test(error.message);
    }
    await controller.closeCoverage(manifest, `CLOSE:${manifest.event}`);
    const rehearsalEvidence = await cleanedRehearsalEvidence({ state: await store.load() }, root);
    await controller.captureEvidence(manifest, evidence, rehearsalEvidence);
    const destroyed = await controller.destroy(manifest, evidence, `DESTROY:${manifest.event}`);
    const checks = {
      initialComputeInventoryEmpty,
      exactReadyDroplets: Object.keys(ready.droplets).length === 12,
      isolatedIngestIpv4,
      isolatedCommentaryIpv4,
      liveDestroyBlocked,
      exactDeleteCount: cloud.deleteCalls.length === 12,
      computeInventoryEmpty: cloud.droplets.size === 0,
      noRehearsalReservedIpv4s: cloud.reserved.size === 0,
      isolatedDnsRemoved: manifest.endpoints.every((entry) => !dns.records.has(entry.hostname)),
      finalPhaseDestroyed: destroyed.phase === "destroyed",
      plainLifecycleNotifications: notifier.messages.length === 2
    };
    return outcome("full isolated rehearsal lifecycle", checks);
  } catch (error) {
    return failure("full isolated rehearsal lifecycle", error);
  }
}

async function partialCreateResume() {
  const cloud = rehearsalCloud();
  cloud.failCreateAt = 6;
  const store = new MemoryStateStore();
  const controller = new EventLifecycleController({ store, cloud, dns: new FakeDnsProvider(), deployer: new FakeStackDeployer(), provisioningGuard: PASSING_PROVISIONING_GUARD });
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
  const cloud = rehearsalCloud();
  cloud.ambiguousCreateAt = 4;
  const controller = new EventLifecycleController({ store: new MemoryStateStore(), cloud, dns: new FakeDnsProvider(), deployer: new FakeStackDeployer(), provisioningGuard: PASSING_PROVISIONING_GUARD });
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
  const cloud = rehearsalCloud();
  const dns = new FakeDnsProvider();
  dns.failHostname = monitorHostname;
  const controller = new EventLifecycleController({ store: new MemoryStateStore(), cloud, dns, deployer: new FakeStackDeployer(), provisioningGuard: PASSING_PROVISIONING_GUARD });
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

async function partialBuildAbort() {
  const cloud = rehearsalCloud();
  cloud.failCreateAt = 5;
  const store = new MemoryStateStore();
  const dns = new FakeDnsProvider();
  const notifier = new FakeNotifier();
  const controller = new EventLifecycleController({
    store,
    cloud,
    dns,
    deployer: new FakeStackDeployer(),
    notifier,
    provisioningGuard: PASSING_PROVISIONING_GUARD
  });
  const root = await mkdtemp(join(tmpdir(), "scorecheck-offline-abort-"));
  await chmod(root, 0o700);
  const evidence = join(root, "abort-evidence");
  try {
    try { await controller.up(manifest, anchors); } catch {}
    const partialCount = cloud.droplets.size;
    const rehearsalEvidence = await cleanedRehearsalEvidence({ state: await store.load() }, root);
    const aborted = await controller.abort(manifest, evidence, `ABORT:${manifest.event}`, rehearsalEvidence);
    return outcome("failed pre-live build abort", {
      partialBuildExisted: partialCount === 4,
      computeInventoryEmpty: cloud.droplets.size === 0,
      noRehearsalReservedIpv4s: cloud.reserved.size === 0,
      isolatedDnsRemoved: manifest.endpoints.every((entry) => !dns.records.has(entry.hostname)),
      durableAbortEvidence: aborted.abort?.status === "complete",
      finalPhaseAborted: aborted.phase === "aborted",
      plainAbortNotification: notifier.messages.some((entry) => /cancelled/.test(entry.title))
    });
  } catch (error) {
    return failure("failed pre-live build abort", error);
  }
}

function outcome(name, checks) {
  return { name, status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL", checks };
}

function failure(name, error) {
  return { name, status: "FAIL", error: error instanceof Error ? error.message : String(error) };
}

function endpointHostname(role, prefix) {
  const endpoint = manifest.endpoints.find((entry) => entry.role === role && entry.hostname.split(".", 1)[0].startsWith(prefix));
  if (!endpoint) throw new Error(`manifest has no ${prefix} endpoint for ${role}`);
  return endpoint.hostname;
}

function roleIpv4(state, role) {
  const spec = manifest.droplets.find((entry) => entry.role === role);
  return state.droplets[spec.name].publicIpv4;
}

function rehearsalCloud() {
  return new FakeDigitalOceanProvider({ reservedIpv4: {} });
}

async function cleanedRehearsalEvidence(status, root) {
  const lifecycle = status.state;
  const directory = join(root, "rehearsal-evidence");
  await mkdir(directory, { mode: 0o700 });
  const state = {
    phase: "cleaned",
    event: lifecycle.event,
    generationId: lifecycle.generationId,
    manifestSha256: lifecycle.manifestSha256,
    providerMode: "persistent-youtube-stream-ingest-v1",
    createdAt: lifecycle.createdAt,
    preparedAt: null,
    startedAt: null,
    stoppedAt: null,
    cleanedAt: new Date().toISOString(),
    program: { project: { id: "offline-project", status: "absent" } },
    courts: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [index + 1, {
      providerCleanup: { mode: "persistent-youtube-stream-ingest-v1", status: "not-adopted", streamId: null }
    }])),
    startEvidence: null,
    soakEvidence: null,
    endpointEvidence: null,
    stopEvidence: null
  };
  await sealRehearsalEvidence({ state, manifest, evidenceDirectory: directory });
  return directory;
}
