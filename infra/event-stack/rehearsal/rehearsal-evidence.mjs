import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { evaluateHostSamples, evaluateZombieEvidence } from "../../capacity/evaluate-gate.mjs";
import { pairPoolHostSamples, parsePoolHostEventsNdjson, summarizePoolHost } from "../../capacity/pool-host-evidence.mjs";

const DEFAULT_DURATION_MS = 30 * 60_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_PROVIDER_INTERVAL_MS = 60_000;
const MARKER_NAME = "REHEARSAL_COMPLETE.json";

export class RehearsalSoakEvaluator {
  constructor({ verifier, publisherObserver, sleep = delay, now = () => Date.now(), minimumDurationMs = DEFAULT_DURATION_MS, maximumSampleLagMs = 1_000, maximumEarlySampleSkewMs = 10, hostEvidenceSettleMs = 1_250, hostEvidenceEvaluator = evaluateRehearsalPoolEvidence }) {
    if (typeof publisherObserver !== "function") throw new Error("rehearsal soak requires a synthetic publisher observer");
    this.verifier = verifier;
    this.publisherObserver = publisherObserver;
    this.sleep = sleep;
    this.now = now;
    this.minimumDurationMs = minimumDurationMs;
    this.maximumSampleLagMs = maximumSampleLagMs;
    this.maximumEarlySampleSkewMs = maximumEarlySampleSkewMs;
    this.hostEvidenceSettleMs = hostEvidenceSettleMs;
    this.hostEvidenceEvaluator = hostEvidenceEvaluator;
  }

  async run({ state, manifest, lifecycleState, evidenceDirectory, durationMs = DEFAULT_DURATION_MS, sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS, providerIntervalMs = DEFAULT_PROVIDER_INTERVAL_MS }) {
    validateRunInputs({ state, evidenceDirectory, durationMs, sampleIntervalMs, providerIntervalMs, minimumDurationMs: this.minimumDurationMs });
    const root = resolve(evidenceDirectory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const samplesPath = join(root, "rehearsal-monitor-samples.jsonl");
    const reportPath = join(root, "rehearsal-soak-report.json");
    const startedAt = state.soak?.startedAt ?? new Date(this.now()).toISOString();
    const startedMs = Date.parse(startedAt);
    const expectedSamples = Math.floor(durationMs / sampleIntervalMs) + 1;
    const providerEvery = Math.max(1, Math.ceil(providerIntervalMs / sampleIntervalMs));
    const existing = await readSamples(samplesPath, state);
    let nextSlot = existing.length;
    let maximumGapMs = existingMaximumGap(existing);
    let previousObservedMs = existing.length ? Date.parse(existing.at(-1).observedAt) : null;
    let previousMonitor = existing.length ? existing.at(-1).monitor : null;
    const allProblems = [...new Set(existing.flatMap((sample) => sample.problems))];
    const handle = await open(samplesPath, "a", 0o600);
    await chmod(samplesPath, 0o600);
    try {
      while (nextSlot < expectedSamples && allProblems.length === 0) {
        const dueAt = startedMs + nextSlot * sampleIntervalMs;
        const waitMs = dueAt - this.now();
        if (waitMs > 0) await this.sleep(waitMs);
        const sampledAt = this.now();
        const lagMs = sampledAt - dueAt;
        const includeProvider = nextSlot === 0 || nextSlot === expectedSamples - 1 || nextSlot % providerEvery === 0;
        const observation = await this.verifier.observeFull({
          state,
          includeProvider,
          // Slot zero pins the accepted stabilization endpoint as the official
          // sample baseline. Requiring another heartbeat immediately would race
          // the staggered browser heartbeat cadence. Every subsequent and
          // resumed sample still requires reset-safe progress.
          requireBrowserAdvance: nextSlot > 0
        });
        const publishers = await this.publisherObserver(state);
        const problems = [...observation.problems];
        problems.push(...publishers.problems);
        problems.push(...browserContinuityProblems(previousMonitor, observation.snapshot));
        if (lagMs < -this.maximumEarlySampleSkewMs || lagMs > this.maximumSampleLagMs) {
          problems.push(`sample ${nextSlot} lag ${lagMs}ms is outside -${this.maximumEarlySampleSkewMs}ms to ${this.maximumSampleLagMs}ms`);
        }
        if (previousObservedMs !== null) {
          const gap = sampledAt - previousObservedMs;
          maximumGapMs = Math.max(maximumGapMs, gap);
          if (gap > sampleIntervalMs + this.maximumSampleLagMs) problems.push(`sample gap ${gap}ms exceeds ${sampleIntervalMs + this.maximumSampleLagMs}ms`);
        }
        const sample = {
          schemaVersion: 1,
          event: state.event,
          generationId: state.generationId,
          slot: nextSlot,
          dueAt: new Date(dueAt).toISOString(),
          observedAt: new Date(sampledAt).toISOString(),
          lagMs,
          monitor: observation.snapshot,
          publishers,
          sampler: observation.sampler,
          provider: observation.provider,
          problems: [...new Set(problems)]
        };
        await handle.write(`${JSON.stringify(sample)}\n`);
        await handle.sync();
        allProblems.push(...sample.problems.filter((problem) => !allProblems.includes(problem)));
        previousObservedMs = sampledAt;
        previousMonitor = observation.snapshot;
        nextSlot += 1;
      }
    } finally {
      await handle.close();
    }

    const endedMs = this.now();
    if (this.hostEvidenceSettleMs > 0) await this.sleep(this.hostEvidenceSettleMs);
    let hostEvidence = null;
    try {
      hostEvidence = await this.hostEvidenceEvaluator({
        state,
        manifest,
        lifecycleState,
        startMs: startedMs,
        endMs: endedMs,
        stepSeconds: sampleIntervalMs / 1_000
      });
      allProblems.push(...hostEvidence.problems.filter((problem) => !allProblems.includes(problem)));
    } catch (error) {
      allProblems.push(`pool host evidence could not be evaluated: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
    }
    const report = {
      schemaVersion: 1,
      event: state.event,
      generationId: state.generationId,
      startedAt,
      endedAt: new Date(endedMs).toISOString(),
      requestedDurationMs: durationMs,
      observedDurationMs: Math.max(0, endedMs - startedMs),
      sampleIntervalMs,
      providerIntervalMs,
      expectedSamples,
      observedSamples: nextSlot,
      coverageRatio: nextSlot / expectedSamples,
      maximumGapMs,
      hostEvidence,
      samplesPath,
      samplesSha256: await sha256File(samplesPath),
      problems: allProblems,
      passed: allProblems.length === 0 && hostEvidence?.passed === true && nextSlot === expectedSamples && endedMs - startedMs >= durationMs
    };
    await writeAtomicProtected(reportPath, report);
    return { ...report, reportPath, reportSha256: sha256(stableJson(report)) };
  }
}

export async function evaluateRehearsalPoolEvidence({ state, manifest, lifecycleState, startMs, endMs, stepSeconds = 5 }) {
  if (!state?.sampler?.output || !new Set(["rehearsal", "production"]).has(manifest?.kind) || !lifecycleState?.droplets) throw new Error("event pool evidence inputs are incomplete");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || stepSeconds !== 5) throw new Error("rehearsal pool evidence window must use the exact five-second sampler cadence");
  const specs = [
    ...manifest.droplets.filter((entry) => entry.role === "ingest"),
    ...manifest.droplets.filter((entry) => ["compositor", "compositor-spare"].includes(entry.role)).sort((left, right) => left.providerName.localeCompare(right.providerName))
  ];
  if (specs.length !== 10 || specs.filter((entry) => entry.role === "ingest").length !== 1) throw new Error("event pool topology must contain one ingest and nine compositor hosts");
  const raw = await readFile(state.sampler.output, "utf8");
  const finalNewline = raw.lastIndexOf("\n");
  if (finalNewline < 0) throw new Error("pool host evidence has no complete records");
  const events = parsePoolHostEventsNdjson(raw.slice(0, finalNewline + 1));
  const expectedHostIds = specs.map((entry) => entry.providerName).sort();
  const observedHostIds = [...new Set(events.map((event) => event.hostId))].sort();
  const checks = [gateCheck("topology_host_set", arraysEqual(observedHostIds, expectedHostIds), observedHostIds, expectedHostIds)];
  const machineFingerprints = [];
  const providerResourceIds = [];
  const startEpochSeconds = startMs / 1_000;
  const endEpochSeconds = endMs / 1_000;
  const hosts = {};
  for (const spec of specs) {
    const role = spec.role === "ingest" ? "ingest" : "compositor";
    const starts = events.filter((event) => event.hostId === spec.providerName && event.event === "watcher_started");
    const fingerprints = [...new Set(starts.map((event) => event.machineFingerprint).filter((value) => typeof value === "string"))];
    const providerIdentities = [...new Set(starts.map((event) => `${event.provider ?? ""}\u0000${event.providerResourceId ?? ""}\u0000${event.providerHostname ?? ""}`))];
    const resource = lifecycleState.droplets[spec.name];
    checks.push(
      gateCheck(`${spec.providerName}_machine_identity`, fingerprints.length === 1, fingerprints, "one stable fingerprint"),
      gateCheck(`${spec.providerName}_provider_identity`, providerIdentities.length === 1
        && starts.every((event) => event.provider === "digitalocean" && event.providerHostname === spec.providerName && String(event.providerResourceId) === String(resource?.id)), providerIdentities, `digitalocean/${resource?.id ?? "missing"}/${spec.providerName}`),
      gateCheck(`${spec.providerName}_lifecycle_resource`, resource?.status === "active" && resource?.providerName === spec.providerName && resource?.region === spec.region, resource ? { id: resource.id, status: resource.status, providerName: resource.providerName, region: resource.region } : null, { status: "active", providerName: spec.providerName, region: spec.region })
    );
    machineFingerprints.push(...fingerprints);
    if (resource?.id) providerResourceIds.push(String(resource.id));
    hosts[spec.providerName] = summarizePoolHost(events, { hostId: spec.providerName, role, startEpochSeconds, endEpochSeconds, stepSeconds });
  }
  checks.push(
    gateCheck("topology_machine_uniqueness", machineFingerprints.length === 10 && new Set(machineFingerprints).size === 10, machineFingerprints.length, 10),
    gateCheck("topology_provider_resource_uniqueness", providerResourceIds.length === 10 && new Set(providerResourceIds).size === 10, providerResourceIds.length, 10)
  );

  const ingest = specs.find((entry) => entry.role === "ingest");
  const durationMinutes = Math.max(1, Math.ceil((endMs - startMs) / 60_000));
  const evaluatorConfig = {
    stepSeconds,
    compositor: { enabled: true },
    allowedBaselineUnclassified: { ingest: [], compositor: [] },
    thresholds: {
      minimumSampleCoverageRatio: 0.99,
      maximumHostSampleGapSeconds: 7.5,
      maximumHostSampleLagMs: 250,
      maximumCpuP95Ratio: 0.75,
      maximumCpuRatio: 0.8,
      maximumShmRatio: 0.8,
      maximumZombieWatcherHeartbeatGapSeconds: 2,
      maximumZombieWatcherScanGapMs: 250,
      maximumZombiePollIntervalMs: 50,
      maximumObserverZombieDurationMs: 2_000,
      maximumObserverZombieEvents: durationMinutes * 16,
      maximumObserverZombieEventsPerMinute: 16,
      maximumWorkloadZombieDurationMs: 500,
      maximumWorkloadZombieEvents: 64,
      maximumWorkloadZombieEventsPerMinute: 8,
      maximumWorkloadConcurrentZombies: 1
    }
  };
  for (const spec of specs.filter((entry) => entry.role !== "ingest")) {
    const pairChecks = [];
    evaluateHostSamples(pairChecks, evaluatorConfig, pairPoolHostSamples(hosts[ingest.providerName].samples, hosts[spec.providerName].samples));
    evaluateZombieEvidence(pairChecks, evaluatorConfig, { roles: { ingest: hosts[ingest.providerName].zombies, compositor: hosts[spec.providerName].zombies } });
    checks.push(...pairChecks.map((entry) => ({ ...entry, id: `${spec.providerName}_${entry.id}` })));
  }
  const problems = checks.filter((entry) => !entry.pass).map((entry) => `pool host gate ${entry.id} failed`);
  return {
    schemaVersion: 1,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    stepSeconds,
    passed: problems.length === 0,
    problems,
    checks,
    hosts
  };
}

export function browserContinuityProblems(previous, current) {
  if (!previous) return [];
  const problems = [];
  for (let court = 1; court <= 8; court += 1) {
    const before = previous.courts?.find((entry) => entry.courtNumber === court)?.browser;
    const after = current?.courts?.find((entry) => entry.courtNumber === court)?.browser;
    if (!before || !after) continue;
    for (const field of ["credentialId", "pageLoadedAt", "pageBuildVersion", "configurationVersion"]) {
      if (!before[field] || after[field] !== before[field]) problems.push(`Camera ${court} browser ${field} changed during the soak`);
    }
    if (!Number.isInteger(after.heartbeatSeq) || after.heartbeatSeq <= before.heartbeatSeq) problems.push(`Camera ${court} browser heartbeat sequence did not advance`);
    if (Date.parse(after.receivedAt) <= Date.parse(before.receivedAt)) problems.push(`Camera ${court} browser receipt timestamp did not advance`);
    if (!Number.isInteger(after.video?.framesRendered) || after.video.framesRendered <= before.video?.framesRendered) problems.push(`Camera ${court} rendered frames did not advance`);
  }
  return [...new Set(problems)];
}

export async function sealRehearsalEvidence({ state, manifest, evidenceDirectory, now = new Date() }) {
  validateSealInputs(state, manifest);
  const root = resolve(evidenceDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const info = await stat(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("rehearsal evidence directory must be protected");
  const workloadAttempted = state.startedAt != null
    || state.sampler != null
    || state.publisherEvidence != null
    || state.startEvidence != null
    || Object.values(state.courts).some((court) => court.publisher?.marker || court.commentary?.marker || court.egress?.id);
  const outputConformancePassed = Object.values(state.courts).length === 8
    && Object.values(state.courts).every((court) => court.outputConformance?.status === "QUALIFIED");
  const classification = state.soakEvidence?.passed && state.endpointEvidence?.passed && state.stopEvidence?.passed && outputConformancePassed ? "PASS" : workloadAttempted ? "FAIL" : "CANCELLED";
  const artifactNames = ["pool-host-samples.jsonl", "rehearsal-monitor-samples.jsonl", "rehearsal-soak-report.json"];
  const artifacts = {};
  for (const name of artifactNames) {
    const path = join(root, name);
    try {
      const value = await stat(path);
      if (!value.isFile() || (value.mode & 0o077) !== 0) throw new Error(`${name} is not a protected evidence file`);
      artifacts[name] = { bytes: value.size, sha256: await sha256File(path) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const [court, value] of Object.entries(state.courts)) {
    const conformance = value.outputConformance;
    if (!conformance) continue;
    for (const [kind, path] of [["report", conformance.evidencePath], ["sample", conformance.samplePath]]) {
      const absolutePath = resolve(path ?? "");
      const name = relative(root, absolutePath);
      if (!name || name.startsWith("..") || isAbsolute(name)) throw new Error(`Camera ${court} output-conformance ${kind} is outside the evidence directory`);
      const information = await stat(absolutePath);
      if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`Camera ${court} output-conformance ${kind} is not protected`);
      artifacts[name] = { bytes: information.size, sha256: await sha256File(absolutePath) };
    }
  }
  if (workloadAttempted && !artifacts["pool-host-samples.jsonl"]) throw new Error("attempted rehearsal has no pool-host evidence");
  if (state.soakEvidence && (!artifacts["rehearsal-monitor-samples.jsonl"] || !artifacts["rehearsal-soak-report.json"])) throw new Error("rehearsal soak artifacts are incomplete");
  const providerCleanup = {
    youtubeMode: state.providerMode,
    vercelProject: state.program.project,
    courts: Object.fromEntries(Object.entries(state.courts).map(([court, value]) => [court, value.providerCleanup]))
  };
  assertProviderCleanup(providerCleanup, { requireRetained: classification === "PASS" });
  const evidence = {
    schemaVersion: 2,
    event: state.event,
    generationId: state.generationId,
    manifestSha256: state.manifestSha256,
    classification,
    sealedAt: now.toISOString(),
    lifecycle: {
      createdAt: state.createdAt,
      preparedAt: state.preparedAt,
      startedAt: state.startedAt,
      stoppedAt: state.stoppedAt,
      cleanedAt: state.cleanedAt
    },
    providerCleanup,
    startEvidence: state.startEvidence ?? null,
    publisherEvidence: state.publisherEvidence ?? null,
    soakEvidence: state.soakEvidence ?? null,
    endpointEvidence: state.endpointEvidence ?? null,
    stopEvidence: state.stopEvidence ?? null,
    outputConformance: Object.fromEntries(Object.entries(state.courts).map(([court, value]) => [court, value.outputConformance ?? null])),
    artifacts,
    excludedBoundaries: [
      "production Supabase event/scoring/control-plane persistence",
      "venue Speedify uplink",
      "YouTube broadcast/watch-page creation and recording lifecycle (separate tournament control-plane preflight)"
    ]
  };
  const evidencePath = join(root, "rehearsal-evidence.json");
  await writeAtomicProtected(evidencePath, evidence);
  const marker = {
    schemaVersion: 2,
    event: state.event,
    generationId: state.generationId,
    manifestSha256: state.manifestSha256,
    classification,
    sealedAt: evidence.sealedAt,
    evidenceSha256: sha256(stableJson(evidence)),
    providerCleanupComplete: true
  };
  const markerPath = join(root, MARKER_NAME);
  await writeAtomicProtected(markerPath, marker);
  return { directory: root, markerPath, ...marker };
}

export async function verifyRehearsalEvidence({ directory, event, generationId, manifestSha256 }) {
  const root = resolve(directory);
  const [marker, evidence] = await Promise.all([
    readProtectedJson(join(root, MARKER_NAME)),
    readProtectedJson(join(root, "rehearsal-evidence.json"))
  ]);
  for (const [key, expected] of [["event", event], ["generationId", generationId], ["manifestSha256", manifestSha256]]) {
    if (marker[key] !== expected || evidence[key] !== expected) throw new Error(`rehearsal evidence ${key} does not match the lifecycle generation`);
  }
  if (marker.schemaVersion !== 2 || evidence.schemaVersion !== 2 || marker.providerCleanupComplete !== true || marker.evidenceSha256 !== sha256(stableJson(evidence))) throw new Error("rehearsal evidence marker failed integrity verification");
  if (!new Set(["PASS", "FAIL", "CANCELLED"]).has(marker.classification) || marker.classification !== evidence.classification) throw new Error("rehearsal evidence classification is invalid");
  assertProviderCleanup(evidence.providerCleanup, { requireRetained: evidence.classification === "PASS" });
  for (const [name, expected] of Object.entries(evidence.artifacts ?? {})) {
    const path = join(root, name);
    const info = await stat(path);
    if (!info.isFile() || info.size !== expected.bytes || (info.mode & 0o077) !== 0 || await sha256File(path) !== expected.sha256) throw new Error(`rehearsal artifact ${name} failed integrity verification`);
  }
  return { directory: root, marker, evidence };
}

function validateRunInputs({ state, evidenceDirectory, durationMs, sampleIntervalMs, providerIntervalMs, minimumDurationMs }) {
  if (!state?.event || !state?.generationId || !state?.sampler?.output) throw new Error("rehearsal soak state is incomplete");
  requiredAbsolute(evidenceDirectory, "rehearsal evidence directory");
  if (!Number.isInteger(durationMs) || durationMs < minimumDurationMs) throw new Error(`rehearsal soak must run for at least ${minimumDurationMs}ms`);
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 250 || sampleIntervalMs > 30_000) throw new Error("rehearsal sample interval is invalid");
  if (!Number.isInteger(providerIntervalMs) || providerIntervalMs < sampleIntervalMs || providerIntervalMs > 5 * 60_000) throw new Error("rehearsal provider interval is invalid");
}

function validateSealInputs(state, manifest) {
  if (!state || state.phase !== "cleaned" || manifest?.kind !== "rehearsal" || state.event !== manifest.event || state.manifestSha256 !== sha256(stableJson(manifest))) throw new Error("only a cleaned, bound rehearsal can be sealed");
  assertProviderCleanup({
    youtubeMode: state.providerMode,
    vercelProject: state.program.project,
    courts: Object.fromEntries(Object.entries(state.courts).map(([court, value]) => [court, value.providerCleanup]))
  });
}

function assertProviderCleanup(value, { requireRetained = false } = {}) {
  if (!new Set(["deleted", "absent"]).has(value?.vercelProject?.status)) throw new Error("rehearsal Vercel project cleanup is incomplete");
  if (value?.youtubeMode !== "persistent-youtube-stream-ingest-v1") throw new Error("rehearsal YouTube cleanup mode is invalid");
  const courts = value?.courts;
  if (!courts || Object.keys(courts).length !== 8) throw new Error("rehearsal provider cleanup does not contain eight cameras");
  for (let court = 1; court <= 8; court += 1) {
    const entry = courts[court];
    if (entry?.mode !== value.youtubeMode || !new Set(["retained", "not-adopted"]).has(entry?.status)) throw new Error(`Camera ${court} provider cleanup is incomplete`);
    if (requireRetained && entry.status !== "retained") throw new Error(`Camera ${court} persistent YouTube stream was not retained`);
    if (entry.status === "retained"
      && (typeof entry.streamId !== "string"
        || !entry.streamId
        || entry.title !== `ScoreCheck Production Camera ${court} Auto Stream`
        || entry.isReusable !== true
        || (requireRetained && entry.streamStatus !== "inactive"))) {
      throw new Error(`Camera ${court} retained YouTube stream identity is invalid`);
    }
  }
}

async function readSamples(path, state) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return lines.map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch { throw new Error(`rehearsal sample line ${index + 1} is invalid JSON`); }
    if (value.schemaVersion !== 1 || value.event !== state.event || value.generationId !== state.generationId || value.slot !== index || !Array.isArray(value.problems)) throw new Error(`rehearsal sample line ${index + 1} has invalid ownership or ordering`);
    return value;
  });
}

function existingMaximumGap(samples) {
  let maximum = 0;
  for (let index = 1; index < samples.length; index += 1) maximum = Math.max(maximum, Date.parse(samples[index].observedAt) - Date.parse(samples[index - 1].observedAt));
  return maximum;
}

async function readProtectedJson(path) {
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error(`${path} must be a protected file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeAtomicProtected(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function sha256File(path) { return sha256(await readFile(path)); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function requiredAbsolute(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || resolve(value) !== value) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function gateCheck(id, pass, observed, expected) { return { id, pass: Boolean(pass), observed, expected }; }
function arraysEqual(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }

export { DEFAULT_DURATION_MS, DEFAULT_SAMPLE_INTERVAL_MS, MARKER_NAME };
