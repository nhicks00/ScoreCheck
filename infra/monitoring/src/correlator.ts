import { MONITORING_CONTRACT_VERSION, worstHealthState, type AgentSnapshot, type BrowserHeartbeatSnapshot, type BrowserThumbnailMetadata, type ControlPlaneSnapshot, type CourtExpectation, type DeadManHealth, type FfmpegBranchSnapshot, type HealthState, type IncidentSnapshot, type MediaPathSnapshot, type MonitoringFaultGate, type MonitoringSilence, type MonitorSnapshot, type MonitoringStage, type NotificationHealth, type StageHealth, type YouTubeMonitorSnapshot } from "./contracts.js";
import type { AgentTarget } from "./config.js";
import { faultGateExpectation } from "./faultGateControl.js";

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
  deadMan: DeadManHealth = OFF_DEAD_MAN_HEALTH,
  thumbnails = new Map<number, BrowserThumbnailMetadata>(),
  silences: MonitoringSilence[] = [],
  faultGates: MonitoringFaultGate[] = []
): MonitorSnapshot {
  const agents = targets.map((target) => {
    const runtime = runtimes.get(target.id);
    const ageMs = age(runtime?.lastSeenAt ?? null, nowMs);
    return {
      agentId: target.id,
      role: target.role,
      assignedCourts: runtime?.snapshot?.assignedCourts.length ? runtime.snapshot.assignedCourts : target.assignedCourts,
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
    const egressAgent = agents.find((agent) => agent.role === "compositor" && agent.assignedCourts.includes(courtNumber)) ?? null;
    const faultGate = faultGates.find((gate) => gate.courtNumber === courtNumber) ?? null;
    const productionExpectation = competition?.expectation ?? OFF_EXPECTATION;
    const expectation = faultGate ? faultGateExpectation(faultGate) : productionExpectation;
    const observedStages = [
      contentAwareRawStage(pathStage("RAW_INGEST", "raw", byBranch.raw ?? null, nowMs, expectation), browser, expectation, nowMs),
      pathStage("PREVIEW", "preview", byBranch.preview ?? null, nowMs, productionExpectation),
      pathStage("PROGRAM_PATH", "program", byBranch.program ?? null, nowMs, productionExpectation),
      programBrowserStage(browser, nowMs, productionExpectation),
      commentaryStage(browser, nowMs, productionExpectation),
      scoreSourceStage(competition, controlPlane, nowMs, productionExpectation),
      scoreRenderStage(browser, nowMs, productionExpectation),
      egressStage(egressAgent, productionExpectation),
      youtubeStage(youtube, youtubeMonitor, nowMs, productionExpectation)
    ];
    const stages = applyCourtIncidents(observedStages, incidents, courtNumber, egressAgent?.agentId ?? null, nowMs);
    return {
      courtNumber,
      overallState: worstHealthState(stages.map((stage) => stage.state)),
      stages,
      paths: byBranch,
      ffmpeg,
      browser,
      competition,
      expectation,
      faultGate,
      youtube,
      thumbnail: thumbnails.get(courtNumber) ?? null,
      egressHost: egressAgent?.agentId ?? null
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
    deadMan,
    courts,
    agents,
    incidents,
    silences,
    faultGates
  };
}

function applyCourtIncidents(stages: StageHealth[], incidents: IncidentSnapshot[], courtNumber: number, egressHost: string | null, nowMs: number): StageHealth[] {
  const active = incidents.filter((incident) => incident.status !== "resolved" && (
    incident.courtNumber === courtNumber
    || (incident.courtNumber == null && incident.stage === "EGRESS" && incident.rootDependency === egressHost)
  ));
  if (active.length === 0) return stages;
  return stages.map((stageHealth) => {
    const candidates = active.filter((incident) => incident.stage === stageHealth.stage);
    if (candidates.length === 0) return stageHealth;
    const incident = candidates.sort((left, right) => severityRank(right.severity) - severityRank(left.severity))[0];
    if (!incident) return stageHealth;
    const incidentState: HealthState = incident.severity === "critical" ? "CRITICAL" : incident.severity === "warning" ? "DEGRADED" : stageHealth.state;
    if (worstHealthState([stageHealth.state, incidentState]) !== incidentState) return stageHealth;
    return {
      ...stageHealth,
      state: incidentState,
      severity: incident.severity,
      issueCode: incident.issueCode,
      summary: incident.summary,
      firstAction: incident.firstAction,
      observedAt: incident.lastObservedAt,
      ageMs: age(incident.lastObservedAt, nowMs),
      evidence: { ...stageHealth.evidence, incidentId: incident.id, rootDependency: incident.rootDependency }
    };
  });
}

function egressStage(agent: MonitorSnapshot["agents"][number] | null, expectation: CourtExpectation): StageHealth {
  if (expectation.broadcastExpectation === "OFF") return expectedOffStage("EGRESS", "Egress output is not expected.");
  if (!agent) {
    return stage("EGRESS", "CRITICAL", "critical", "EGRESS_HOST_UNASSIGNED", "No compositor host is assigned to this court.", "Assign the court to an instrumented compositor before starting coverage.", null, null, {});
  }
  if (agent.state === "UNKNOWN") {
    return stage("EGRESS", "CRITICAL", "critical", "EGRESS_HOST_UNREACHABLE", `Compositor ${agent.agentId} telemetry is unavailable.`, "Check the compositor host and its private monitoring agent.", agent.lastSeenAt, agent.ageMs, { host: agent.agentId });
  }
  const egress = agent.nativeServices?.egress;
  const endpointDown = agent.nativeServices?.endpoints.some((endpoint) => endpoint.service.startsWith("egress-") && !endpoint.up) ?? false;
  if (!egress || endpointDown) {
    return stage("EGRESS", "CRITICAL", "critical", "EGRESS_WORKER_UNAVAILABLE", `Egress worker ${agent.agentId} is unavailable.`, "Inspect Egress health, Redis and LiveKit control connectivity on the assigned compositor.", agent.lastSeenAt, agent.ageMs, { host: agent.agentId, endpointDown });
  }
  const multiplicity = egress.activeWebRequests > egress.maximumWebRequests;
  const idleAdmissionBlocked = egress.activeWebRequests === 0 && !egress.canAcceptRequest;
  const egressState: HealthState = multiplicity ? "CRITICAL" : idleAdmissionBlocked ? "DEGRADED" : "HEALTHY";
  const severity = multiplicity ? "critical" : idleAdmissionBlocked ? "warning" : "info";
  const issueCode = multiplicity ? "EGRESS_REQUEST_MULTIPLICITY" : idleAdmissionBlocked ? "EGRESS_ADMISSION_BLOCKED" : null;
  const summary = multiplicity
    ? `Egress worker ${agent.agentId} is running ${egress.activeWebRequests} web requests above its configured maximum of ${egress.maximumWebRequests}.`
    : idleAdmissionBlocked
      ? `Idle Egress worker ${agent.agentId} cannot admit a court.`
      : egress.activeWebRequests >= egress.maximumWebRequests
        ? `Egress worker ${agent.agentId} is processing output at its configured capacity.`
        : `Egress worker ${agent.agentId} is healthy and ${egress.idle ? "idle" : "processing output"}.`;
  return stage(
    "EGRESS",
    egressState,
    severity,
    issueCode,
    summary,
    multiplicity
      ? "Stop the unintended extra Egress request and verify the compositor admission lock."
      : idleAdmissionBlocked
        ? "Inspect Egress availability and resource admission before starting coverage."
        : null,
    agent.lastSeenAt,
    agent.ageMs,
    {
      host: agent.agentId,
      idle: egress.idle,
      canAcceptRequest: egress.canAcceptRequest,
      nativeCanAcceptRequest: egress.nativeCanAcceptRequest,
      activeWebRequests: egress.activeWebRequests,
      maximumWebRequests: egress.maximumWebRequests,
      cpuLoadRatio: egress.cpuLoadRatio,
      memoryLoadRatio: egress.memoryLoadRatio,
      cgroupMemoryBytes: egress.cgroupMemoryBytes
    }
  );
}

function severityRank(severity: IncidentSnapshot["severity"]): number {
  return severity === "critical" ? 3 : severity === "warning" ? 2 : 1;
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
  if (expectation.broadcastExpectation === "OFF") {
    return expectedOffStage("PROGRAM_BROWSER", "Program browser is not expected.");
  }
  if (!browser || timing.stale) {
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
      jitterMs: video.jitterMs,
      jitterBufferMs: video.jitterBufferMs,
      packetsLost: video.packetsLost,
      packetsReceived: video.packetsReceived,
      framesReceived: video.framesReceived,
      framesDecoded: video.framesDecoded,
      keyFramesDecoded: video.keyFramesDecoded,
      framesDropped: video.framesDropped,
      freezeCount: video.freezeCount,
      totalFreezesDurationMs: video.totalFreezesDurationMs,
      lastPacketAgeMs: video.lastPacketAgeMs,
      nackCount: video.nackCount,
      pliCount: video.pliCount,
      firCount: video.firCount,
      reconnects: video.reconnectCount,
      reloads: video.reloadCount
    }
  };
}

function commentaryStage(browser: BrowserHeartbeatSnapshot | null, nowMs: number, expectation: CourtExpectation): StageHealth {
  const timing = browserTiming(browser, nowMs);
  if (expectation.commentaryExpectation === "NONE") {
    return stage("COMMENTARY", "NOT_APPLICABLE", "info", null, "Commentary is not expected.", null, null, timing.ageMs, {});
  }
  if (!browser || timing.stale) {
    return missingBrowserStage("COMMENTARY", timing, expectation.commentaryExpectation === "REQUIRED");
  }
  const commentary = browser.commentary;
  if (!commentary.configured) {
    return stage("COMMENTARY", "NOT_APPLICABLE", "info", null, "Commentary is not configured for this scene.", null, browser.sampledAt, timing.ageMs, {});
  }
  if (!commentary.roomConnected) {
    const required = expectation.commentaryExpectation === "REQUIRED";
    return stage("COMMENTARY", required ? "CRITICAL" : "DEGRADED", required ? "critical" : "warning", "COMMENTARY_ROOM_DISCONNECTED", "Program browser is disconnected from the commentary room.", "Check LiveKit reachability and the browser room connection.", browser.sampledAt, timing.ageMs, {
      participants: commentary.participantCount,
      audioTracks: commentary.audioTrackCount
    });
  }
  const requiredTrackMissing = expectation.commentaryExpectation === "REQUIRED" && commentary.audioTrackCount === 0;
  const packetTotal = (commentary.packetsLost ?? 0) + (commentary.packetsReceived ?? 0);
  const packetLossRatio = packetTotal > 0 ? (commentary.packetsLost ?? 0) / packetTotal : null;
  const syncGapMs = commentary.targetDelayMs != null && commentary.appliedDelayMs != null
    ? Math.abs(commentary.targetDelayMs - commentary.appliedDelayMs)
    : null;
  const muted = commentary.mutedAudioTrackCount > 0;
  const clipping = (commentary.clippedSampleRatio ?? 0) > 0.05;
  const silent = commentary.audioTrackCount > 0 && (commentary.secondsSinceAudio ?? 0) > 60;
  const networkDegraded = (commentary.jitterBufferMs ?? 0) > 300;
  const syncDegraded = commentary.audioTrackCount > 0 && (commentary.syncStatus !== "locked" || (syncGapMs ?? 0) > 250);
  const degraded = muted || clipping || silent || networkDegraded || syncDegraded;
  const issueCode = requiredTrackMissing ? "COMMENTARY_TRACK_MISSING"
    : muted ? "COMMENTARY_TRACK_MUTED"
      : clipping ? "COMMENTARY_AUDIO_CLIPPING"
        : silent ? "COMMENTARY_AUDIO_SILENT"
          : networkDegraded ? "COMMENTARY_JITTER_HIGH"
            : syncDegraded ? "COMMENTARY_SYNC_UNLOCKED" : null;
  return stage(
    "COMMENTARY",
    requiredTrackMissing ? "CRITICAL" : degraded ? "DEGRADED" : "HEALTHY",
    requiredTrackMissing ? "critical" : degraded ? "warning" : "info",
    issueCode,
    requiredTrackMissing ? "Required commentary has no subscribed audio track."
      : commentary.audioTrackCount > 0
        ? degraded ? "Commentary audio quality, network, or synchronization is degraded." : "Commentary audio and synchronization are healthy."
      : "Commentary room is healthy with no active audio track.",
    requiredTrackMissing ? "Confirm the commentator is connected, unmuted, and publishing an audio track."
      : degraded ? "Check mute state, levels, clipping, packet loss, jitter, and synchronization evidence." : null,
    browser.sampledAt,
    timing.ageMs,
    {
      participants: commentary.participantCount,
      audioTracks: commentary.audioTrackCount,
      mutedTracks: commentary.mutedAudioTrackCount,
      rmsDb: commentary.rmsDb,
      peakDb: commentary.peakDb,
      clippedSampleRatio: commentary.clippedSampleRatio,
      secondsSinceAudio: commentary.secondsSinceAudio,
      cumulativePacketLossRatio: packetLossRatio,
      jitterBufferMs: commentary.jitterBufferMs,
      syncStatus: commentary.syncStatus,
      syncGapMs,
      appliedDelayMs: commentary.appliedDelayMs,
      clockRttMs: commentary.clockRttMs,
      syncSampleAgeMs: commentary.syncSampleAgeMs
    }
  );
}

function contentAwareRawStage(
  raw: StageHealth,
  browser: BrowserHeartbeatSnapshot | null,
  expectation: CourtExpectation,
  nowMs: number
): StageHealth {
  if (!browser || expectation.coveragePhase !== "LIVE_MATCH" || raw.state !== "HEALTHY") return raw;
  const visual = browser.visual;
  const visualAgeMs = age(visual.sampledAt, nowMs);
  if (visual.sampledAt && visualAgeMs != null && visualAgeMs <= 15_000) {
    if (visual.blackDurationMs > 20_000) {
      return stage("RAW_INGEST", "CRITICAL", "critical", "CAMERA_CONTENT_BLACK", "Camera picture is persistently black or covered while encoded frames continue.", "Inspect the physical camera view and lens before changing network or encoder settings.", visual.sampledAt, visualAgeMs, visualEvidence(browser));
    }
    if (visual.frozenDurationMs > 15_000) {
      return stage("RAW_INGEST", "CRITICAL", "critical", "FULL_BITRATE_VISUAL_FREEZE", "Camera picture is repeating while transport and rendered frames continue.", "Check the camera encoder and source capture; do not treat healthy bitrate as healthy video content.", visual.sampledAt, visualAgeMs, visualEvidence(browser));
    }
    if (visual.frozenDurationMs > 5_000) {
      return stage("RAW_INGEST", "DEGRADED", "warning", "VISUAL_FREEZE_SUSPECTED", "Camera picture has very low inter-frame change while frames continue.", "Confirm on the live thumbnail and watch whether motion returns before escalating.", visual.sampledAt, visualAgeMs, visualEvidence(browser));
    }
  }
  const audio = browser.commentary;
  if (!audio.cameraTrackPresent) {
    return stage("RAW_INGEST", "DEGRADED", "warning", "CAMERA_AUDIO_TRACK_MISSING", "Camera video is present but its audio track is missing.", "Check the camera audio input and encoder audio configuration.", browser.sampledAt, age(browser.sampledAt, nowMs), visualEvidence(browser));
  }
  if ((audio.secondsSinceCameraAudio ?? 0) > 60) {
    return stage("RAW_INGEST", "DEGRADED", "warning", "CAMERA_AUDIO_SILENT", "Camera audio track is present but has remained silent.", "Check the camera microphone, gain, and physical audio source.", browser.sampledAt, age(browser.sampledAt, nowMs), visualEvidence(browser));
  }
  if ((audio.cameraClippedSampleRatio ?? 0) > 0.05) {
    return stage("RAW_INGEST", "DEGRADED", "warning", "CAMERA_AUDIO_CLIPPING", "Camera audio is clipping heavily.", "Reduce camera input or program camera gain and confirm peak level recovery.", browser.sampledAt, age(browser.sampledAt, nowMs), visualEvidence(browser));
  }
  return raw;
}

function visualEvidence(browser: BrowserHeartbeatSnapshot): StageHealth["evidence"] {
  return {
    renderedFps: browser.video.framesPerSecond,
    meanLuma: browser.visual.meanLuma,
    lumaVariance: browser.visual.lumaVariance,
    darkPixelRatio: browser.visual.darkPixelRatio,
    frameDifference: browser.visual.frameDifference,
    frozenDurationMs: browser.visual.frozenDurationMs,
    blackDurationMs: browser.visual.blackDurationMs,
    cameraTrackPresent: browser.commentary.cameraTrackPresent,
    cameraRmsDb: browser.commentary.cameraRmsDb,
    cameraPeakDb: browser.commentary.cameraPeakDb,
    cameraClippedSampleRatio: browser.commentary.cameraClippedSampleRatio,
    secondsSinceCameraAudio: browser.commentary.secondsSinceCameraAudio
  };
}

function scoreRenderStage(browser: BrowserHeartbeatSnapshot | null, nowMs: number, expectation: CourtExpectation): StageHealth {
  const timing = browserTiming(browser, nowMs);
  if (expectation.scoringExpectation === "NONE" && expectation.broadcastExpectation === "OFF") {
    return stage("SCORE_RENDER", "NOT_APPLICABLE", "info", null, "Score rendering is not expected.", null, null, timing.ageMs, {});
  }
  if (!browser || timing.stale) {
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
  if (expectation.scoringExpectation === "LIVE" && controlPlane?.worker.state !== "HEALTHY") {
    const conclusivelyFailed = controlPlane?.worker.state === "CRITICAL";
    return stage(
      "SCORE_SOURCE",
      conclusivelyFailed ? "CRITICAL" : "UNKNOWN",
      conclusivelyFailed ? "critical" : "warning",
      "SCORE_WORKER_UNAVAILABLE",
      "Shared score worker health is unavailable while live scoring is expected.",
      "Check the shared worker heartbeat and poller errors; do not repair courts independently.",
      controlPlane?.worker.lastSeenAt ?? controlPlane?.observedAt ?? null,
      controlPlane?.worker.ageMs ?? age(controlPlane?.observedAt ?? null, nowMs),
      { workerState: controlPlane?.worker.state ?? "UNKNOWN", workerStatus: controlPlane?.worker.status ?? null }
    );
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
      frameErrors: path.frameErrors,
      sourceProtocol: path.sourceProtocol,
      sourceMode: path.sourceMode,
      videoCodec: path.videoCodec,
      videoWidth: path.videoWidth,
      videoHeight: path.videoHeight,
      transportRttMs: path.transport?.rttMs ?? null,
      transportPacketsLost: path.transport?.packetsLost ?? null,
      transportPacketsReceived: path.transport?.packetsReceived ?? null
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

const OFF_DEAD_MAN_CHECK = {
  configured: false,
  mode: "NOT_CONFIGURED" as const,
  lastSuccessAt: null,
  lastFailureAt: null
};

const OFF_DEAD_MAN_HEALTH: DeadManHealth = {
  state: "NOT_APPLICABLE",
  baseline: { ...OFF_DEAD_MAN_CHECK },
  active: { ...OFF_DEAD_MAN_CHECK },
  phoneChannel: {
    configured: false,
    state: "NOT_APPLICABLE",
    baselineAttached: null,
    activeAttached: null,
    lastSuccessAt: null,
    lastFailureAt: null
  }
};


function age(timestamp: string | null, nowMs: number): number | null {
  const parsed = Date.parse(timestamp ?? "");
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}
