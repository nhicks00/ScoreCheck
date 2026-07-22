#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { EgressRuntime } from "./rehearsal/egress-runtime.mjs";
import { PoolSamplerRuntime } from "./rehearsal/pool-sampler-runtime.mjs";
import { evaluateRehearsalPoolEvidence } from "./rehearsal/rehearsal-evidence.mjs";
import { PushoverNotifier } from "./providers.mjs";
import { ProductionSourceProbe } from "./production-media-profile.mjs";
import { ProductionYouTubeProvider, readProductionDestinations } from "./production-youtube.mjs";
import { loadProtectedEnv } from "./stack-deployer.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "../..");
const ACTIVE_CAMERAS = Object.freeze([1, 2, 3, 4, 5, 6]);
const INACTIVE_CAMERAS = Object.freeze([7, 8]);
const SAMPLE_INTERVAL_MS = 5_000;
const PROVIDER_INTERVAL_MS = 60_000;
const MAX_SAMPLE_LAG_MS = 1_000;
const MAX_MONITOR_AGE_MS = 15_000;
const BROWSER_IDENTITY_FIELDS = Object.freeze(["pageLoadedAt", "pageBuildVersion"]);
const BROWSER_COUNTER_FIELDS = Object.freeze(["framesDropped", "freezeCount", "totalFreezesDurationMs", "packetsLost", "reconnectCount", "reloadCount"]);
const ROUTER_INTERVAL_MS = 60_000;
const ROUTER_MAX_GAP_MS = 75_000;
const ROUTER_MIN_MEMORY_KB = 65_536;
const ROUTER_COLUMNS = Object.freeze([
  "timestamp", "speedify_state", "srt_route_dev", "rtmp_route_dev", "primary_rule_count", "guard_rule_count", "kill_switch",
  "camera_flow_count", "connectify_rx_bytes", "connectify_tx_bytes", "eth0_rx_bytes", "eth0_tx_bytes", "rmnet_rx_bytes",
  "rmnet_tx_bytes", "wireguard_handshake_age_seconds", "load1", "mem_available_kb", "speedify_rss_kb", "streaming_stats_process_count"
]);
const ROUTER_NUMERIC_COLUMNS = new Set(["primary_rule_count", "guard_rule_count", ...ROUTER_COLUMNS.slice(7)]);
const ROUTER_COUNTER_COLUMNS = Object.freeze(["connectify_rx_bytes", "connectify_tx_bytes", "eth0_rx_bytes", "eth0_tx_bytes", "rmnet_rx_bytes", "rmnet_tx_bytes"]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const runtime = await ProductionSoakRuntime.create(options);
  const result = options.command === "status" ? await runtime.status() : await runtime.run();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export class ProductionSoakRuntime {
  static async create(options, dependencies = {}) {
    const profile = await readProtectedJson(options.profile, "event operator profile");
    const manifest = await readProtectedJson(profile.manifest, "event manifest");
    const lifecycleState = await readProtectedJson(profile.state, "event lifecycle state");
    const destinations = await readProductionDestinations(options.destinations, { event: manifest.event, activeCameras: ACTIVE_CAMERAS });
    validateInputs({ options, profile, manifest, lifecycleState });
    const environment = await loadProtectedEnv(profile.credentialsEnv);
    const monitorEnvironment = await loadProtectedEnv(join(profile.secrets, "observability.env"));
    const monitorEndpoint = manifest.endpoints.find((entry) => entry.role === "observability");
    if (!monitorEndpoint?.hostname) throw new Error("production manifest has no observability endpoint");
    const monitorOrigin = `https://${monitorEndpoint.hostname}`;
    const monitorToken = required(monitorEnvironment.MONITOR_API_TOKEN, "monitor API token");
    const youtube = dependencies.youtube ?? new ProductionYouTubeProvider({
      clientId: required(environment.YOUTUBE_CLIENT_ID, "YouTube client id"),
      clientSecret: required(environment.YOUTUBE_CLIENT_SECRET, "YouTube client secret"),
      refreshToken: required(environment.YOUTUBE_REFRESH_TOKEN, "YouTube refresh token")
    });
    const pushover = dependencies.pushover ?? new PushoverNotifier({
      appToken: required(environment.PUSHOVER_APP_TOKEN ?? monitorEnvironment.PUSHOVER_APP_TOKEN, "Pushover app token"),
      userKey: required(environment.PUSHOVER_USER_KEY ?? monitorEnvironment.PUSHOVER_USER_KEY, "Pushover user key")
    });
    return new ProductionSoakRuntime({
      ...dependencies,
      options, profile, manifest, lifecycleState, destinations, monitorOrigin, monitorToken, youtube, pushover,
      egress: dependencies.egress ?? new EgressRuntime({ sshKey: profile.sshKey, knownHosts: profile.knownHosts }),
      sourceProbe: dependencies.sourceProbe ?? new ProductionSourceProbe({ sshKey: profile.sshKey, knownHosts: profile.knownHosts }),
      sampler: dependencies.sampler ?? new PoolSamplerRuntime({ repoRoot: REPO_ROOT, sshKey: profile.sshKey, knownHosts: profile.knownHosts }),
      router: dependencies.router ?? new RouterSoakRuntime({ host: options.router }),
      fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
      sleep: dependencies.sleep ?? delay,
      now: dependencies.now ?? (() => Date.now())
    });
  }

  constructor(values) { Object.assign(this, values); }

  async status() {
    const state = await readStateOrNull(join(this.options.evidence, "production-soak-state.json"));
    return state ? publicState(state) : { status: "NOT_STARTED", event: this.manifest.event };
  }

  async run() {
    await mkdir(this.options.evidence, { recursive: true, mode: 0o700 });
    await chmod(this.options.evidence, 0o700);
    const statePath = join(this.options.evidence, "production-soak-state.json");
    const samplesPath = join(this.options.evidence, "production-soak-samples.jsonl");
    let state = await readStateOrNull(statePath);
    if (!state) {
      await assertEvidenceEmpty(this.options.evidence);
      const snapshot = await this.#snapshot();
      const problems = [
        ...productionIdleProblems(snapshot, this.now()),
        ...productionProviderIdleProblems(await this.#providerEvidence())
      ];
      if (problems.length) throw new Error(`production soak cannot arm: ${problems.slice(0, 8).join("; ")}`);
      await this.router.preflight();
      state = createState({ event: this.manifest.event, evidence: this.options.evidence, nowMs: this.now(), minimumDurationMs: this.options.minimumDurationMs, maximumDurationMs: this.options.maximumDurationMs });
      await writeState(statePath, state);
      process.stdout.write(`ARMED ${state.armedAt}: waiting for Cameras 1-6; no output has started.\n`);
    } else validateState(state, this.manifest.event, this.options);

    if (state.phase === "ARMED") {
      const raw = await this.#waitForRaw();
      state.rawReadyAt = raw.observedAt;
      state.profiles = await this.#probeProfiles();
      state.phase = "STARTING";
      state.sampler = await this.sampler.ensure({ manifest: this.manifest, lifecycleState: this.lifecycleState, evidenceDirectory: this.options.evidence });
      await writeState(statePath, state);
      state.router = await this.router.start({ event: this.manifest.event, durationSeconds: Math.ceil(this.options.maximumDurationMs / 1_000) + 600 });
      await writeState(statePath, state);
    }

    if (state.phase === "STARTING") {
      for (const camera of ACTIVE_CAMERAS) {
        const host = compositorHost(this.manifest, this.lifecycleState, camera);
        const expectedId = state.egress[camera]?.id ?? null;
        if (!expectedId) await this.egress.preflight(host);
        const active = await this.egress.ensureStarted({ host, court: camera, profile: state.profiles[camera].profile, expectedId });
        state.egress[camera] = { ...active, host, profile: state.profiles[camera].profile };
        await writeState(statePath, state);
        state.admission[camera] = await this.egress.proveSecondStartRejected({ host, court: camera, profile: state.profiles[camera].profile, expectedId: active.id });
        await writeState(statePath, state);
        await this.#waitForCameraOutput(camera);
      }
      const accepted = await this.#waitForStableOutput(state.profiles);
      state.phase = "RUNNING";
      state.startedAt = accepted.observedAt;
      state.baseline = accepted.snapshot;
      await writeState(statePath, state);
      process.stdout.write(`SOAK_STARTED ${state.startedAt}: six native 1080 scoreboard outputs are live and healthy.\n`);
    }

    if (state.phase !== "RUNNING") {
      if (state.phase === "COMPLETE") return publicState(state);
      throw new Error(`production soak state phase ${state.phase} cannot run`);
    }

    const signal = createSignalLatch();
    const handle = await open(samplesPath, "a", 0o600);
    await chmod(samplesPath, 0o600);
    let previous = state.lastSnapshot ?? state.baseline;
    let slot = state.sampleCount;
    let maximumGapMs = state.maximumGapMs;
    let previousObservedMs = state.lastObservedAt ? Date.parse(state.lastObservedAt) : null;
    try {
      while (!signal.stopped) {
        const dueAt = Date.parse(state.startedAt) + slot * SAMPLE_INTERVAL_MS;
        const remaining = dueAt - this.now();
        if (remaining > 0) await this.sleep(remaining);
        if (this.now() - Date.parse(state.startedAt) > this.options.maximumDurationMs) break;
        const observedMs = this.now();
        const snapshot = await this.#snapshot();
        const includeProvider = slot === 0 || slot % Math.ceil(PROVIDER_INTERVAL_MS / SAMPLE_INTERVAL_MS) === 0;
        const provider = includeProvider ? await this.#providerEvidence() : null;
        const problems = productionSnapshotProblems(snapshot, state.profiles, previous, observedMs);
        if (provider) problems.push(...productionProviderProblems(provider));
        const lagMs = observedMs - dueAt;
        if (lagMs < -10 || lagMs > MAX_SAMPLE_LAG_MS) problems.push(`sample ${slot} timing lag is ${lagMs}ms`);
        if (previousObservedMs !== null) {
          const gap = observedMs - previousObservedMs;
          maximumGapMs = Math.max(maximumGapMs, gap);
          if (gap > SAMPLE_INTERVAL_MS + MAX_SAMPLE_LAG_MS) problems.push(`sample gap is ${gap}ms`);
        }
        const sample = {
          schemaVersion: 1,
          event: state.event,
          runId: state.runId,
          slot,
          dueAt: new Date(dueAt).toISOString(),
          observedAt: new Date(observedMs).toISOString(),
          lagMs,
          profiles: state.profiles,
          monitor: snapshot,
          provider,
          problems: unique(problems)
        };
        await handle.write(`${JSON.stringify(sample)}\n`);
        await handle.sync();
        state.sampleCount = slot + 1;
        state.lastObservedAt = sample.observedAt;
        state.lastSnapshot = snapshot;
        state.maximumGapMs = maximumGapMs;
        state.problemCount += sample.problems.length;
        await this.#updateNotification(state, sample.problems);
        await writeState(statePath, state);
        if (sample.problems.length) process.stderr.write(`SOAK_WARNING ${sample.observedAt}: ${sample.problems.slice(0, 4).join("; ")}\n`);
        previous = snapshot;
        previousObservedMs = observedMs;
        slot += 1;
      }
    } finally {
      signal.close();
      await handle.close();
    }

    state.sampler = await this.sampler.stop(state.sampler);
    state.router = await this.router.stopAndFetch(state.router, join(this.options.evidence, "speedify-soak.tsv"));
    const endedMs = this.now();
    const hostEvidence = await evaluateRehearsalPoolEvidence({
      state,
      manifest: this.manifest,
      lifecycleState: this.lifecycleState,
      startMs: Date.parse(state.startedAt),
      endMs: endedMs,
      stepSeconds: 5
    });
    const samples = await readSamples(samplesPath, state.runId);
    const routerEvidence = await readAndEvaluateSpeedifyEvidence({
      path: state.router.localPath,
      startMs: Date.parse(state.startedAt),
      endMs: endedMs,
      activeCameras: ACTIVE_CAMERAS.length
    });
    const report = evaluateProductionSoak({
      state,
      samples,
      hostEvidence,
      routerEvidence,
      endedMs,
      minimumDurationMs: this.options.minimumDurationMs,
      maximumDurationMs: this.options.maximumDurationMs
    });
    await writeProtectedAtomic(join(this.options.evidence, "production-soak-report.json"), report);
    state.phase = "COMPLETE";
    state.endedAt = report.endedAt;
    state.classification = report.classification;
    state.reportSha256 = sha256(stableJson(report));
    await writeState(statePath, state);
    return { ...publicState(state), report };
  }

  async #waitForRaw() {
    const startedAt = this.now();
    let stable = 0;
    let lastProblems = [];
    while (this.now() - startedAt <= 30 * 60_000) {
      const snapshot = await this.#snapshot();
      lastProblems = productionRawProblems(snapshot, this.now());
      if (lastProblems.length === 0) {
        stable += 1;
        if (stable >= 3) return { observedAt: snapshot.generatedAt, snapshot };
      } else stable = 0;
      await this.sleep(2_000);
    }
    throw new Error(`Cameras 1-6 did not reach a stable native 1080 raw baseline: ${lastProblems.slice(0, 8).join("; ")}`);
  }

  async #probeProfiles() {
    const ingest = ingestHost(this.manifest, this.lifecycleState);
    const profiles = {};
    for (const camera of ACTIVE_CAMERAS) profiles[camera] = await this.sourceProbe.probe({ host: ingest, court: camera });
    return profiles;
  }

  async #waitForCameraOutput(camera) {
    const startedAt = this.now();
    let transitioned = false;
    let lastProblems = [];
    while (this.now() - startedAt <= 180_000) {
      const snapshot = await this.#snapshot();
      const court = snapshot.courts.find((entry) => entry.courtNumber === camera);
      const stream = await this.youtube.getStream(this.destinations.streams[camera].id);
      const broadcast = await this.youtube.getBroadcast(this.destinations.broadcasts[camera].id);
      lastProblems = cameraOutputProblems(court, stream, broadcast, this.destinations.streams[camera].id, this.now());
      if (lastProblems.length === 0) return { snapshot, stream, broadcast };
      if (!transitioned && stream.streamStatus === "active" && broadcast.lifeCycleStatus === "ready" && this.now() - startedAt >= 90_000) {
        await this.youtube.transitionBroadcast(broadcast.id, "live");
        transitioned = true;
      }
      await this.sleep(2_000);
    }
    throw new Error(`Camera ${camera} output did not become healthy: ${lastProblems.join("; ")}`);
  }

  async #waitForStableOutput(profiles) {
    let stable = 0;
    let previous = null;
    let lastProblems = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const snapshot = await this.#snapshot();
      const provider = await this.#providerEvidence();
      lastProblems = unique([
        ...productionSnapshotProblems(snapshot, profiles, previous, this.now()),
        ...productionProviderProblems(provider)
      ]);
      if (lastProblems.length === 0) {
        stable += 1;
        if (stable >= 6) return { observedAt: snapshot.generatedAt, snapshot, provider };
      } else stable = 0;
      previous = snapshot;
      await this.sleep(5_000);
    }
    throw new Error(`six-camera output did not stabilize: ${lastProblems.slice(0, 8).join("; ")}`);
  }

  async #snapshot() {
    const response = await this.fetchImpl(`${this.monitorOrigin}/v1/snapshot`, {
      headers: { authorization: `Bearer ${this.monitorToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`production monitor snapshot returned HTTP ${response.status}`);
    const value = await response.json();
    if (!value || value.version !== 4 || !Array.isArray(value.courts) || !Array.isArray(value.agents)) throw new Error("production monitor snapshot contract is invalid");
    return value;
  }

  async #providerEvidence() {
    const cameras = [];
    for (const camera of ACTIVE_CAMERAS) {
      const stream = await this.youtube.getStream(this.destinations.streams[camera].id);
      const broadcast = await this.youtube.getBroadcast(this.destinations.broadcasts[camera].id);
      cameras.push({ camera, stream, broadcast });
    }
    return { observedAt: new Date(this.now()).toISOString(), cameras };
  }

  async #updateNotification(state, problems) {
    if (problems.length > 0) {
      state.consecutiveProblemSamples += 1;
      if (!state.notificationOpen && state.consecutiveProblemSamples >= 2) {
        const message = plainEnglishAlert(problems);
        try {
          await this.pushover.send({ title: message.title, message: message.message, priority: 1 });
          state.notificationOpen = true;
          state.notifications.push({ kind: "OPEN", sentAt: new Date(this.now()).toISOString(), title: message.title });
        } catch (error) {
          state.notifications.push({ kind: "FAILURE", attemptedAt: new Date(this.now()).toISOString(), title: message.title, error: safeError(error) });
          process.stderr.write(`PUSHOVER_WARNING: ${safeError(error)}\n`);
        }
      }
      return;
    }
    state.consecutiveProblemSamples = 0;
    if (state.notificationOpen) {
      try {
        await this.pushover.send({ title: "ScoreCheck streams recovered", message: "All six monitored YouTube feeds are healthy again. No action is needed.", priority: 0 });
        state.notificationOpen = false;
        state.notifications.push({ kind: "RECOVERY", sentAt: new Date(this.now()).toISOString(), title: "ScoreCheck streams recovered" });
      } catch (error) {
        state.notifications.push({ kind: "FAILURE", attemptedAt: new Date(this.now()).toISOString(), title: "ScoreCheck streams recovered", error: safeError(error) });
        process.stderr.write(`PUSHOVER_WARNING: ${safeError(error)}\n`);
      }
    }
  }
}

export function productionIdleProblems(snapshot, nowMs = Date.now()) {
  const problems = commonProblems(snapshot, nowMs);
  for (const camera of [...ACTIVE_CAMERAS, ...INACTIVE_CAMERAS]) {
    const court = courtByNumber(snapshot, camera, problems);
    if (!court) continue;
    if (court.browser) problems.push(`Camera ${camera} has a browser before the soak starts`);
    for (const branch of ["raw", "preview", "program"]) {
      const path = court.paths?.[branch];
      if (path?.ready || (path?.readerCount ?? 0) !== 0) problems.push(`Camera ${camera} ${branch} is occupied before the soak starts`);
    }
  }
  for (const agent of snapshot.agents ?? []) {
    if (["compositor", "worker"].includes(agent.role)) {
      const egress = agent.nativeServices?.egress;
      if (!egress?.idle || egress.activeWebRequests !== 0 || egress.maximumWebRequests !== 1 || !egress.canAcceptRequest) problems.push(`${agent.agentId} is not idle and admission-ready`);
    }
  }
  return unique(problems);
}

export function productionRawProblems(snapshot, nowMs = Date.now()) {
  const problems = commonProblems(snapshot, nowMs);
  for (const camera of ACTIVE_CAMERAS) {
    const court = courtByNumber(snapshot, camera, problems);
    if (!court) continue;
    const raw = court.paths?.raw;
    if (!raw?.ready) problems.push(`Camera ${camera} raw video is not ready`);
    if ((raw?.inboundBitrateBps ?? 0) < 1_000_000) problems.push(`Camera ${camera} raw bitrate is below 1 Mbps`);
    if (raw?.frameErrors !== 0) problems.push(`Camera ${camera} raw frame errors are nonzero`);
    if (!new Set(["H264", "H265"]).has(raw?.videoCodec) || raw?.videoWidth !== 1920 || raw?.videoHeight !== 1080) problems.push(`Camera ${camera} raw video is not H.264/H.265 1920x1080`);
    if (raw?.audioCodec !== "AAC" || raw?.audioSampleRateHz !== 48_000 || raw?.audioChannelCount !== 2) problems.push(`Camera ${camera} raw audio is not AAC 48kHz stereo`);
  }
  for (const camera of INACTIVE_CAMERAS) inactiveCameraProblems(snapshot, camera, problems);
  return unique(problems);
}

export function productionSnapshotProblems(snapshot, profiles, previous = null, nowMs = Date.now()) {
  const problems = productionRawProblems(snapshot, nowMs);
  const assignments = new Map();
  for (const agent of snapshot.agents ?? []) if (agent.role === "compositor") for (const camera of agent.assignedCourts ?? []) assignments.set(camera, agent);
  for (const camera of ACTIVE_CAMERAS) {
    const profile = profiles?.[camera];
    if (!profile || !new Set(["1080p30", "1080p60"]).has(profile.profile)) {
      problems.push(`Camera ${camera} has no admitted 1080 output profile`);
      continue;
    }
    const expectedFps = profile.framesPerSecond;
    const court = courtByNumber(snapshot, camera, problems);
    if (!court) continue;
    const readerBounds = { raw: [1, 3], preview: [1, 2], program: [1, 1] };
    for (const branch of ["raw", "preview", "program"]) {
      const path = court.paths?.[branch];
      const [minimum, maximum] = readerBounds[branch];
      if (!path?.ready || path.frameErrors !== 0 || (path.inboundBitrateBps ?? 0) <= 0 || path.readerCount < minimum || path.readerCount > maximum) {
        problems.push(`Camera ${camera} ${branch} path is not healthy with ${minimum === maximum ? minimum : `${minimum}-${maximum}`} reader(s)`);
      }
    }
    for (const branch of ["preview", "program"]) {
      const ffmpeg = court.ffmpeg?.[branch];
      if (!ffmpeg || !Number.isFinite(ffmpeg.framesPerSecond) || Math.abs(ffmpeg.framesPerSecond - expectedFps) > 2
        || ffmpeg.droppedFrames !== 0 || ffmpeg.duplicatedFrames !== 0
        || (ffmpeg.speedRatio !== null && ffmpeg.speedRatio !== undefined && (ffmpeg.speedRatio < 0.95 || ffmpeg.speedRatio > 1.05))) {
        problems.push(`Camera ${camera} ${branch} processing is outside ${expectedFps}fps, zero-drop bounds`);
      }
    }
    const browser = court.browser;
    const age = browser ? nowMs - Date.parse(browser.receivedAt) : Infinity;
    if (!browser || !freshAge(age) || browser.video?.state !== "playing" || browser.video?.connectionState !== "connected" || browser.video?.transport !== "whep") {
      problems.push(`Camera ${camera} program browser is not fresh and playing`);
    } else {
      if (browser.video.width !== 1920 || browser.video.height !== 1080) problems.push(`Camera ${camera} program browser is not rendering 1920x1080`);
      if (!browser.scoreRender?.loaded || !browser.scoreRender.connected || browser.scoreRender.stale || browser.scoreRender.frozen || browser.scoreRender.domMismatchReason) problems.push(`Camera ${camera} scoreboard overlay is not loaded, connected, and current`);
      if (!browser.commentary?.cameraTrackPresent) problems.push(`Camera ${camera} program browser has no camera audio track`);
      if (BROWSER_COUNTER_FIELDS.some((field) => !Number.isFinite(browser.video[field]) || browser.video[field] < 0)) problems.push(`Camera ${camera} browser quality counters are invalid`);
    }
    const agent = assignments.get(camera);
    const egress = agent?.nativeServices?.egress;
    if (!agent || agent.state !== "HEALTHY" || !egress || egress.idle || egress.activeWebRequests !== 1 || egress.maximumWebRequests !== 1 || egress.canAcceptRequest
      || (egress.cpuLoadRatio ?? 1) >= 0.85 || (egress.memoryLoadRatio ?? 1) >= 0.85) problems.push(`Camera ${camera} output server is not running exactly one healthy Egress with headroom`);
  }
  for (const camera of INACTIVE_CAMERAS) {
    const agent = assignments.get(camera);
    const egress = agent?.nativeServices?.egress;
    if (!agent || agent.state !== "HEALTHY" || !egress?.idle || egress.activeWebRequests !== 0 || !egress.canAcceptRequest) problems.push(`Camera ${camera} output server is not healthy and idle`);
  }
  const spare = (snapshot.agents ?? []).find((agent) => agent.role === "worker");
  if (!spare || spare.state !== "HEALTHY" || !spare.nativeServices?.egress?.idle || spare.nativeServices.egress.activeWebRequests !== 0 || !spare.nativeServices.egress.canAcceptRequest) problems.push("warm spare is not healthy and idle");
  if (previous) problems.push(...browserDeltaProblems(previous, snapshot, profiles));
  return unique(problems);
}

export function browserDeltaProblems(previous, current, profiles) {
  const problems = [];
  for (const camera of ACTIVE_CAMERAS) {
    const before = previous?.courts?.find((entry) => entry.courtNumber === camera)?.browser;
    const after = current?.courts?.find((entry) => entry.courtNumber === camera)?.browser;
    if (!before || !after) { problems.push(`Camera ${camera} browser continuity sample is missing`); continue; }
    for (const field of BROWSER_IDENTITY_FIELDS) if (!before[field] || after[field] !== before[field]) problems.push(`Camera ${camera} browser ${field} changed`);
    if (!Number.isInteger(after.heartbeatSeq) || after.heartbeatSeq <= before.heartbeatSeq) problems.push(`Camera ${camera} browser heartbeat did not advance`);
    if (Date.parse(after.receivedAt) <= Date.parse(before.receivedAt)) problems.push(`Camera ${camera} browser receipt did not advance`);
    if (!Number.isInteger(after.video?.framesRendered) || after.video.framesRendered <= before.video?.framesRendered) problems.push(`Camera ${camera} rendered frames did not advance`);
    for (const field of BROWSER_COUNTER_FIELDS) {
      const left = before.video?.[field];
      const right = after.video?.[field];
      if (!Number.isFinite(left) || !Number.isFinite(right) || right !== left) problems.push(`Camera ${camera} browser ${field} changed`);
    }
    const elapsedMs = Date.parse(after.receivedAt) - Date.parse(before.receivedAt);
    const rendered = after.video?.framesRendered - before.video?.framesRendered;
    if (elapsedMs > 0 && rendered > 0) {
      const fps = rendered * 1_000 / elapsedMs;
      const expected = profiles[camera].framesPerSecond;
      if (fps < expected * 0.8 || fps > expected * 1.2) problems.push(`Camera ${camera} rendered cadence is ${fps.toFixed(2)}fps instead of approximately ${expected}fps`);
    }
  }
  return unique(problems);
}

export function productionProviderProblems(provider) {
  const problems = [];
  if (!provider || !Array.isArray(provider.cameras) || provider.cameras.length !== ACTIVE_CAMERAS.length) return ["YouTube evidence is incomplete"];
  for (const value of provider.cameras) {
    const { camera, stream, broadcast } = value;
    if (!stream || stream.court !== camera || stream.resolution !== "variable" || stream.frameRate !== "variable" || stream.streamStatus !== "active" || stream.healthStatus !== "good" || stream.configurationIssues.length !== 0) problems.push(`Camera ${camera} YouTube ingest is not active and healthy`);
    if (!broadcast || broadcast.court !== camera || broadcast.privacyStatus !== "unlisted" || broadcast.lifeCycleStatus !== "live" || broadcast.recordingStatus !== "recording" || broadcast.streamId !== stream.id) problems.push(`Camera ${camera} YouTube broadcast is not live, recording, unlisted, and correctly bound`);
  }
  return unique(problems);
}

export function productionProviderIdleProblems(provider) {
  const problems = [];
  if (!provider || !Array.isArray(provider.cameras) || provider.cameras.length !== ACTIVE_CAMERAS.length) return ["YouTube idle evidence is incomplete"];
  for (const value of provider.cameras) {
    const { camera, stream, broadcast } = value;
    if (!stream || stream.court !== camera || stream.resolution !== "variable" || stream.frameRate !== "variable" || !new Set(["inactive", "ready"]).has(stream.streamStatus)) problems.push(`Camera ${camera} YouTube ingest is not idle`);
    if (!broadcast || broadcast.court !== camera || broadcast.privacyStatus !== "unlisted" || broadcast.lifeCycleStatus !== "ready" || broadcast.recordingStatus !== "notRecording" || broadcast.streamId !== stream?.id) problems.push(`Camera ${camera} YouTube broadcast is not ready, unlisted, and correctly bound`);
  }
  return unique(problems);
}

export function evaluateProductionSoak({ state, samples, hostEvidence, routerEvidence, endedMs, minimumDurationMs, maximumDurationMs }) {
  const startedMs = Date.parse(state.startedAt);
  const observedDurationMs = Math.max(0, endedMs - startedMs);
  const expectedElapsedSamples = Math.floor(observedDurationMs / SAMPLE_INTERVAL_MS) + 1;
  const problems = unique([
    ...samples.flatMap((sample) => sample.problems),
    ...(hostEvidence?.problems ?? []),
    ...(routerEvidence?.problems ?? ["bonded-router evidence is missing"]),
    ...(state.notifications.some((notification) => notification.kind === "FAILURE") ? ["one or more Pushover notifications failed"] : []),
    ...(state.maximumGapMs > SAMPLE_INTERVAL_MS + MAX_SAMPLE_LAG_MS ? [`maximum sample gap was ${state.maximumGapMs}ms`] : []),
    ...(samples.length / Math.max(1, expectedElapsedSamples) < 0.99 ? ["monitor sample coverage was below 99%"] : []),
    ...aggregateCadenceProblems(samples, state.profiles)
  ]);
  const durationQualified = observedDurationMs >= minimumDurationMs;
  const classification = problems.length ? "FAIL" : durationQualified ? "PASS" : "INCOMPLETE";
  return {
    schemaVersion: 1,
    event: state.event,
    runId: state.runId,
    startedAt: state.startedAt,
    endedAt: new Date(endedMs).toISOString(),
    observedDurationMs,
    minimumDurationMs,
    maximumDurationMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    providerIntervalMs: PROVIDER_INTERVAL_MS,
    observedSamples: samples.length,
    expectedElapsedSamples,
    coverageRatio: samples.length / Math.max(1, expectedElapsedSamples),
    maximumGapMs: state.maximumGapMs,
    profiles: state.profiles,
    egress: state.egress,
    notifications: state.notifications,
    hostEvidence,
    routerEvidence,
    problems,
    classification,
    passed: classification === "PASS"
  };
}

async function readAndEvaluateSpeedifyEvidence({ path, startMs, endMs, activeCameras }) {
  const content = await readFile(path, "utf8");
  return evaluateSpeedifyEvidence({ content, startMs, endMs, activeCameras });
}

export function evaluateSpeedifyEvidence({ content, startMs, endMs, activeCameras, intervalMs = ROUTER_INTERVAL_MS }) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("bonded-router evidence window is invalid");
  if (!Number.isInteger(activeCameras) || activeCameras < 1 || activeCameras > 8) throw new Error("bonded-router active camera count is invalid");
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error("bonded-router interval is invalid");
  const lines = String(content ?? "").split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  const problems = [];
  const expectedHeader = ROUTER_COLUMNS.join("\t");
  if (lines.shift() !== expectedHeader) problems.push("bonded-router evidence header is invalid");
  const rows = [];
  for (const [index, line] of lines.entries()) {
    const values = line.split("\t");
    if (values.length !== ROUTER_COLUMNS.length) {
      problems.push(`bonded-router row ${index + 1} has the wrong field count`);
      continue;
    }
    const row = Object.fromEntries(ROUTER_COLUMNS.map((column, offset) => [column, values[offset]]));
    row.timestampMs = Date.parse(row.timestamp);
    if (!Number.isFinite(row.timestampMs)) {
      problems.push(`bonded-router row ${index + 1} has an invalid timestamp`);
      continue;
    }
    let valid = true;
    for (const column of ROUTER_NUMERIC_COLUMNS) {
      const numeric = Number(row[column]);
      if (!Number.isFinite(numeric) || (column !== "load1" && !Number.isInteger(numeric))) {
        problems.push(`bonded-router row ${index + 1} has an invalid ${column}`);
        valid = false;
        break;
      }
      row[column] = numeric;
    }
    if (valid) rows.push(row);
  }
  const observed = rows.filter((row) => row.timestampMs >= startMs && row.timestampMs <= endMs);
  const expectedRows = Math.floor((endMs - startMs) / intervalMs) + 1;
  const coverageRatio = observed.length / Math.max(1, expectedRows);
  if (observed.length === 0) problems.push("bonded-router evidence has no rows in the soak window");
  if (coverageRatio < 0.99) problems.push(`bonded-router sample coverage was ${(coverageRatio * 100).toFixed(3)}%`);

  let maximumGapMs = 0;
  for (let index = 1; index < observed.length; index += 1) {
    const gap = observed[index].timestampMs - observed[index - 1].timestampMs;
    maximumGapMs = Math.max(maximumGapMs, gap);
    if (gap <= 0) problems.push("bonded-router timestamps are not strictly increasing");
  }
  if (maximumGapMs > Math.max(ROUTER_MAX_GAP_MS, intervalMs + 15_000)) problems.push(`bonded-router maximum sample gap was ${maximumGapMs}ms`);
  const startEdgeMs = observed.length ? observed[0].timestampMs - startMs : null;
  const endEdgeMs = observed.length ? endMs - observed.at(-1).timestampMs : null;
  const maximumEdgeMs = Math.max(ROUTER_MAX_GAP_MS, intervalMs + 15_000);
  if (startEdgeMs !== null && startEdgeMs > maximumEdgeMs) problems.push(`bonded-router start edge gap was ${startEdgeMs}ms`);
  if (endEdgeMs !== null && endEdgeMs > maximumEdgeMs) problems.push(`bonded-router end edge gap was ${endEdgeMs}ms`);

  if (observed.some((row) => row.speedify_state !== "CONNECTED")) problems.push("Speedify was not continuously connected");
  if (observed.some((row) => row.srt_route_dev !== "connectify0" || row.rtmp_route_dev !== "connectify0")) problems.push("camera ingest routes did not remain on Speedify");
  if (observed.some((row) => row.primary_rule_count !== 2 || row.guard_rule_count !== 2)) problems.push("camera routing rule counts changed");
  if (observed.some((row) => row.kill_switch !== "active")) problems.push("camera fail-closed kill switch was not continuously active");
  if (observed.some((row) => row.camera_flow_count < activeCameras)) problems.push(`fewer than ${activeCameras} camera flows reached the ingest endpoint`);
  if (observed.some((row) => row.streaming_stats_process_count !== 0)) problems.push("an unbounded Speedify stats process was detected");
  if (observed.some((row) => row.mem_available_kb < ROUTER_MIN_MEMORY_KB)) problems.push("venue router memory headroom fell below 64 MiB");
  if (observed.some((row) => row.speedify_rss_kb <= 0)) problems.push("Speedify memory telemetry was unavailable");
  for (const column of ROUTER_COUNTER_COLUMNS) {
    if (observed.some((row, index) => index > 0 && row[column] < observed[index - 1][column])) problems.push(`venue router ${column} reset during the soak`);
  }

  const txRates = [];
  for (let index = 1; index < observed.length; index += 1) {
    const elapsedSeconds = (observed[index].timestampMs - observed[index - 1].timestampMs) / 1_000;
    const byteDelta = observed[index].connectify_tx_bytes - observed[index - 1].connectify_tx_bytes;
    if (elapsedSeconds > 0 && byteDelta >= 0) txRates.push(byteDelta * 8 / elapsedSeconds);
  }
  const connectifyTxBytesDelta = observed.length > 1 ? observed.at(-1).connectify_tx_bytes - observed[0].connectify_tx_bytes : 0;
  if (observed.length > 1 && connectifyTxBytesDelta <= 0) problems.push("Speedify camera upload bytes did not increase");
  const sortedRates = [...txRates].sort((left, right) => left - right);
  const routerProblems = unique(problems);
  return {
    schemaVersion: 1,
    sha256: sha256(String(content ?? "")),
    intervalMs,
    expectedRows,
    observedRows: observed.length,
    coverageRatio,
    firstObservedAt: observed[0]?.timestamp ?? null,
    lastObservedAt: observed.at(-1)?.timestamp ?? null,
    startEdgeMs,
    endEdgeMs,
    maximumGapMs,
    minimumCameraFlowCount: observed.length ? Math.min(...observed.map((row) => row.camera_flow_count)) : null,
    minimumMemoryAvailableKb: observed.length ? Math.min(...observed.map((row) => row.mem_available_kb)) : null,
    maximumLoad1: observed.length ? Math.max(...observed.map((row) => row.load1)) : null,
    maximumSpeedifyRssKb: observed.length ? Math.max(...observed.map((row) => row.speedify_rss_kb)) : null,
    maximumWireguardHandshakeAgeSeconds: observed.length ? Math.max(...observed.map((row) => row.wireguard_handshake_age_seconds)) : null,
    connectifyTxBytesDelta,
    connectifyTxBitrateBps: txRates.length ? {
      minimum: sortedRates[0],
      p95: sortedRates[Math.min(sortedRates.length - 1, Math.ceil(sortedRates.length * 0.95) - 1)],
      maximum: sortedRates.at(-1),
      average: txRates.reduce((sum, value) => sum + value, 0) / txRates.length
    } : null,
    problems: routerProblems,
    passed: routerProblems.length === 0
  };
}

function aggregateCadenceProblems(samples, profiles) {
  if (samples.length < 2) return ["production soak has fewer than two monitor samples"];
  const problems = [];
  const first = samples[0].monitor;
  const last = samples.at(-1).monitor;
  for (const camera of ACTIVE_CAMERAS) {
    const before = first.courts.find((entry) => entry.courtNumber === camera)?.browser;
    const after = last.courts.find((entry) => entry.courtNumber === camera)?.browser;
    if (!before || !after || before.pageLoadedAt !== after.pageLoadedAt || before.pageBuildVersion !== after.pageBuildVersion) {
      problems.push(`Camera ${camera} browser identity did not remain continuous end to end`);
      continue;
    }
    const elapsedMs = Date.parse(after.receivedAt) - Date.parse(before.receivedAt);
    const rendered = after.video.framesRendered - before.video.framesRendered;
    const fps = elapsedMs > 0 ? rendered * 1_000 / elapsedMs : NaN;
    const expected = profiles[camera].framesPerSecond;
    const tolerance = expected === 60 ? 1 : 0.5;
    if (!Number.isFinite(fps) || Math.abs(fps - expected) > tolerance) problems.push(`Camera ${camera} end-to-end rendered cadence was ${Number.isFinite(fps) ? fps.toFixed(3) : "unavailable"}fps, expected ${expected}fps`);
  }
  return problems;
}

function commonProblems(snapshot, nowMs) {
  const problems = [];
  if (!freshAge(nowMs - Date.parse(snapshot?.generatedAt))) problems.push("monitor snapshot is stale");
  if (snapshot?.collector?.agentsExpected !== 12 || snapshot?.collector?.agentsFresh !== 12) problems.push("monitor does not have all 12 event agents fresh");
  if (!Array.isArray(snapshot?.agents) || snapshot.agents.length !== 12 || snapshot.agents.some((agent) => agent.state !== "HEALTHY")) problems.push("one or more event agents are unhealthy");
  for (const agent of snapshot?.agents ?? []) {
    const host = agent.host;
    if (!host || host.memoryTotalBytes <= 0 || host.memoryAvailableBytes / host.memoryTotalBytes < 0.15) problems.push(`${agent.agentId} has insufficient memory headroom`);
    if (host?.diskTotalBytes !== null && host?.diskFreeBytes !== null && (host.diskTotalBytes <= 0 || host.diskFreeBytes / host.diskTotalBytes < 0.1)) problems.push(`${agent.agentId} has insufficient disk headroom`);
    if ((agent.services ?? []).some((service) => !service.running || service.healthy === false || service.restartCount !== 0 || service.oomKilled)) problems.push(`${agent.agentId} has an unhealthy, restarted, or OOM-killed service`);
  }
  if ((snapshot?.incidents ?? []).length !== 0) problems.push("monitor has an active incident");
  if ((snapshot?.faultGates ?? []).length !== 0) problems.push("monitor has an armed fault gate");
  if (!snapshot?.notifications?.pushover?.configured) problems.push("Pushover monitoring is not configured");
  if (!Array.isArray(snapshot?.courts) || snapshot.courts.length !== 8) problems.push("monitor snapshot does not contain exactly eight cameras");
  return problems;
}

function inactiveCameraProblems(snapshot, camera, problems) {
  const court = courtByNumber(snapshot, camera, problems);
  if (!court) return;
  if (court.browser) problems.push(`Camera ${camera} unexpectedly has a program browser`);
  for (const branch of ["raw", "preview", "program"]) {
    const path = court.paths?.[branch];
    if (path?.ready || (path?.readerCount ?? 0) !== 0) problems.push(`Camera ${camera} ${branch} is unexpectedly active`);
  }
}

function cameraOutputProblems(court, stream, broadcast, expectedStreamId, nowMs) {
  const problems = [];
  if (!court?.paths?.program?.ready || court.paths.program.readerCount !== 1 || court.paths.program.frameErrors !== 0) problems.push("program path is not ready with one reader");
  const browser = court?.browser;
  if (!browser || !freshAge(nowMs - Date.parse(browser.receivedAt)) || browser.video?.state !== "playing" || browser.video?.connectionState !== "connected") problems.push("program browser is not playing");
  if (stream.streamStatus !== "active" || stream.healthStatus !== "good" || stream.configurationIssues.length !== 0) problems.push("YouTube ingest is not healthy");
  if (broadcast.streamId !== expectedStreamId || broadcast.lifeCycleStatus !== "live" || broadcast.recordingStatus !== "recording" || broadcast.privacyStatus !== "unlisted") problems.push("YouTube broadcast is not live and correctly bound");
  return problems;
}

function plainEnglishAlert(problems) {
  const joined = problems.join(" ");
  const cameras = unique([...joined.matchAll(/Camera ([1-8])/g)].map((match) => Number(match[1])));
  const cameraLabel = cameras.length === 1 ? `Camera ${cameras[0]}` : cameras.length > 1 ? `Cameras ${cameras.join(", ")}` : "ScoreCheck";
  if (/raw video is not ready|raw bitrate|raw frame errors|raw video is not/.test(joined)) return { title: `${cameraLabel} stopped sending`, message: `${cameraLabel} is not sending a healthy feed. Check camera power and its bonded network connection, then restart that camera's stream.` };
  if (/scoreboard overlay/.test(joined)) return { title: `${cameraLabel} scoreboard issue`, message: `${cameraLabel}'s scoreboard is not updating. Keep the camera streaming and check the ScoreCheck scoring connection.` };
  if (/YouTube|output server|program browser|program path/.test(joined)) return { title: `${cameraLabel} YouTube feed issue`, message: `${cameraLabel}'s YouTube feed may be interrupted. Keep the camera streaming and open the monitor dashboard to check the output server.` };
  return { title: "ScoreCheck needs attention", message: "One or more live streams are unhealthy. Open the monitor dashboard now; keep the cameras streaming while you identify the affected feed." };
}

class RouterSoakRuntime {
  constructor({ host, runner = runCommand }) { this.host = validateRouterHost(host); this.runner = runner; }

  async preflight() {
    const result = await this.#ssh("test -x /usr/sbin/scorecheck-speedify-soak-recorder && /usr/sbin/scorecheck-speedify-routing status");
    const problems = productionRouterPreflightProblems(result.stdout);
    if (problems.length) throw new Error(`venue router is not ready: ${problems.join("; ")}`);
    return { healthy: true };
  }

  async start({ event, durationSeconds }) {
    const logPath = `/root/scorecheck-production-soak-${event}.tsv`;
    const command = [
      "set -eu",
      `LOG=${logPath}`,
      "PID=/var/run/scorecheck-speedify-soak.pid",
      "if test -s \"$PID\" && kill -0 \"$(cat \"$PID\")\" 2>/dev/null; then cat \"$PID\"; exit 0; fi",
      "test ! -e \"$LOG\"",
      `export SCORECHECK_SOAK_DURATION_SECONDS=${durationSeconds}`,
      "export SCORECHECK_SOAK_INTERVAL_SECONDS=60",
      "export SCORECHECK_SOAK_LOG_FILE=\"$LOG\"",
      "start-stop-daemon -S -b -x /usr/sbin/scorecheck-speedify-soak-recorder",
      "sleep 1",
      "test -s \"$PID\"",
      "cat \"$PID\""
    ].join("; ");
    const result = await this.#ssh(command);
    const pid = Number(result.stdout.trim());
    if (!Number.isInteger(pid) || pid < 2) throw new Error("router soak recorder did not return a valid process id");
    return { status: "running", pid, logPath, startedAt: new Date().toISOString() };
  }

  async stopAndFetch(state, localPath) {
    if (!state?.pid || !state.logPath) throw new Error("router soak recorder state is invalid");
    await this.#ssh(`PID=${state.pid}; if kill -0 \"$PID\" 2>/dev/null; then kill -TERM \"$PID\"; fi; for n in 1 2 3 4 5 6 7 8 9 10; do kill -0 \"$PID\" 2>/dev/null || break; sleep 1; done; test ! -e /proc/\"$PID\"; test -s ${state.logPath}`);
    await this.runner("scp", ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `${this.host}:${state.logPath}`, localPath]);
    await chmod(localPath, 0o600);
    return { ...state, status: "stopped", stoppedAt: new Date().toISOString(), localPath };
  }

  #ssh(command) { return this.runner("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", this.host, command]); }
}

export function productionRouterPreflightProblems(raw) {
  const value = String(raw ?? "").replaceAll("\r", "");
  const problems = [];
  const ingestIp = /^Ingest IP: ((?:\d{1,3}\.){3}\d{1,3})$/m.exec(value)?.[1] ?? null;
  const primaryRules = value.split("\n").filter((line) => /\blookup 900$/.test(line));
  const guardRules = value.split("\n").filter((line) => /\blookup 901$/.test(line));
  const validatedUpload = Number(/^validated_upload_mbps=(\d+)$/m.exec(value)?.[1]);
  const minimumUpload = Number(/^minimum_upload_mbps=(\d+)$/m.exec(value)?.[1]);

  if (!/^Enabled: yes$/m.test(value)) problems.push("ScoreCheck camera routing is not enabled");
  if (!/^Speedify state: CONNECTED$/m.test(value)) problems.push("Speedify is not connected");
  if (!/^Runtime status: CONNECTED_ROUTED$/m.test(value)) problems.push("camera traffic is not routed through Speedify");
  if (!ingestIp) problems.push("the ingest endpoint is unavailable");
  if (primaryRules.length !== 2 || !primaryRules.some((line) => /ipproto udp dport 8890 lookup 900$/.test(line)) || !primaryRules.some((line) => /ipproto tcp dport 1935 lookup 900$/.test(line)) || primaryRules.some((line) => ingestIp && !line.includes(`to ${ingestIp} `))) problems.push("the two primary camera routing rules are not exact");
  if (guardRules.length !== 2 || !guardRules.some((line) => /ipproto udp dport 8890 lookup 901$/.test(line)) || !guardRules.some((line) => /ipproto tcp dport 1935 lookup 901$/.test(line)) || guardRules.some((line) => ingestIp && !line.includes(`to ${ingestIp} `))) problems.push("the two fail-closed guard rules are not exact");
  if (!/^Primary route table 900:\ndefault dev connectify0\b/m.test(value)) problems.push("the primary camera route is not on Speedify");
  if (!/^Guard route table 901:\nblackhole default\b/m.test(value)) problems.push("the fail-closed guard route is missing");
  if (!/^Firewall kill switch: active$/m.test(value)) problems.push("the camera kill switch is not active");
  if (!Number.isFinite(validatedUpload) || !Number.isFinite(minimumUpload) || validatedUpload < minimumUpload) problems.push("the validated bonded upload is below its required minimum");
  if (!ingestIp || !new RegExp(`^ingest_ip=${ingestIp.replaceAll(".", "\\.")}$`, "m").test(value)) problems.push("the validated ingest endpoint does not match routing");
  if (!/^Watchdog lock owner: [1-9]\d*$/m.test(value)) problems.push("the fail-closed routing watchdog is not active");
  return unique(problems);
}

function createState({ event, evidence, nowMs, minimumDurationMs, maximumDurationMs }) {
  return {
    schemaVersion: 1,
    event,
    runId: randomUUID(),
    phase: "ARMED",
    evidence,
    activeCameras: [...ACTIVE_CAMERAS],
    inactiveCameras: [...INACTIVE_CAMERAS],
    minimumDurationMs,
    maximumDurationMs,
    armedAt: new Date(nowMs).toISOString(),
    rawReadyAt: null,
    startedAt: null,
    endedAt: null,
    profiles: {},
    egress: {},
    admission: {},
    sampler: null,
    router: null,
    baseline: null,
    lastSnapshot: null,
    lastObservedAt: null,
    sampleCount: 0,
    problemCount: 0,
    maximumGapMs: 0,
    consecutiveProblemSamples: 0,
    notificationOpen: false,
    notifications: [],
    classification: null,
    reportSha256: null
  };
}

function validateInputs({ options, profile, manifest, lifecycleState }) {
  if (!profile || profile.schemaVersion !== 5) throw new Error("event operator profile contract is invalid");
  if (manifest?.kind !== "production" || !Array.isArray(manifest.droplets) || manifest.droplets.length !== 12) throw new Error("production soak requires the exact 12-host production manifest");
  if (lifecycleState?.event !== manifest.event || !new Set(["ready", "live"]).has(lifecycleState.phase)) throw new Error("production soak requires a matching ready or live lifecycle state");
  if (options.command === "run" && lifecycleState.phase !== "live") throw new Error("production soak run requires lifecycle phase live");
}

function validateState(state, event, options) {
  if (!state || state.schemaVersion !== 1 || state.event !== event || state.evidence !== options.evidence || state.minimumDurationMs !== options.minimumDurationMs || state.maximumDurationMs !== options.maximumDurationMs) throw new Error("production soak state does not match this run");
}

function ingestHost(manifest, lifecycleState) {
  const spec = manifest.droplets.find((entry) => entry.role === "ingest");
  const host = spec ? lifecycleState.droplets?.[spec.name]?.publicIpv4 : null;
  if (!host) throw new Error("production lifecycle has no ingest IPv4");
  return host;
}

function compositorHost(manifest, lifecycleState, camera) {
  const spec = manifest.droplets.find((entry) => entry.role === "compositor" && entry.court === camera);
  const host = spec ? lifecycleState.droplets?.[spec.name]?.publicIpv4 : null;
  if (!host) throw new Error(`production lifecycle has no Camera ${camera} compositor IPv4`);
  return host;
}

function courtByNumber(snapshot, camera, problems) {
  const values = (snapshot.courts ?? []).filter((entry) => entry.courtNumber === camera);
  if (values.length !== 1) { problems.push(`monitor does not contain exactly one Camera ${camera}`); return null; }
  return values[0];
}

function freshAge(value) { return Number.isFinite(value) && value >= -5_000 && value <= MAX_MONITOR_AGE_MS; }
function unique(values) { return [...new Set(values)]; }
function required(value, label) { if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) throw new Error(`${label} is required`); return value.trim(); }
function safeError(value) { return value instanceof Error ? value.message.slice(0, 300) : String(value).slice(0, 300); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function readProtectedJson(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a protected file`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function readStateOrNull(path) {
  try { return await readProtectedJson(path, "production soak state"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function assertEvidenceEmpty(root) {
  for (const name of ["production-soak-samples.jsonl", "production-soak-report.json", "pool-host-samples.jsonl", "speedify-soak.tsv"]) {
    try { await stat(join(root, name)); throw new Error(`production soak evidence ${name} already exists without state`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

async function writeState(path, value) { await writeProtectedAtomic(path, value); }
async function writeProtectedAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readSamples(path, runId) {
  const rows = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (rows.some((row, index) => row.runId !== runId || row.slot !== index)) throw new Error("production soak sample continuity is invalid");
  return rows;
}

function publicState(state) {
  return {
    status: state.phase,
    event: state.event,
    runId: state.runId,
    armedAt: state.armedAt,
    rawReadyAt: state.rawReadyAt,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    activeCameras: state.activeCameras,
    profiles: state.profiles,
    egress: state.egress,
    observedSamples: state.sampleCount,
    problemCount: state.problemCount,
    classification: state.classification,
    reportSha256: state.reportSha256
  };
}

function createSignalLatch() {
  const value = { stopped: false };
  const handler = () => { value.stopped = true; };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return { get stopped() { return value.stopped; }, close() { process.off("SIGINT", handler); process.off("SIGTERM", handler); } };
}

function validateRouterHost(value) {
  if (typeof value !== "string" || !/^root@(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) throw new Error("router host must be root@IPv4");
  return value;
}

function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["run", "status"]).has(command)) throw new Error("first argument must be run or status");
  const options = { command, profile: null, destinations: null, evidence: null, router: "root@192.168.8.1", minimumDurationMs: 4 * 60 * 60_000, maximumDurationMs: 6 * 60 * 60_000 };
  const mapping = new Map([["--profile", "profile"], ["--destinations", "destinations"], ["--evidence", "evidence"], ["--router", "router"], ["--minimum-hours", "minimumDurationMs"], ["--maximum-hours", "maximumDurationMs"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    if (key.endsWith("DurationMs")) {
      const hours = Number(value);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 12) throw new Error(`${flag} must be more than zero and no more than 12 hours`);
      options[key] = Math.round(hours * 60 * 60_000);
    } else if (key === "router") options[key] = validateRouterHost(value);
    else options[key] = normalizedAbsolute(value, flag);
  }
  if (!options.profile || !options.destinations || !options.evidence) throw new Error("--profile, --destinations, and --evidence are required");
  if (options.minimumDurationMs > options.maximumDurationMs) throw new Error("minimum soak duration cannot exceed maximum duration");
  return options;
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function usage() {
  process.stdout.write("Usage:\n  node infra/event-stack/production-soak.mjs run --profile /PROTECTED/operator-profile.json --destinations /PROTECTED/destinations.json --evidence /PROTECTED/EVIDENCE [--router root@192.168.8.1] [--minimum-hours 4] [--maximum-hours 6]\n  node infra/event-stack/production-soak.mjs status --profile /PROTECTED/operator-profile.json --destinations /PROTECTED/destinations.json --evidence /PROTECTED/EVIDENCE\n");
}

async function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${basename(command)} failed with exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`)));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
