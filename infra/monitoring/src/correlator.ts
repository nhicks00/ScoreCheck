import { MONITORING_CONTRACT_VERSION, worstHealthState, type AgentSnapshot, type BrowserHeartbeatSnapshot, type BrowserThumbnailMetadata, type ControlPlaneSnapshot, type CourtExpectation, type FfmpegBranchSnapshot, type HealthState, type IncidentSnapshot, type MediaPathSnapshot, type MonitorSnapshot, type MonitoringStage, type NotificationHealth, type StageHealth, type YouTubeMonitorSnapshot } from "./contracts.js";
import type { AgentTarget } from "./config.js";

export type AgentRuntime = {
  target: AgentTarget;
  snapshot: AgentSnapshot | null;
  lastSeenAt: string | null;
  lastErrorAt: string | null;
};

export function buildMonitorSnapshot(
  targets: AgentTarget[],
  runtimes: Map<string, AgentRuntime>,
  courtCount: number,
  nowMs = Date.now(),
  incidents: IncidentSnapshot[] = [],
  browserHeartbeats = new Map<number, BrowserHeartbeatSnapshot>(),
  controlPlane: ControlPlaneSnapshot | null = null,
  youtubeMonitor: YouTubeMonitorSnapshot | null = null,
  notifications: NotificationHealth = OFF_NOTIFICATION_HEALTH,
  thumbnails = new Map<number, BrowserThumbnailMetadata>()
): MonitorSnapshot {
  const agents = targets.map((target) => {
    const runtime = runtimes.get(target.id);
    const ageMs = age(runtime?.lastSeenAt ?? null, nowMs);
    return {
      agentId: target.id,
      role: target.role,
      state: agentState(runtime?.snapshot ?? null, ageMs),
      lastSeenAt: runtime?.lastSeenAt ?? null,
      ageMs,
      host: runtime?.snapshot?.host ?? null,
      services: runtime?.snapshot?.services ?? [],
      nativeServices: runtime?.snapshot?.nativeServices ?? null
    };
  });

  const paths = latestMediaPaths(runtimes, nowMs);
  const ffmpegBranches = latestFfmpegBranches(runtimes, nowMs);
  const courts = Array.from({ length: courtCount }, (_, index) => {
    const courtNumber = index + 1;
    const courtPaths = paths.filter((path) => path.courtNumber === courtNumber);
    const byBranch = Object.fromEntries(courtPaths.map((path) => [path.branch, path])) as Partial<Record<MediaPathSnapshot["branch"], MediaPathSnapshot>>;
    const courtFfmpeg = ffmpegBranches.filter((branch) => branch.courtNumber === courtNumber);
    const ffmpeg = Object.fromEntries(courtFfmpeg.map((branch) => [branch.branch, branch])) as Partial<Record<FfmpegBranchSnapshot["branch"], FfmpegBranchSnapshot>>;
    const browser = browserHeartbeats.get(courtNumber) ?? null;
    const competition = controlPlane?.courts.find((court) => court.courtNumber === courtNumber) ?? null;
    const youtube = youtubeMonitor?.courts.find((court) => court.courtNumber === courtNumber) ?? null;
    const expectation = competition?.expectation ?? OFF_EXPECTATION;
    const stages = [
      pathStage("RAW_INGEST", "raw", byBranch.raw ?? null, nowMs, expectation),
      pathStage("PREVIEW", "preview", byBranch.preview ?? null, nowMs, expectation),
      pathStage("PROGRAM_PATH", "program", byBranch.program ?? null, nowMs, expectation),
      programBrowserStage(browser, nowMs, expectation),
      commentaryStage(browser, nowMs, expectation),
      scoreSourceStage(competition, controlPlane, nowMs, expectation),
      scoreRenderStage(browser, nowMs, expectation),
      youtubeStage(youtube, youtubeMonitor, nowMs, expectation)
    ];
    return {
      courtNumber,
      overallState: worstHealthState(stages.map((stage) => stage.state)),
      stages,
      paths: byBranch,
      ffmpeg,
      browser,
      competition,
      expectation,
      youtube,
      thumbnail: thumbnails.get(courtNumber) ?? null
    };
  });

  const agentsFresh = agents.filter((agent) => agent.state === "HEALTHY" || agent.state === "DEGRADED").length;
  const controlPlaneAgeMs = age(controlPlane?.observedAt ?? null, nowMs);
  const controlPlaneState: HealthState = !controlPlane || controlPlaneAgeMs == null || controlPlaneAgeMs > 30_000
    ? "UNKNOWN"
    : controlPlaneAgeMs > 20_000 ? "DEGRADED" : "HEALTHY";
  const youtubeAgeMs = age(youtubeMonitor?.observedAt ?? null, nowMs);
  const youtubeState: HealthState = !youtubeMonitor || youtubeAgeMs == null || youtubeAgeMs > 180_000
    ? "UNKNOWN"
    : youtubeMonitor.apiState;
  return {
    version: MONITORING_CONTRACT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    collector: {
      state: targets.length === 0 ? "UNKNOWN" : worstHealthState(agents.map((agent) => agent.state)),
      agentsExpected: targets.length,
      agentsFresh
    },
    controlPlane: {
      state: controlPlaneState,
      observedAt: controlPlane?.observedAt ?? null,
      ageMs: controlPlaneAgeMs,
      worker: controlPlane?.worker ?? { state: "UNKNOWN", status: null, lastSeenAt: null, ageMs: null }
    },
    event: controlPlane?.event ?? null,
    youtube: { state: youtubeState, observedAt: youtubeMonitor?.observedAt ?? null, ageMs: youtubeAgeMs },
    notifications,
    courts,
    agents,
    incidents
  };
}

function youtubeStage(
  youtube: YouTubeMonitorSnapshot["courts"][number] | null,
  monitor: YouTubeMonitorSnapshot | null,
  nowMs: number,
  expectation: CourtExpectation
): StageHealth {
  if (expectation.broadcastExpectation === "OFF") {
    return stage("YOUTUBE", "NOT_APPLICABLE", "info", null, "YouTube broadcast is not expected.", null, monitor?.observedAt ?? null, age(monitor?.observedAt ?? null, nowMs), {});
  }
  const ageMs = age(youtube?.observedAt ?? monitor?.observedAt ?? null, nowMs);
  if (!youtube || ageMs == null || ageMs > 180_000 || monitor?.apiState === "UNKNOWN") {
    return stage("YOUTUBE", "UNKNOWN", "warning", "YOUTUBE_STATUS_UNKNOWN", "YouTube provider status is unavailable or stale.", "Check provider credentials, quota, and API availability; do not infer a stream outage from API failure.", youtube?.observedAt ?? monitor?.observedAt ?? null, ageMs, {});
  }
  return stage(
    "YOUTUBE",
    youtube.state,
    youtube.state === "CRITICAL" ? "critical" : youtube.state === "DEGRADED" ? "warning" : "info",
    youtube.state === "CRITICAL" ? "YOUTUBE_STREAM_UNHEALTHY" : youtube.state === "DEGRADED" ? "YOUTUBE_STREAM_DEGRADED" : null,
    youtube.state === "HEALTHY" ? "YouTube broadcast and ingestion health are good." : youtube.state === "CRITICAL" ? "YouTube reports an unhealthy stream or configuration issue." : youtube.state === "DEGRADED" ? "YouTube reports a warning-level ingestion issue." : "YouTube stream state is not yet conclusive.",
    youtube.state === "CRITICAL" || youtube.state === "DEGRADED" ? "Inspect YouTube ingestion health and bounded configuration issue codes." : null,
    youtube.observedAt,
    ageMs,
    {
      lifecycle: youtube.broadcastLifecycle,
      streamStatus: youtube.streamStatus,
      healthStatus: youtube.healthStatus,
      issueCount: youtube.configurationIssues.length
    }
  );
}

function programBrowserStage(browser: BrowserHeartbeatSnapshot | null, nowMs: number, expectation: CourtExpectation): StageHealth {
  const timing = browserTiming(browser, nowMs);
  if (!browser || timing.stale) {
    if (expectation.broadcastExpectation === "OFF") return expectedOffStage("PROGRAM_BROWSER", "Program browser is not expected.");
    return missingBrowserStage("PROGRAM_BROWSER", timing, expectation.broadcastExpectation === "LIVE");
  }
  const video = browser.video;
  const critical = video.state === "fatal" || video.state === "stalled" || video.framesPerSecond === 0;
  const degraded = !critical && (video.state !== "playing" || video.connectionState !== "connected");
  return {
    stage: "PROGRAM_BROWSER",
    state: critical ? "CRITICAL" : degraded ? "DEGRADED" : "HEALTHY",
    severity: critical ? "critical" : degraded ? "warning" : "info",
    issueCode: critical ? "PROGRAM_FRAMES_STALLED" : degraded ? "PROGRAM_NOT_STABLE" : null,
    summary: critical ? "Program browser frames are not flowing." : degraded ? `Program browser is ${video.state}.` : "Program browser frames are flowing.",
    firstAction: critical ? "Check the program path, WHEP connection, and compositor browser." : degraded ? "Inspect the browser transport and reconnect state." : null,
    confidence: "high",
    observedAt: browser.sampledAt,
    ageMs: timing.ageMs,
    evidence: {
      videoState: video.state,
      transport: video.transport,
      connectionState: video.connectionState,
      frames: video.framesRendered,
      fps: video.framesPerSecond,
      width: video.width,
      height: video.height,
      rttMs: video.rttMs,
      jitterBufferMs: video.jitterBufferMs,
      packetsLost: video.packetsLost,
      packetsReceived: video.packetsReceived,
      framesDropped: video.framesDropped,
      reconnects: video.reconnectCount,
      reloads: video.reloadCount
    }
  };
}

function commentaryStage(browser: BrowserHeartbeatSnapshot | null, nowMs: number, expectation: CourtExpectation): StageHealth {
  const timing = browserTiming(browser, nowMs);
  if (!browser || timing.stale) {
    if (expectation.commentaryExpectation === "NONE") return stage("COMMENTARY", "NOT_APPLICABLE", "info", null, "Commentary is not expected.", null, null, timing.ageMs, {});
    return missingBrowserStage("COMMENTARY", timing, expectation.commentaryExpectation === "REQUIRED");
  }
  const commentary = browser.commentary;
  if (!commentary.configured) {
    return stage("COMMENTARY", "NOT_APPLICABLE", "info", null, "Commentary is not configured for this scene.", null, browser.sampledAt, timing.ageMs, {});
  }
  if (!commentary.roomConnected) {
    return stage("COMMENTARY", "DEGRADED", "warning", "COMMENTARY_ROOM_DISCONNECTED", "Program browser is disconnected from the commentary room.", "Check LiveKit reachability and the browser room connection.", browser.sampledAt, timing.ageMs, {
      participants: commentary.participantCount,
      audioTracks: commentary.audioTrackCount
    });
  }
  const syncDegraded = commentary.audioTrackCount > 0 && commentary.syncStatus !== "locked";
  return stage(
    "COMMENTARY",
    syncDegraded ? "DEGRADED" : "HEALTHY",
    syncDegraded ? "warning" : "info",
    syncDegraded ? "COMMENTARY_SYNC_UNLOCKED" : null,
    commentary.audioTrackCount > 0
      ? syncDegraded ? `Commentary sync is ${commentary.syncStatus}.` : "Commentary audio and synchronization are healthy."
      : "Commentary room is healthy with no active audio track.",
    syncDegraded ? "Check timing sample age, LiveKit RTT, and configured delay." : null,
    browser.sampledAt,
    timing.ageMs,
    {
      participants: commentary.participantCount,
      audioTracks: commentary.audioTrackCount,
      rmsDb: commentary.rmsDb,
      secondsSinceAudio: commentary.secondsSinceAudio,
      syncStatus: commentary.syncStatus,
      appliedDelayMs: commentary.appliedDelayMs,
      clockRttMs: commentary.clockRttMs,
      syncSampleAgeMs: commentary.syncSampleAgeMs
    }
  );
}

function scoreRenderStage(browser: BrowserHeartbeatSnapshot | null, nowMs: number, expectation: CourtExpectation): StageHealth {
  const timing = browserTiming(browser, nowMs);
  if (!browser || timing.stale) {
    if (expectation.scoringExpectation === "NONE" && expectation.broadcastExpectation === "OFF") {
      return stage("SCORE_RENDER", "NOT_APPLICABLE", "info", null, "Score rendering is not expected.", null, null, timing.ageMs, {});
    }
    return missingBrowserStage("SCORE_RENDER", timing, expectation.broadcastExpectation === "LIVE");
  }
  const render = browser.scoreRender;
  const mismatch = Boolean(render.domMismatchReason)
    || (render.sourceSignature != null && render.renderedSignature != null && render.sourceSignature !== render.renderedSignature);
  const unavailable = !render.loaded || !render.connected;
  const degraded = unavailable || render.stale || render.frozen;
  return stage(
    "SCORE_RENDER",
    mismatch ? "CRITICAL" : degraded ? "DEGRADED" : "HEALTHY",
    mismatch ? "critical" : degraded ? "warning" : "info",
    mismatch ? "SCOREBUG_DOM_MISMATCH" : unavailable ? "SCOREBUG_STATE_UNAVAILABLE" : render.stale ? "SCOREBUG_STATE_STALE" : render.frozen ? "SCOREBUG_FROZEN" : null,
    mismatch ? "Rendered scorebug does not match its source state." : degraded ? "Scorebug state is unavailable, stale, or frozen." : "Scorebug source state and rendered DOM agree.",
    mismatch ? "Inspect the scorebug DOM and source-state signature before changing score data." : degraded ? "Check overlay state connectivity and freshness." : null,
    browser.sampledAt,
    timing.ageMs,
    {
      loaded: render.loaded,
      connected: render.connected,
      stale: render.stale,
      frozen: render.frozen,
      phase: render.phase,
      domMismatch: render.domMismatchReason
    }
  );
}

function scoreSourceStage(
  competition: ControlPlaneSnapshot["courts"][number] | null,
  controlPlane: ControlPlaneSnapshot | null,
  nowMs: number,
  expectation: CourtExpectation
): StageHealth {
  if (expectation.scoringExpectation === "NONE") {
    return stage("SCORE_SOURCE", "NOT_APPLICABLE", "info", null, "Scoring is not expected.", null, controlPlane?.observedAt ?? null, age(controlPlane?.observedAt ?? null, nowMs), {});
  }
  if (!competition) {
    return stage("SCORE_SOURCE", "UNKNOWN", "warning", "COURT_STATE_UNAVAILABLE", "Court score state is unavailable.", "Check the active event and court mapping in Supabase.", controlPlane?.observedAt ?? null, age(controlPlane?.observedAt ?? null, nowMs), {});
  }
  const alignment = competition.alignment;
  return stage(
    "SCORE_SOURCE",
    alignment.state,
    alignment.state === "CRITICAL" ? "critical" : alignment.state === "DEGRADED" ? "warning" : "info",
    alignment.issueCodes[0] ?? null,
    alignment.issueCodes.length > 0 ? `Score alignment issue: ${alignment.issueCodes.join(", ")}.` : "Canonical score, overlay state, and court match are aligned.",
    alignment.issueCodes.length > 0 ? "Compare current match, score source freshness, and persisted overlay state." : null,
    controlPlane?.observedAt ?? null,
    age(controlPlane?.observedAt ?? null, nowMs),
    { sourceAgeMs: alignment.sourceAgeMs, issueCount: alignment.issueCodes.length }
  );
}

function missingBrowserStage(stageName: MonitoringStage, timing: { stale: boolean; ageMs: number | null }, required: boolean): StageHealth {
  return stage(
    stageName,
    required ? "CRITICAL" : "UNKNOWN",
    required ? "critical" : "warning",
    timing.ageMs == null ? "BROWSER_HEARTBEAT_MISSING" : "BROWSER_HEARTBEAT_STALE",
    timing.ageMs == null ? "No program browser heartbeat has been observed." : "Program browser heartbeat is stale.",
    "Confirm whether the court is expected on, then inspect compositor and gateway reachability.",
    null,
    timing.ageMs,
    {}
  );
}

function expectedOffStage(stageName: MonitoringStage, summary: string): StageHealth {
  return stage(stageName, "EXPECTED_OFF", "info", null, summary, null, null, null, {});
}

function browserTiming(browser: BrowserHeartbeatSnapshot | null, nowMs: number) {
  const ageMs = age(browser?.receivedAt ?? null, nowMs);
  return { ageMs, stale: ageMs == null || ageMs > 15_000 };
}

function stage(
  stageName: MonitoringStage,
  stateName: HealthState,
  severity: StageHealth["severity"],
  issueCode: string | null,
  summary: string,
  firstAction: string | null,
  observedAt: string | null,
  ageMs: number | null,
  evidence: StageHealth["evidence"]
): StageHealth {
  return {
    stage: stageName,
    state: stateName,
    severity,
    issueCode,
    summary,
    firstAction,
    confidence: "high",
    observedAt,
    ageMs,
    evidence
  };
}

function agentState(snapshot: AgentSnapshot | null, ageMs: number | null): HealthState {
  if (!snapshot || ageMs == null || ageMs > 20_000) return "UNKNOWN";
  if (ageMs > 10_000 || snapshot.collectionErrors.length > 0) return "DEGRADED";
  return "HEALTHY";
}

function latestMediaPaths(runtimes: Map<string, AgentRuntime>, nowMs: number): MediaPathSnapshot[] {
  const byName = new Map<string, { path: MediaPathSnapshot; observedAtMs: number }>();
  for (const runtime of runtimes.values()) {
    if (!runtime.snapshot) continue;
    const observedAtMs = Date.parse(runtime.snapshot.generatedAt);
    if (!Number.isFinite(observedAtMs) || nowMs - observedAtMs > 20_000) continue;
    for (const path of runtime.snapshot.mediaPaths) {
      const existing = byName.get(path.name);
      if (!existing || observedAtMs > existing.observedAtMs) byName.set(path.name, { path, observedAtMs });
    }
  }
  return [...byName.values()].map((entry) => entry.path);
}

function latestFfmpegBranches(runtimes: Map<string, AgentRuntime>, nowMs: number): FfmpegBranchSnapshot[] {
  const byName = new Map<string, { branch: FfmpegBranchSnapshot; observedAtMs: number }>();
  for (const runtime of runtimes.values()) {
    if (!runtime.snapshot) continue;
    const observedAtMs = Date.parse(runtime.snapshot.generatedAt);
    if (!Number.isFinite(observedAtMs) || nowMs - observedAtMs > 20_000) continue;
    for (const branch of runtime.snapshot.ffmpegBranches) {
      const existing = byName.get(branch.name);
      if (!existing || observedAtMs > existing.observedAtMs) byName.set(branch.name, { branch, observedAtMs });
    }
  }
  return [...byName.values()].map((entry) => entry.branch);
}

function pathStage(stage: MonitoringStage, branch: MediaPathSnapshot["branch"], path: MediaPathSnapshot | null, nowMs: number, expectation: CourtExpectation): StageHealth {
  if (expectation.mediaExpectation === "OFF" && !path?.ready) {
    return expectedOffStage(stage, `${branch} path is not expected.`);
  }
  if (!path) {
    const required = expectation.mediaExpectation === "REQUIRED";
    return {
      stage,
      state: required ? "CRITICAL" : "UNKNOWN",
      severity: required ? "critical" : "warning",
      issueCode: required ? "REQUIRED_PATH_MISSING" : "NO_PATH_OBSERVATION",
      summary: `No current ${branch} path observation.`,
      firstAction: "Confirm the host agent and expected coverage state.",
      confidence: "high",
      observedAt: null,
      ageMs: null,
      evidence: { branch }
    };
  }
  return {
    stage,
    state: path.ready ? "HEALTHY" : "UNKNOWN",
    severity: path.ready ? "info" : "warning",
    issueCode: path.ready ? null : "PATH_NOT_READY_EXPECTATION_UNKNOWN",
    summary: path.ready ? `${branch} path ready.` : `${branch} path is not ready; expectation has not been loaded yet.`,
    firstAction: path.ready ? null : "Check coverage expectation before treating this as an outage.",
    confidence: "high",
    observedAt: new Date(nowMs).toISOString(),
    ageMs: 0,
    evidence: {
      branch,
      ready: path.ready,
      bitrateBps: path.inboundBitrateBps,
      readers: path.readerCount,
      frameErrors: path.frameErrors
    }
  };
}

const OFF_EXPECTATION: CourtExpectation = {
  coveragePhase: "OFF",
  mediaExpectation: "OFF",
  broadcastExpectation: "OFF",
  commentaryExpectation: "NONE",
  scoringExpectation: "NONE",
  overrideExpiresAt: null
};

const OFF_NOTIFICATION_HEALTH: NotificationHealth = {
  state: "NOT_APPLICABLE",
  pushover: { configured: false, lastSuccessAt: null, lastFailureAt: null },
  twilioSms: { configured: false, lastSuccessAt: null, lastFailureAt: null }
};


function age(timestamp: string | null, nowMs: number): number | null {
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}
