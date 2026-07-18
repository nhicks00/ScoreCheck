import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildEventManifest, loadManifestInputs } from "../event-manifest.mjs";
import { RehearsalController, RehearsalMemoryStateStore, rehearsalSummary } from "./rehearsal-controller.mjs";
import { createRehearsalSecretMaterial } from "./rehearsal-secrets.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "rehearsal-controller", kind: "rehearsal", destroyAfter: "2026-08-01", ...inputs });
const generationId = "generation-1234";
const material = createRehearsalSecretMaterial({ random: (length) => Buffer.alloc(length, 9) });

function lifecycleState(phase = "planned") {
  return {
    event: manifest.event,
    kind: "rehearsal",
    generationId,
    manifestSha256: digest(manifest),
    phase,
    droplets: Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, { publicIpv4: `198.51.100.${index + 1}` }]))
  };
}

function harness({ failPublisherOnce = false, failPreflight = false, failFullEvidence = false, failIdle = false, failSoakOnce = false, orphanedProviderResources = false } = {}) {
  const log = [];
  let publisherFailure = failPublisherOnce;
  let soakFailure = failSoakOnce;
  const activeEgress = new Map();
  const store = new RehearsalMemoryStateStore();
  const vercel = {
    ensureProject: async ({ name, repository }) => ({ id: "prj_test", name, origin: `https://${name}.vercel.app`, framework: "nextjs", rootDirectory: "apps/web", repository: { slug: repository.slug, repoId: String(repository.repoId) } }),
    ensureDeployment: async ({ project, generationId: marker }) => ({ id: "dpl_test", projectId: project.id, name: project.name, state: "BUILDING", target: "production", aliases: [], marker }),
    waitReady: async ({ project, generationId: marker }) => ({ id: "dpl_test", projectId: project.id, name: project.name, state: "READY", target: "production", aliases: [`${project.name}.vercel.app`], marker }),
    verifyProgramPage: async ({ project }) => ({ status: "healthy", origin: project.origin, acceptedStatus: 200, rejectedStatus: 404 }),
    findProject: async (name) => orphanedProviderResources ? { id: "prj_orphan", name, origin: `https://${name}.vercel.app`, framework: "nextjs", rootDirectory: "apps/web" } : null,
    deleteProject: async (id) => { log.push(`delete-project:${id}`); return { absent: true }; }
  };
  const youtube = {
    resolvePersistentStreamPool: async () => Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
      const court = index + 1;
      return [court, {
        id: `stream${court}`,
        court,
        title: `ScoreCheck Court ${court} Test Stream`,
        isReusable: true,
        streamName: `key${court}`,
        rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
        streamStatus: "inactive",
        healthStatus: "noData",
        configurationIssues: []
      }];
    })),
    waitForStream: async ({ streamId, streamStatus }) => {
      log.push(`youtube-${streamStatus}:${streamId}`);
      const court = Number(streamId.replace("stream", ""));
      return {
        id: streamId,
        court,
        title: `ScoreCheck Court ${court} Test Stream`,
        isReusable: true,
        streamName: `key${court}`,
        rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
        streamStatus,
        healthStatus: streamStatus === "active" ? "good" : "noData",
        configurationIssues: []
      };
    }
  };
  const publishers = {
    preflight: async () => ({ healthy: true }),
    prepare: async (config) => { log.push(`publisher-prepare:${config.court}`); return { adopted: false }; },
    ensure: async (config) => {
      if (publisherFailure && config.court === 3) { publisherFailure = false; throw new Error("intentional publisher interruption"); }
      log.push(`publisher-start:${config.court}`);
      return { pid: 100 + config.court, marker: config.marker, status: "running" };
    },
    waitForHealthy: async () => ({ passed: true, stableSamples: 3, samples: [], problems: [] }),
    stop: async ({ marker }) => { log.push(`publisher-stop:${marker.at(-1)}`); return { absent: true }; }
  };
  const egress = {
    preflight: async () => ({ healthy: true }),
    ensureStarted: async ({ host, court }) => {
      log.push(`egress-start:${court}`);
      const value = { id: `EG_${court}`, status: "active" };
      activeEgress.set(host, value);
      return value;
    },
    proveSecondStartRejected: async ({ expectedId }) => ({ rejected: true, activeId: expectedId }),
    listActive: async (host) => activeEgress.has(host) ? [activeEgress.get(host)] : [],
    stopExact: async ({ host, court, egressId }) => {
      log.push(`egress-stop:${court}:${egressId}`);
      activeEgress.delete(host);
      return { absent: true };
    }
  };
  const commentary = {
    preflight: async () => ({ healthy: true }),
    ensure: async (config) => { log.push(`commentary-start:${config.court}`); return { status: "running", marker: config.marker, pid: 300 + config.court }; },
    stop: async ({ marker }) => { log.push(`commentary-stop:${marker.at(-1)}`); return { absent: true }; }
  };
  const sampler = {
    ensure: async () => { log.push("sampler-start"); return { status: "running", pid: 555, output: "/evidence/pool.jsonl" }; },
    stop: async (state) => ({ ...state, status: "stopped" })
  };
  const verifier = {
    preflight: async () => {
      if (failPreflight) throw new Error("intentional preflight failure");
      return { healthy: true };
    },
    waitForRaw: async () => ({ healthy: true }),
    waitForProgramSubscriber: async ({ court }) => {
      log.push(`program-subscriber:${court}`);
      return { passed: true, court, stableSamples: 2 };
    },
    waitForFull: async () => {
      log.push("full-baseline");
      if (failFullEvidence) {
        const error = new Error("intentional full-chain stabilization failure");
        error.evidenceKind = "monitor";
        error.evidence = { passed: false, snapshot: { agentCount: 12 }, problems: ["Camera 4 browser quality counters are not clean"] };
        throw error;
      }
      return { passed: true, snapshot: { baselineId: "accepted-full-baseline", courts: Array.from({ length: 8 }, (_, index) => ({ courtNumber: index + 1, browser: { credentialId: `browser-${index + 1}` } })) } };
    },
    restoreAcceptedFullSnapshot: (snapshot) => { log.push(`restore-baseline:${snapshot.baselineId}`); return { restored: true }; },
    captureEndpoint: async () => ({ passed: true }),
    waitForIdle: async () => {
      if (failIdle) throw new Error("idle verifier must not run");
      return { healthy: true };
    }
  };
  const soakEvaluator = {
    run: async ({ state }) => {
      log.push(`soak-run:${state.soak.startedAt}:${state.soak.baselineEvidence.snapshot.baselineId}`);
      if (soakFailure) {
        soakFailure = false;
        throw new Error("intentional soak process interruption");
      }
      return { passed: true, event: state.event, generationId: state.generationId, problems: [], reportPath: "/evidence/rehearsal-soak-report.json" };
    }
  };
  const sealEvidence = async ({ state, evidenceDirectory }) => ({ directory: evidenceDirectory, markerPath: `${evidenceDirectory}/REHEARSAL_COMPLETE.json`, event: state.event, generationId: state.generationId, classification: state.soakEvidence?.passed ? "PASS" : "CANCELLED", providerCleanupComplete: true });
  const controller = new RehearsalController({
    store, vercel, youtube, publishers, commentary, egress, sampler, verifier, soakEvaluator, sealEvidence,
    renderSecrets: async ({ directory }) => directory,
    programEnvironment: ({ programOrigin }) => ({ NEXT_PUBLIC_SCORECHECK_REHEARSAL: "true", SCORECHECK_REHEARSAL_ORIGIN: programOrigin }),
    publisherConfiguration: ({ court, state }) => ({ court, marker: state.courts[court].publisherMarker, ffmpegPath: "ffmpeg", args: [`comment=${state.courts[court].publisherMarker}`] }),
    commentaryConfiguration: ({ court }) => ({ court, marker: `scorecheck-rehearsal-${generationId}-commentator-${court}` })
  });
  return { controller, store, log, activeEgress };
}

test("runs the full isolated rehearsal and retains every persistent stream by exact id", async () => {
  const { controller, log } = harness();
  const lifecycle = lifecycleState();
  await controller.plan({ manifest, lifecycleState: lifecycle });
  await controller.prepare({ manifest, lifecycleState: lifecycle, material, git: { repo: "nhicks00/ScoreCheck", repoId: 1, ref: "branch", sha: "a".repeat(40) }, secretsDirectory: "/tmp/rehearsal-secrets" });
  assert.equal((await controller.store.load()).program.preflight.status, "healthy");
  lifecycle.phase = "ready";
  await controller.start({ manifest, lifecycleState: lifecycle, material, evidenceDirectory: "/tmp/rehearsal-evidence" });
  let summary = rehearsalSummary(await controller.store.load());
  assert.equal(summary.activePublishers, 8);
  assert.equal(summary.activeEgresses, 8);
  assert.equal(summary.activeProviderStreams, 8);
  assert.ok(log.indexOf("publisher-prepare:8") < log.indexOf("publisher-start:1"));
  assert.ok(log.indexOf("publisher-start:8") < log.indexOf("sampler-start"));
  assert.ok(log.indexOf("sampler-start") < log.indexOf("egress-start:1"));
  assert.ok(log.indexOf("egress-start:1") < log.indexOf("youtube-active:stream1"));
  assert.ok(log.indexOf("youtube-active:stream1") < log.indexOf("program-subscriber:1"));
  assert.ok(log.indexOf("program-subscriber:1") < log.indexOf("commentary-start:1"));
  assert.ok(log.indexOf("commentary-start:1") < log.indexOf("egress-start:2"));
  await controller.soak({ manifest, lifecycleState: lifecycle, evidenceDirectory: "/tmp/rehearsal-evidence", durationMs: 1_800_000 });
  const soaking = await controller.store.load();
  assert.equal(soaking.soak.status, "passed");
  assert.equal(soaking.soak.baselineEvidence.snapshot.baselineId, "accepted-full-baseline");
  assert.equal(log.filter((entry) => entry === "full-baseline").length, 2);
  await controller.stop({ manifest, lifecycleState: lifecycle });
  await controller.cleanup({ manifest, lifecycleState: lifecycle });
  await controller.seal({ manifest, lifecycleState: lifecycle, evidenceDirectory: "/tmp/rehearsal-evidence" });
  summary = rehearsalSummary(await controller.store.load());
  assert.equal(summary.phase, "cleaned");
  assert.equal(summary.evidenceClassification, "PASS");
  assert.ok(log.indexOf("egress-stop:8:EG_8") < log.indexOf("youtube-inactive:stream1"));
  const cleaned = await controller.store.load();
  assert.equal(Object.values(cleaned.courts).every((court) => court.providerCleanup.status === "retained"), true);
  assert.equal(Object.values(cleaned.courts).every((court) => court.providerCleanup.isReusable === true), true);
  assert.ok(log.includes("delete-project:prj_test"));
});

test("restores the persisted browser baseline when a soak resumes in a new process", async () => {
  const { controller, store, log } = harness({ failSoakOnce: true });
  const lifecycle = lifecycleState();
  await controller.plan({ manifest, lifecycleState: lifecycle });
  await controller.prepare({ manifest, lifecycleState: lifecycle, material, git: { repo: "nhicks00/ScoreCheck", repoId: 1, ref: "branch", sha: "a".repeat(40) }, secretsDirectory: "/tmp/rehearsal-secrets" });
  lifecycle.phase = "ready";
  await controller.start({ manifest, lifecycleState: lifecycle, material, evidenceDirectory: "/tmp/rehearsal-evidence" });
  await assert.rejects(() => controller.soak({ manifest, lifecycleState: lifecycle, evidenceDirectory: "/tmp/rehearsal-evidence", durationMs: 1_800_000 }), /intentional soak process interruption/);

  const interrupted = await store.load();
  assert.equal(interrupted.soak.status, "running");
  assert.ok(interrupted.soak.startedAt);
  assert.equal(interrupted.soak.baselineEvidence.snapshot.baselineId, "accepted-full-baseline");

  await controller.soak({ manifest, lifecycleState: lifecycle, evidenceDirectory: "/tmp/rehearsal-evidence", durationMs: 1_800_000 });
  assert.equal(log.filter((entry) => entry === "full-baseline").length, 2);
  assert.equal(log.filter((entry) => entry === "restore-baseline:accepted-full-baseline").length, 1);
});

test("resumes a partial start without replacing prepared provider identities", async () => {
  const { controller, store } = harness({ failPublisherOnce: true });
  const lifecycle = lifecycleState();
  await controller.plan({ manifest, lifecycleState: lifecycle });
  await controller.prepare({ manifest, lifecycleState: lifecycle, material, git: { repo: "nhicks00/ScoreCheck", repoId: 1, ref: "branch", sha: "a".repeat(40) }, secretsDirectory: "/tmp/rehearsal-secrets" });
  const ready = lifecycleState("ready");
  await assert.rejects(() => controller.start({ manifest, lifecycleState: ready, material, evidenceDirectory: "/tmp/rehearsal-evidence" }), /intentional publisher interruption/);
  const partial = await store.load();
  assert.equal(partial.phase, "starting");
  assert.equal(partial.courts[1].stream.id, "stream1");
  await controller.start({ manifest, lifecycleState: ready, material, evidenceDirectory: "/tmp/rehearsal-evidence" });
  assert.equal((await store.load()).phase, "running");
});

test("durably preserves full startup evidence when program-chain stabilization fails", async () => {
  const { controller, store } = harness({ failFullEvidence: true });
  const lifecycle = lifecycleState();
  await controller.plan({ manifest, lifecycleState: lifecycle });
  await controller.prepare({ manifest, lifecycleState: lifecycle, material, git: { repo: "nhicks00/ScoreCheck", repoId: 1, ref: "branch", sha: "a".repeat(40) }, secretsDirectory: "/tmp/rehearsal-secrets" });
  const ready = lifecycleState("ready");
  await assert.rejects(() => controller.start({ manifest, lifecycleState: ready, material, evidenceDirectory: "/tmp/rehearsal-evidence" }), /intentional full-chain/);
  const failed = await store.load();
  assert.equal(failed.phase, "starting");
  assert.equal(failed.startEvidence.passed, false);
  assert.match(failed.startEvidence.problems.join("; "), /Camera 4 browser quality/);
});

test("cleans a preflight failure through direct provider reconciliation without aggregate idle telemetry", async () => {
  const { controller, store } = harness({ failPreflight: true, failIdle: true });
  const lifecycle = lifecycleState();
  await controller.plan({ manifest, lifecycleState: lifecycle });
  await controller.prepare({ manifest, lifecycleState: lifecycle, material, git: { repo: "nhicks00/ScoreCheck", repoId: 1, ref: "branch", sha: "a".repeat(40) }, secretsDirectory: "/tmp/rehearsal-secrets" });
  const live = lifecycleState("live");
  await assert.rejects(() => controller.start({ manifest, lifecycleState: live, material, evidenceDirectory: "/tmp/rehearsal-evidence" }), /intentional preflight failure/);

  await controller.stop({ manifest, lifecycleState: live });

  const stopped = await store.load();
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.stopEvidence.mode, "direct-pre-start-cleanup");
  assert.equal(stopped.stopEvidence.passed, true);
});

test("refuses provider cleanup while workload ownership is still active", async () => {
  const { controller } = harness();
  const lifecycle = lifecycleState();
  await controller.plan({ manifest, lifecycleState: lifecycle });
  await controller.prepare({ manifest, lifecycleState: lifecycle, material, git: { repo: "nhicks00/ScoreCheck", repoId: 1, ref: "branch", sha: "a".repeat(40) }, secretsDirectory: "/tmp/rehearsal-secrets" });
  const ready = lifecycleState("ready");
  await controller.start({ manifest, lifecycleState: ready, material, evidenceDirectory: "/tmp/rehearsal-evidence" });
  await assert.rejects(() => controller.cleanup({ manifest, lifecycleState: ready }), /phase is running|must be stopped/);
});

test("cleans interrupted preparation without deleting the persistent stream pool", async () => {
  const { controller, store, log } = harness({ orphanedProviderResources: true });
  const lifecycle = lifecycleState();
  await controller.plan({ manifest, lifecycleState: lifecycle });
  const interrupted = await store.load();
  interrupted.phase = "preparing";
  await store.save(interrupted);
  await controller.cleanup({ manifest, lifecycleState: lifecycle });
  assert.ok(log.includes("delete-project:prj_orphan"));
  const cleaned = await store.load();
  assert.equal(cleaned.phase, "cleaned");
  assert.equal(Object.values(cleaned.courts).every((court) => court.providerCleanup.status === "not-adopted"), true);
});

test("adopts and stops a lone Egress whose successful start was interrupted before its id was persisted", async () => {
  const { controller, store, log, activeEgress } = harness();
  const lifecycle = lifecycleState();
  await controller.plan({ manifest, lifecycleState: lifecycle });
  await controller.prepare({ manifest, lifecycleState: lifecycle, material, git: { repo: "nhicks00/ScoreCheck", repoId: 1, ref: "branch", sha: "a".repeat(40) }, secretsDirectory: "/tmp/rehearsal-secrets" });
  const ready = lifecycleState("ready");
  const interrupted = await store.load();
  interrupted.phase = "starting";
  interrupted.courts[1].egress = { status: "starting", id: null };
  await store.save(interrupted);
  const host = ready.droplets[manifest.droplets.find((entry) => entry.role === "compositor" && entry.court === 1).name].publicIpv4;
  activeEgress.set(host, { id: "EG_orphaned", status: "active" });

  await controller.stop({ manifest, lifecycleState: ready });

  assert.ok(log.includes("egress-stop:1:EG_orphaned"));
  assert.equal(activeEgress.size, 0);
  assert.equal((await store.load()).courts[1].egress.status, "stopped");
});

function digest(value) { return createHash("sha256").update(stableJson(value)).digest("hex"); }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
