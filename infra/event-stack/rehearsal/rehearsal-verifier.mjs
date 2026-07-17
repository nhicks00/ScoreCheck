import { setTimeout as delay } from "node:timers/promises";

const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const BROWSER_IDENTITY_FIELDS = Object.freeze(["credentialId", "pageLoadedAt", "pageBuildVersion", "configurationVersion"]);
const BROWSER_COUNTER_FIELDS = Object.freeze(["framesDropped", "freezeCount", "totalFreezesDurationMs", "packetsLost", "reconnectCount", "reloadCount"]);

export class RehearsalStabilizationError extends Error {
  constructor(label, evidence) {
    super(`${label} did not stabilize: ${evidence.problems.slice(0, 8).join("; ") || "no current snapshot"}${evidence.snapshot ? "" : "; snapshot unavailable"}`);
    this.name = "RehearsalStabilizationError";
    this.evidenceKind = "monitor";
    this.evidence = evidence;
  }
}

export class RehearsalVerifier {
  constructor({ monitorOrigin, monitorToken, youtube, sampler, fetchImpl = globalThis.fetch, sleep = delay, now = () => Date.now() }) {
    const parsed = new URL(monitorOrigin);
    if (parsed.protocol !== "https:" || parsed.origin !== monitorOrigin) throw new Error("rehearsal monitor origin must be an HTTPS origin");
    if (typeof monitorToken !== "string" || monitorToken.length < 24) throw new Error("rehearsal monitor token is invalid");
    Object.assign(this, { monitorOrigin, monitorToken, youtube, sampler, fetchImpl, sleep, now });
  }

  async preflight() {
    return this.#wait("rehearsal preflight", preflightProblems, { stableSamples: 2, timeoutMs: 60_000 });
  }

  async waitForRaw() {
    return this.#wait("eight raw camera paths", rawProblems, { stableSamples: 3, timeoutMs: 120_000 });
  }

  async waitForFull({ state }) {
    const result = await this.#waitForStableFull({ stableSamples: 6, timeoutMs: 240_000 });
    const provider = await this.#providerEvidence(state);
    const problems = providerProblems(provider);
    const sampler = await this.sampler.inspect(state.sampler.output);
    if (!sampler) problems.push("pool host sampler is not running after workload stabilization");
    if (problems.length) throw new Error(`eight complete program chains did not pass provider checks: ${problems.join("; ")}`);
    return {
      ...result,
      provider,
      sampler: { running: true, pid: sampler.pid, output: state.sampler.output },
      excludedBoundaries: excludedBoundaries()
    };
  }

  async observeFull({ state, includeProvider = false }) {
    const snapshot = await this.#snapshot();
    const problems = fullCurrentProblems(snapshot, this.now());
    if (!this.acceptedFullSnapshot) problems.push("accepted browser quality baseline is unavailable");
    else problems.push(...browserQualityDeltaProblems(this.acceptedFullSnapshot, snapshot));
    if (hasCompleteBrowserSet(snapshot)) this.acceptedFullSnapshot = snapshot;
    const sampler = await this.sampler.inspect(state.sampler.output);
    if (!sampler) problems.push("pool host sampler is not running");
    const provider = includeProvider ? await this.#providerEvidence(state) : null;
    if (provider) problems.push(...providerProblems(provider));
    return {
      passed: problems.length === 0,
      observedAt: new Date(this.now()).toISOString(),
      snapshot: sanitizeSnapshotEvidence(snapshot),
      provider,
      sampler: sampler ? { running: true, pid: sampler.pid, output: state.sampler.output } : { running: false, output: state.sampler.output },
      problems,
      excludedBoundaries: excludedBoundaries()
    };
  }

  async captureEndpoint({ state }) {
    return this.observeFull({ state, includeProvider: true });
  }

  async waitForIdle() {
    return this.#wait("post-rehearsal idle state", idleProblems, { stableSamples: 3, timeoutMs: 180_000 });
  }

  async #providerEvidence(state) {
    const courts = [];
    for (const court of COURTS) {
      const courtState = state.courts[court];
      const stream = await this.youtube.getStream(courtState.stream.id);
      courts.push({
        court,
        streamId: stream.id,
        title: stream.title,
        isReusable: stream.isReusable,
        streamStatus: stream.streamStatus,
        healthStatus: stream.healthStatus,
        configurationIssues: stream.configurationIssues
      });
    }
    return { mode: state.providerMode, observedAt: new Date(this.now()).toISOString(), courts };
  }

  async #waitForStableFull({ stableSamples, timeoutMs }) {
    const startedAt = this.now();
    let stable = 0;
    let previousSnapshot = null;
    let windowStartSnapshot = null;
    let lastProblems = [];
    let lastSnapshot = null;
    const discardedWindows = [];
    while (this.now() - startedAt <= timeoutMs) {
      const snapshot = await this.#snapshot();
      lastSnapshot = snapshot;
      const currentProblems = fullCurrentProblems(snapshot, this.now());
      const deltaProblems = currentProblems.length === 0 && previousSnapshot
        ? browserQualityDeltaProblems(previousSnapshot, snapshot)
        : [];
      lastProblems = unique([...currentProblems, ...deltaProblems]);
      if (lastProblems.length === 0) {
        if (!previousSnapshot || !windowStartSnapshot) windowStartSnapshot = snapshot;
        stable += 1;
        if (stable >= stableSamples) {
          this.acceptedFullSnapshot = snapshot;
          return {
            passed: true,
            observedAt: new Date(this.now()).toISOString(),
            stableSamples,
            snapshot: sanitizeSnapshotEvidence(snapshot),
            qualityWindow: {
              startedAt: windowStartSnapshot.generatedAt,
              endedAt: snapshot.generatedAt,
              samples: stable,
              baseline: browserQualityEvidence(windowStartSnapshot),
              endpoint: browserQualityEvidence(snapshot)
            },
            discardedWindows,
            problems: []
          };
        }
      } else {
        if (stable > 0) {
          discardedWindows.push({
            observedAt: snapshot.generatedAt,
            completedSamples: stable,
            problems: lastProblems
          });
          if (discardedWindows.length > 20) discardedWindows.shift();
        }
        stable = 0;
        windowStartSnapshot = null;
      }
      previousSnapshot = snapshot;
      await this.sleep(5_000);
    }
    throw new RehearsalStabilizationError("eight complete program chains", {
      passed: false,
      observedAt: new Date(this.now()).toISOString(),
      stableSamples: stable,
      snapshot: lastSnapshot ? sanitizeSnapshotEvidence(lastSnapshot) : null,
      discardedWindows,
      problems: lastProblems
    });
  }

  async #wait(label, problemFunction, { stableSamples, timeoutMs }) {
    const startedAt = this.now();
    let stable = 0;
    let lastProblems = [];
    let lastSnapshot = null;
    while (this.now() - startedAt <= timeoutMs) {
      const snapshot = await this.#snapshot();
      lastSnapshot = snapshot;
      lastProblems = problemFunction(snapshot, this.now());
      if (lastProblems.length === 0) {
        stable += 1;
        if (stable >= stableSamples) return { passed: true, observedAt: new Date(this.now()).toISOString(), stableSamples, snapshot: sanitizeSnapshotEvidence(snapshot), problems: [] };
      } else stable = 0;
      await this.sleep(5_000);
    }
    throw new RehearsalStabilizationError(label, {
      passed: false,
      observedAt: new Date(this.now()).toISOString(),
      stableSamples: stable,
      snapshot: lastSnapshot ? sanitizeSnapshotEvidence(lastSnapshot) : null,
      problems: lastProblems
    });
  }

  async #snapshot() {
    const response = await this.fetchImpl(`${this.monitorOrigin}/v1/snapshot`, {
      headers: { authorization: `Bearer ${this.monitorToken}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`rehearsal monitor snapshot returned HTTP ${response.status}`);
    const snapshot = await response.json();
    if (!snapshot || snapshot.version !== 4 || !Array.isArray(snapshot.courts) || !Array.isArray(snapshot.agents)) throw new Error("rehearsal monitor snapshot contract is invalid");
    return snapshot;
  }
}

export function preflightProblems(snapshot, nowMs = Date.now()) {
  const problems = commonProblems(snapshot, nowMs);
  if (snapshot.event !== null) problems.push("isolated rehearsal monitor unexpectedly has an active Supabase event");
  for (const court of snapshot.courts ?? []) {
    if (court.browser) problems.push(`Camera ${court.courtNumber} has a browser before workload start`);
    for (const branch of ["raw", "preview", "program"]) {
      const path = court.paths?.[branch];
      if (path?.ready || (path?.readerCount ?? 0) !== 0) problems.push(`Camera ${court.courtNumber} ${branch} is occupied before workload start`);
    }
  }
  for (const agent of snapshot.agents ?? []) {
    if (["compositor", "worker"].includes(agent.role)) {
      const egress = agent.nativeServices?.egress;
      if (!egress || !egress.idle || egress.activeWebRequests !== 0 || egress.maximumWebRequests !== 1 || !egress.canAcceptRequest) problems.push(`${agent.agentId} is not idle and admission-ready`);
    }
  }
  return unique(problems);
}

export function rawProblems(snapshot, nowMs = Date.now()) {
  const problems = commonProblems(snapshot, nowMs);
  for (const court of COURTS) {
    const value = courtByNumber(snapshot, court, problems);
    if (!value) continue;
    const path = value.paths?.raw;
    const protocol = court <= 2 ? "RTMP" : "SRT";
    if (!path?.ready) problems.push(`Camera ${court} raw path is not ready`);
    if ((path?.inboundBitrateBps ?? 0) < 1_000_000) problems.push(`Camera ${court} raw bitrate is below 1 Mbps`);
    if (path?.frameErrors !== 0) problems.push(`Camera ${court} raw frame errors are nonzero`);
    if (path?.sourceMode !== "PUSH" || path?.sourceProtocol !== protocol) problems.push(`Camera ${court} raw source is not ${protocol} PUSH`);
    if (path?.videoCodec !== "H264" || path?.videoProfile !== "Main" || path?.audioCodec !== "AAC"
      || path?.videoWidth !== 1280 || path?.videoHeight !== 720
      || path?.audioSampleRateHz !== 48_000 || path?.audioChannelCount !== 2) {
      problems.push(`Camera ${court} raw codec/profile is not the rehearsal H264 Main 720p/AAC 48kHz stereo contract`);
    }
  }
  return unique(problems);
}

export function fullProblems(snapshot, nowMs = Date.now()) {
  return fullProblemsInternal(snapshot, nowMs, true);
}

export function fullCurrentProblems(snapshot, nowMs = Date.now()) {
  return fullProblemsInternal(snapshot, nowMs, false);
}

function fullProblemsInternal(snapshot, nowMs, requireZeroBrowserHistory) {
  const problems = rawProblems(snapshot, nowMs);
  const compositorAssignments = new Map();
  for (const agent of snapshot.agents ?? []) {
    if (agent.role === "compositor") for (const court of agent.assignedCourts ?? []) compositorAssignments.set(court, agent);
  }
  for (const court of COURTS) {
    const value = courtByNumber(snapshot, court, problems);
    if (!value) continue;
    const expectedReaders = { raw: 2, preview: 2, program: 1 };
    for (const branch of ["raw", "preview", "program"]) {
      const path = value.paths?.[branch];
      if (!path?.ready || path.readerCount !== expectedReaders[branch] || path.frameErrors !== 0) problems.push(`Camera ${court} ${branch} path is not ready with exactly ${expectedReaders[branch]} reader${expectedReaders[branch] === 1 ? "" : "s"} and zero errors`);
      if ((path?.inboundBitrateBps ?? 0) <= 0) problems.push(`Camera ${court} ${branch} path has no positive bitrate`);
    }
    for (const branch of ["preview", "program"]) {
      const ffmpeg = value.ffmpeg?.[branch];
      if (!ffmpeg || (ffmpeg.framesPerSecond ?? 0) < 29 || ffmpeg.framesPerSecond > 31 || ffmpeg.droppedFrames !== 0 || ffmpeg.duplicatedFrames !== 0 || (ffmpeg.speedRatio ?? 0) < 0.95 || ffmpeg.speedRatio > 1.05) {
        problems.push(`Camera ${court} ${branch} FFmpeg is outside 30fps/zero-drop/realtime bounds (${ffmpegSummary(ffmpeg)})`);
      }
    }
    const browser = value.browser;
    const browserAge = browser ? nowMs - Date.parse(browser.receivedAt) : Infinity;
    if (!browser || browserAge < 0 || browserAge > 15_000 || browser.video?.state !== "playing" || browser.video?.connectionState !== "connected" || browser.video?.transport !== "whep") {
      problems.push(`Camera ${court} browser heartbeat is not fresh and playing over WHEP`);
    } else {
      const countersInvalid = BROWSER_COUNTER_FIELDS.some((field) => !Number.isFinite(browser.video[field]) || browser.video[field] < 0);
      const historyNotClean = requireZeroBrowserHistory && BROWSER_COUNTER_FIELDS.some((field) => browser.video[field] !== 0);
      if ((browser.video.framesPerSecond ?? 0) < 25 || browser.video.framesPerSecond > 35 || countersInvalid || historyNotClean) problems.push(`Camera ${court} browser quality counters are not clean`);
      const commentary = browser.commentary;
      const syncGapMs = commentary.targetDelayMs === null || commentary.appliedDelayMs === null ? Infinity : Math.abs(commentary.targetDelayMs - commentary.appliedDelayMs);
      if (!commentary.configured || !commentary.roomConnected || commentary.participantCount < 1 || commentary.audioTrackCount < 1 || commentary.mutedAudioTrackCount !== 0
        || commentary.rmsDb === null || (commentary.secondsSinceAudio ?? Infinity) > 5 || commentary.packetsLost !== 0 || (commentary.clippedSampleRatio ?? 0) > 0.05
        || !commentary.cameraTrackPresent || commentary.cameraRmsDb === null || (commentary.secondsSinceCameraAudio ?? Infinity) > 5 || (commentary.cameraClippedSampleRatio ?? 0) > 0.05
        || commentary.syncStatus !== "locked" || syncGapMs > 250 || (commentary.clockRttMs ?? Infinity) > 1_000 || (commentary.syncSampleAgeMs ?? Infinity) > 10_000) {
        problems.push(`Camera ${court} remote commentary/audio synchronization is not healthy and locked`);
      }
    }
    const agent = compositorAssignments.get(court);
    const egress = agent?.nativeServices?.egress;
    if (!agent || agent.state !== "HEALTHY" || !egress || egress.idle || egress.activeWebRequests !== 1 || egress.maximumWebRequests !== 1 || egress.canAcceptRequest || (egress.cpuLoadRatio ?? 1) >= 0.85 || (egress.memoryLoadRatio ?? 1) >= 0.85) {
      problems.push(`Camera ${court} compositor does not show exactly one healthy admitted Egress with headroom`);
    }
  }
  const spare = (snapshot.agents ?? []).find((agent) => agent.role === "worker");
  const spareEgress = spare?.nativeServices?.egress;
  if (!spare || spare.state !== "HEALTHY" || !spareEgress?.idle || spareEgress.activeWebRequests !== 0 || !spareEgress.canAcceptRequest) problems.push("warm spare is not healthy, idle, and admission-ready");
  return unique(problems);
}

export function browserQualityDeltaProblems(previous, current) {
  const problems = [];
  for (const court of COURTS) {
    const before = (previous?.courts ?? []).find((entry) => entry.courtNumber === court)?.browser;
    const after = (current?.courts ?? []).find((entry) => entry.courtNumber === court)?.browser;
    if (!before || !after) {
      problems.push(`Camera ${court} browser continuity sample is missing`);
      continue;
    }
    for (const field of BROWSER_IDENTITY_FIELDS) {
      if (!before[field] || after[field] !== before[field]) problems.push(`Camera ${court} browser ${field} changed`);
    }
    if (!Number.isInteger(after.heartbeatSeq) || after.heartbeatSeq <= before.heartbeatSeq) problems.push(`Camera ${court} browser heartbeat sequence did not advance`);
    if (!Number.isFinite(Date.parse(after.receivedAt)) || Date.parse(after.receivedAt) <= Date.parse(before.receivedAt)) problems.push(`Camera ${court} browser receipt timestamp did not advance`);
    if (!Number.isInteger(after.video?.framesRendered) || after.video.framesRendered <= before.video?.framesRendered) problems.push(`Camera ${court} rendered frames did not advance`);
    for (const field of BROWSER_COUNTER_FIELDS) {
      const beforeValue = before.video?.[field];
      const afterValue = after.video?.[field];
      if (!Number.isFinite(beforeValue) || !Number.isFinite(afterValue)) problems.push(`Camera ${court} browser ${field} is unavailable`);
      else if (afterValue !== beforeValue) problems.push(`Camera ${court} browser ${field} changed from ${beforeValue} to ${afterValue}`);
    }
  }
  return unique(problems);
}

function ffmpegSummary(value) {
  if (!value) return "missing";
  return `fps=${value.framesPerSecond ?? "null"},drop=${value.droppedFrames ?? "null"},dup=${value.duplicatedFrames ?? "null"},speed=${value.speedRatio ?? "null"}`;
}

export function idleProblems(snapshot, nowMs = Date.now()) {
  const problems = commonProblems(snapshot, nowMs);
  for (const court of snapshot.courts ?? []) {
    for (const branch of ["raw", "preview", "program"]) {
      const path = court.paths?.[branch];
      if (path?.ready || (path?.readerCount ?? 0) !== 0) problems.push(`Camera ${court.courtNumber} ${branch} did not retire after cleanup`);
    }
  }
  for (const agent of snapshot.agents ?? []) {
    if (["compositor", "worker"].includes(agent.role)) {
      const egress = agent.nativeServices?.egress;
      if (!egress?.idle || egress.activeWebRequests !== 0) problems.push(`${agent.agentId} retained an active Egress after cleanup`);
    }
  }
  return unique(problems);
}

function commonProblems(snapshot, nowMs) {
  const problems = [];
  const generatedAge = nowMs - Date.parse(snapshot?.generatedAt);
  if (!Number.isFinite(generatedAge) || generatedAge < 0 || generatedAge > 15_000) problems.push("monitor snapshot is stale");
  if (snapshot?.collector?.agentsExpected !== 12 || snapshot?.collector?.agentsFresh !== 12) problems.push("monitor does not have all 12 rehearsal agents fresh");
  if (!Array.isArray(snapshot?.agents) || snapshot.agents.length !== 12 || snapshot.agents.some((agent) => agent.state !== "HEALTHY")) problems.push("one or more rehearsal agents are unhealthy");
  for (const agent of snapshot?.agents ?? []) {
    const host = agent.host;
    if (!host || host.memoryTotalBytes <= 0 || host.memoryAvailableBytes / host.memoryTotalBytes < 0.15) problems.push(`${agent.agentId} has insufficient memory headroom`);
    if (host && host.diskTotalBytes !== null && host.diskFreeBytes !== null && (host.diskTotalBytes <= 0 || host.diskFreeBytes / host.diskTotalBytes < 0.1)) problems.push(`${agent.agentId} has insufficient disk headroom`);
    if ((agent.services ?? []).some((service) => !service.running || service.healthy === false || service.restartCount !== 0 || service.oomKilled)) problems.push(`${agent.agentId} has an unhealthy, restarted, or OOM-killed service`);
  }
  if ((snapshot?.incidents ?? []).length !== 0) problems.push("rehearsal monitor has an active incident");
  if ((snapshot?.faultGates ?? []).length !== 0) problems.push("rehearsal monitor has an armed fault gate");
  if (!Array.isArray(snapshot?.courts) || snapshot.courts.length !== 8) problems.push("monitor snapshot does not contain exactly eight cameras");
  return problems;
}

function courtByNumber(snapshot, court, problems) {
  const values = (snapshot.courts ?? []).filter((entry) => entry.courtNumber === court);
  if (values.length !== 1) { problems.push(`monitor does not contain exactly one Camera ${court}`); return null; }
  return values[0];
}

function hasCompleteBrowserSet(snapshot) {
  return COURTS.every((court) => {
    const browser = (snapshot?.courts ?? []).find((entry) => entry.courtNumber === court)?.browser;
    return browser && BROWSER_IDENTITY_FIELDS.every((field) => browser[field])
      && Number.isInteger(browser.heartbeatSeq)
      && Number.isInteger(browser.video?.framesRendered)
      && BROWSER_COUNTER_FIELDS.every((field) => Number.isFinite(browser.video?.[field]));
  });
}

function browserQualityEvidence(snapshot) {
  return (snapshot?.courts ?? []).map((court) => ({
    courtNumber: court.courtNumber,
    credentialId: court.browser?.credentialId ?? null,
    pageLoadedAt: court.browser?.pageLoadedAt ?? null,
    pageBuildVersion: court.browser?.pageBuildVersion ?? null,
    configurationVersion: court.browser?.configurationVersion ?? null,
    heartbeatSeq: court.browser?.heartbeatSeq ?? null,
    receivedAt: court.browser?.receivedAt ?? null,
    framesRendered: court.browser?.video?.framesRendered ?? null,
    ...Object.fromEntries(BROWSER_COUNTER_FIELDS.map((field) => [field, court.browser?.video?.[field] ?? null]))
  }));
}

function sanitizeSnapshotEvidence(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    collector: snapshot.collector,
    agentCount: snapshot.agents.length,
    incidents: snapshot.incidents.length,
    faultGates: snapshot.faultGates.length,
    courts: snapshot.courts.map((court) => ({
      courtNumber: court.courtNumber,
      paths: Object.fromEntries(["raw", "preview", "program"].map((branch) => [branch, court.paths?.[branch] ? {
        ready: court.paths[branch].ready,
        readerCount: court.paths[branch].readerCount,
        inboundBitrateBps: court.paths[branch].inboundBitrateBps,
        frameErrors: court.paths[branch].frameErrors,
        sourceProtocol: court.paths[branch].sourceProtocol
      } : null])),
      ffmpeg: Object.fromEntries(["preview", "program"].map((branch) => [branch, court.ffmpeg?.[branch] ? {
        sampledAt: court.ffmpeg[branch].sampledAt,
        framesPerSecond: court.ffmpeg[branch].framesPerSecond,
        droppedFrames: court.ffmpeg[branch].droppedFrames,
        duplicatedFrames: court.ffmpeg[branch].duplicatedFrames,
        speedRatio: court.ffmpeg[branch].speedRatio
      } : null])),
      browser: court.browser ? {
        credentialId: court.browser.credentialId,
        heartbeatSeq: court.browser.heartbeatSeq,
        receivedAt: court.browser.receivedAt,
        pageLoadedAt: court.browser.pageLoadedAt,
        pageBuildVersion: court.browser.pageBuildVersion,
        configurationVersion: court.browser.configurationVersion,
        video: court.browser.video,
        commentary: court.browser.commentary
      } : null
    }))
  };
}

function unique(values) { return [...new Set(values)]; }

export function providerProblems(provider) {
  const problems = [];
  if (!provider || provider.mode !== "persistent-youtube-stream-ingest-v1" || !Array.isArray(provider.courts) || provider.courts.length !== 8) {
    return ["YouTube evidence does not contain the exact persistent eight-stream ingest contract"];
  }
  for (const court of provider.courts) {
    if (court.title !== `ScoreCheck Court ${court.court} Test Stream`
      || court.isReusable !== true
      || court.streamStatus !== "active"
      || court.healthStatus !== "good"
      || !Array.isArray(court.configurationIssues)
      || court.configurationIssues.length !== 0) {
      problems.push(`Camera ${court.court} persistent YouTube ingest stream is not exact, reusable, active, and healthy`);
    }
  }
  return unique(problems);
}

function excludedBoundaries() {
  return [
    "production Supabase event/scoring/control-plane persistence",
    "venue Speedify uplink",
    "YouTube broadcast/watch-page creation and recording lifecycle (separate tournament control-plane preflight)"
  ];
}
