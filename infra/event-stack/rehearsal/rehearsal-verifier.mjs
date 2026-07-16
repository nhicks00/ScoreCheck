import { setTimeout as delay } from "node:timers/promises";

const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));

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
    const result = await this.#wait("eight complete program chains", fullProblems, { stableSamples: 6, timeoutMs: 240_000 });
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
    const problems = fullProblems(snapshot, this.now());
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
      const [stream, broadcast] = await Promise.all([
        this.youtube.getStream(courtState.stream.id),
        this.youtube.getBroadcast(courtState.broadcast.id)
      ]);
      courts.push({
        court,
        streamId: stream.id,
        broadcastId: broadcast.id,
        streamStatus: stream.streamStatus,
        healthStatus: stream.healthStatus,
        configurationIssues: stream.configurationIssues,
        broadcastLifecycle: broadcast.lifecycleStatus,
        recordingStatus: broadcast.recordingStatus,
        privacyStatus: broadcast.privacyStatus,
        boundStreamId: broadcast.boundStreamId
      });
    }
    return { observedAt: new Date(this.now()).toISOString(), courts };
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
    throw new Error(`${label} did not stabilize: ${lastProblems.slice(0, 8).join("; ") || "no current snapshot"}${lastSnapshot ? "" : "; snapshot unavailable"}`);
  }

  async #snapshot() {
    const response = await this.fetchImpl(`${this.monitorOrigin}/v1/snapshot`, {
      headers: { authorization: `Bearer ${this.monitorToken}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`rehearsal monitor snapshot returned HTTP ${response.status}`);
    const snapshot = await response.json();
    if (!snapshot || snapshot.version !== 3 || !Array.isArray(snapshot.courts) || !Array.isArray(snapshot.agents)) throw new Error("rehearsal monitor snapshot contract is invalid");
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
  const problems = rawProblems(snapshot, nowMs);
  const compositorAssignments = new Map();
  for (const agent of snapshot.agents ?? []) {
    if (agent.role === "compositor") for (const court of agent.assignedCourts ?? []) compositorAssignments.set(court, agent);
  }
  for (const court of COURTS) {
    const value = courtByNumber(snapshot, court, problems);
    if (!value) continue;
    for (const branch of ["raw", "preview", "program"]) {
      const path = value.paths?.[branch];
      if (!path?.ready || path.readerCount !== 1 || path.frameErrors !== 0) problems.push(`Camera ${court} ${branch} path is not ready with exactly one reader and zero errors`);
      if ((path?.inboundBitrateBps ?? 0) <= 0) problems.push(`Camera ${court} ${branch} path has no positive bitrate`);
    }
    for (const branch of ["preview", "program"]) {
      const ffmpeg = value.ffmpeg?.[branch];
      if (!ffmpeg || (ffmpeg.framesPerSecond ?? 0) < 29 || ffmpeg.framesPerSecond > 31 || ffmpeg.droppedFrames !== 0 || ffmpeg.duplicatedFrames !== 0 || (ffmpeg.speedRatio ?? 0) < 0.95 || ffmpeg.speedRatio > 1.05) {
        problems.push(`Camera ${court} ${branch} FFmpeg is outside 30fps/zero-drop/realtime bounds`);
      }
    }
    const browser = value.browser;
    const browserAge = browser ? nowMs - Date.parse(browser.receivedAt) : Infinity;
    if (!browser || browserAge < 0 || browserAge > 15_000 || browser.video?.state !== "playing" || browser.video?.connectionState !== "connected" || browser.video?.transport !== "whep") {
      problems.push(`Camera ${court} browser heartbeat is not fresh and playing over WHEP`);
    } else {
      if ((browser.video.framesPerSecond ?? 0) < 25 || browser.video.framesPerSecond > 35 || browser.video.framesDropped !== 0 || browser.video.freezeCount !== 0 || browser.video.totalFreezesDurationMs !== 0 || browser.video.packetsLost !== 0 || browser.video.reconnectCount !== 0 || browser.video.reloadCount !== 0) problems.push(`Camera ${court} browser quality counters are not clean`);
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
  if (!provider || !Array.isArray(provider.courts) || provider.courts.length !== 8) return ["YouTube evidence does not contain exactly eight cameras"];
  for (const court of provider.courts) {
    if (court.streamStatus !== "active" || court.healthStatus !== "good" || court.configurationIssues.length !== 0 || court.broadcastLifecycle !== "live" || court.recordingStatus !== "recording" || court.privacyStatus !== "unlisted" || court.boundStreamId !== court.streamId) {
      problems.push(`Camera ${court.court} YouTube destination is not live, recording, unlisted, healthy, and bound to its exact stream`);
    }
  }
  return unique(problems);
}

function excludedBoundaries() {
  return ["production Supabase event/scoring/control-plane persistence", "venue Speedify uplink"];
}
