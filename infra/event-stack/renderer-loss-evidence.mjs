import { productionSnapshotProblems } from "./production-soak.mjs";
import { validateRendererBinding } from "./renderer-binding.mjs";

const MAX_TRANSITION_MS = 60_000;

export function rendererLossSnapshotProblems({ phase, snapshot, previous = null, baseline = null, profiles, venue, camera, renderer, nowMs = Date.now() }) {
  if (!new Set(["baseline", "outage", "recovery"]).has(phase)) throw new Error("renderer-loss phase is invalid");
  const binding = validateRendererBinding(renderer);
  const expectedScoreProblem = `Camera ${camera} scoreboard overlay is not loaded, connected, and current`;
  let problems = productionSnapshotProblems(snapshot, profiles, venue, previous, nowMs);
  if (phase === "outage") {
    problems = problems.filter((problem) => problem !== expectedScoreProblem && problem !== "monitor has an active incident");
    problems.push(...outageIncidentProblems(snapshot, camera));
  }
  problems.push(...youtubeSnapshotProblems(snapshot, venue.activeCameras));

  const browser = court(snapshot, camera)?.browser ?? null;
  if (!browser) return unique([...problems, `Camera ${camera} renderer-loss browser is missing`]);
  if (browser.pageBuildVersion !== binding.gitSha) problems.push(`Camera ${camera} renderer-loss browser build changed`);
  if (baseline) {
    const expectedBrowser = court(baseline, camera)?.browser ?? null;
    if (!expectedBrowser) problems.push(`Camera ${camera} renderer-loss baseline browser is missing`);
    else {
      if (browser.pageLoadedAt !== expectedBrowser.pageLoadedAt || browser.pageBuildVersion !== expectedBrowser.pageBuildVersion || browser.configurationVersion !== expectedBrowser.configurationVersion) {
        problems.push(`Camera ${camera} renderer-loss browser identity changed`);
      }
      if (phase === "outage") problems.push(...lastGoodScoreProblems(expectedBrowser.scoreRender, browser.scoreRender, camera));
    }
  }
  if (phase === "outage" && browser.scoreRender.connected) problems.push(`Camera ${camera} renderer origin remained connected during the fault`);
  if (phase !== "outage" && (!browser.scoreRender.loaded || !browser.scoreRender.connected || browser.scoreRender.stale || browser.scoreRender.frozen || browser.scoreRender.domMismatchReason)) {
    problems.push(`Camera ${camera} renderer score did not return healthy`);
  }
  return unique(problems);
}

export function evaluateRendererLossRehearsal({ event, generationId, camera, renderer, profile, target, fault, dnsDuringFault, restore, baseline, outage, recovery, completedAt }) {
  const binding = validateRendererBinding(renderer);
  const problems = [];
  if (typeof event !== "string" || event !== target?.event || generationId == null) problems.push("renderer-loss event binding is invalid");
  if (target?.camera !== camera || target?.rendererGitSha !== binding.gitSha || target?.rendererDeploymentId !== binding.deploymentId || target?.origin !== binding.origin) problems.push("renderer-loss target is not bound to the approved renderer");
  if (!/^EG_[A-Za-z0-9]+$/.test(target?.egressId ?? "") || typeof target?.destinationId !== "string" || typeof target?.outputGeneration !== "string") problems.push("renderer-loss Egress owner binding is incomplete");
  if (fault?.status !== "FAULTED") problems.push("renderer-loss fault was not durably observed");
  if (dnsDuringFault?.passed !== true) problems.push("renderer origin DNS changed during the fault window");
  if (restore?.status !== "HEALTHY") problems.push("renderer-loss firewall state did not restore to healthy");
  for (const phase of [baseline, outage, recovery]) if (phase?.passed !== true) problems.push(`${phase?.label ?? "unknown"} renderer-loss evidence did not pass`);

  const baselineBrowser = phaseBrowser(baseline, "first", camera);
  const outageBrowser = phaseBrowser(outage, "final", camera);
  const recoveryBrowser = phaseBrowser(recovery, "final", camera);
  if (!baselineBrowser || !outageBrowser || !recoveryBrowser) problems.push("renderer-loss browser endpoint evidence is incomplete");
  else {
    for (const current of [outageBrowser, recoveryBrowser]) {
      if (current.pageLoadedAt !== baselineBrowser.pageLoadedAt || current.pageBuildVersion !== baselineBrowser.pageBuildVersion || current.configurationVersion !== baselineBrowser.configurationVersion) problems.push("renderer-loss browser identity changed end to end");
      for (const field of ["framesDropped", "freezeCount", "totalFreezesDurationMs", "packetsLost", "reconnectCount", "reloadCount"]) {
        if (!Number.isFinite(baselineBrowser.video[field]) || current.video[field] !== baselineBrowser.video[field]) problems.push(`renderer-loss browser ${field} changed end to end`);
      }
    }
    const elapsedMs = Date.parse(recoveryBrowser.receivedAt) - Date.parse(baselineBrowser.receivedAt);
    const frameDelta = recoveryBrowser.video.framesRendered - baselineBrowser.video.framesRendered;
    const aggregateFps = elapsedMs > 0 ? frameDelta * 1_000 / elapsedMs : NaN;
    const expectedFps = profile?.framesPerSecond;
    const tolerance = expectedFps === 60 ? 1 : 0.5;
    if (!Number.isFinite(aggregateFps) || !Number.isFinite(expectedFps) || Math.abs(aggregateFps - expectedFps) > tolerance) problems.push(`renderer-loss aggregate rendered cadence was ${Number.isFinite(aggregateFps) ? aggregateFps.toFixed(3) : "unavailable"}fps`);
  }

  const detectionMs = timestampDelta(outage?.startedAt, fault?.injectedAt);
  const recoveryMs = timestampDelta(recovery?.startedAt, restore?.restoredAt);
  if (!boundedTransition(detectionMs)) problems.push(`renderer-loss detection took ${String(detectionMs)}ms`);
  if (!boundedTransition(recoveryMs)) problems.push(`renderer-loss recovery took ${String(recoveryMs)}ms`);
  const aggregateElapsedMs = baselineBrowser && recoveryBrowser ? Date.parse(recoveryBrowser.receivedAt) - Date.parse(baselineBrowser.receivedAt) : null;
  const aggregateFps = baselineBrowser && recoveryBrowser && aggregateElapsedMs > 0
    ? (recoveryBrowser.video.framesRendered - baselineBrowser.video.framesRendered) * 1_000 / aggregateElapsedMs
    : null;
  return {
    schemaVersion: 1,
    classification: problems.length ? "FAIL" : "PASS",
    event,
    generationId,
    camera,
    gateId: target?.gateId ?? null,
    renderer: { origin: binding.origin, deploymentId: binding.deploymentId, gitSha: binding.gitSha },
    egressOwner: { egressId: target?.egressId ?? null, destinationId: target?.destinationId ?? null, outputGeneration: target?.outputGeneration ?? null },
    startedAt: baseline?.startedAt ?? null,
    completedAt,
    transitions: { rendererUnavailableMs: detectionMs, rendererRecoveredMs: recoveryMs, maximumMs: MAX_TRANSITION_MS },
    browser: baselineBrowser && recoveryBrowser ? {
      pageLoadedAt: baselineBrowser.pageLoadedAt,
      pageBuildVersion: baselineBrowser.pageBuildVersion,
      configurationVersion: baselineBrowser.configurationVersion,
      baselineFramesRendered: baselineBrowser.video.framesRendered,
      recoveredFramesRendered: recoveryBrowser.video.framesRendered,
      aggregateFramesPerSecond: aggregateFps,
      reconnectCount: recoveryBrowser.video.reconnectCount,
      reloadCount: recoveryBrowser.video.reloadCount,
      framesDropped: recoveryBrowser.video.framesDropped,
      freezeCount: recoveryBrowser.video.freezeCount,
      packetsLost: recoveryBrowser.video.packetsLost
    } : null,
    phases: Object.fromEntries([baseline, outage, recovery].filter(Boolean).map((phase) => [phase.label, summarizePhase(phase)])),
    fault,
    dnsDuringFault,
    restore,
    problems: unique(problems)
  };
}

function lastGoodScoreProblems(expected, current, camera) {
  const problems = [];
  if (!current?.loaded || current.connected) problems.push(`Camera ${camera} did not hold a loaded disconnected score during renderer loss`);
  if (current?.domMismatchReason || current?.sourceSignature == null || current.renderedSignature == null || current.sourceSignature !== current.renderedSignature) problems.push(`Camera ${camera} last-good score DOM is not aligned during renderer loss`);
  for (const field of ["matchId", "phase", "sourceSignature", "renderedSignature", "stateUpdatedAt"]) {
    if (current?.[field] !== expected?.[field]) problems.push(`Camera ${camera} last-good score ${field} changed during renderer loss`);
  }
  return problems;
}

function outageIncidentProblems(snapshot, camera) {
  const unexpected = (snapshot.incidents ?? []).filter((incident) => incident.status !== "resolved" && !(incident.courtNumber === camera && incident.stage === "SCORE_RENDER" && incident.issueCode === "SCOREBUG_STATE_UNAVAILABLE"));
  const target = (snapshot.incidents ?? []).filter((incident) => incident.status !== "resolved" && incident.courtNumber === camera && incident.stage === "SCORE_RENDER" && incident.issueCode === "SCOREBUG_STATE_UNAVAILABLE");
  const problems = [];
  if (unexpected.length) problems.push("renderer-loss fault produced an unrelated active incident");
  if (target.length > 1) problems.push(`Camera ${camera} renderer-loss incident was duplicated`);
  return problems;
}

function youtubeSnapshotProblems(snapshot, activeCameras) {
  const problems = [];
  for (const camera of activeCameras) {
    const value = court(snapshot, camera)?.youtube;
    if (!value || value.state !== "HEALTHY" || value.streamStatus !== "active" || value.healthStatus !== "good" || value.broadcastLifecycle !== "live") {
      problems.push(`Camera ${camera} YouTube monitor state changed during renderer loss`);
    }
  }
  return problems;
}

function phaseBrowser(phase, edge, camera) {
  return court(phase?.[edge]?.monitor, camera)?.browser ?? null;
}

function court(snapshot, camera) {
  const values = (snapshot?.courts ?? []).filter((entry) => entry.courtNumber === camera);
  return values.length === 1 ? values[0] : null;
}

function summarizePhase(phase) {
  return {
    passed: phase.passed,
    startedAt: phase.startedAt,
    completedAt: phase.completedAt,
    stableSamples: phase.stableSamples,
    sampleCount: phase.sampleCount,
    firstObservedAt: phase.first?.observedAt ?? null,
    finalObservedAt: phase.final?.observedAt ?? null
  };
}

function timestampDelta(later, earlier) {
  const value = Date.parse(later) - Date.parse(earlier);
  return Number.isFinite(value) ? value : null;
}

function boundedTransition(value) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TRANSITION_MS;
}

function unique(values) {
  return [...new Set(values)];
}
