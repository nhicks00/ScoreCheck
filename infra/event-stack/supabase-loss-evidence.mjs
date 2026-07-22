import { productionSnapshotProblems } from "./production-soak.mjs";
import { validateRendererBinding } from "./renderer-binding.mjs";

const MAX_TRANSITION_MS = 60_000;
const QUALITY_FIELDS = Object.freeze(["framesDropped", "freezeCount", "totalFreezesDurationMs", "packetsLost", "reconnectCount", "reloadCount"]);

export function supabaseLossSnapshotProblems({ phase, snapshot, dependency, previous = null, baseline = null, baselineDependency = null, profiles, venue, camera, renderer, nowMs = Date.now() }) {
  if (!new Set(["baseline", "outage", "recovery"]).has(phase)) throw new Error("Supabase-loss phase is invalid");
  const binding = validateRendererBinding(renderer);
  const expectedScoreProblem = `Camera ${camera} scoreboard overlay is not loaded, connected, and current`;
  let problems = productionSnapshotProblems(snapshot, profiles, venue, previous, nowMs);
  if (phase === "outage") {
    problems = problems.filter((problem) => problem !== expectedScoreProblem && problem !== "monitor has an active incident");
    problems.push(...outageIncidentProblems(snapshot, camera));
  }
  problems.push(...youtubeSnapshotProblems(snapshot, venue.activeCameras));
  problems.push(...dependencyProblems(phase, dependency, baselineDependency));

  const browser = court(snapshot, camera)?.browser ?? null;
  if (!browser) return unique([...problems, `Camera ${camera} Supabase-loss browser is missing`]);
  if (browser.pageBuildVersion !== binding.gitSha) problems.push(`Camera ${camera} Supabase-loss browser build changed`);
  if (baseline) {
    const expectedBrowser = court(baseline, camera)?.browser ?? null;
    if (!expectedBrowser) problems.push(`Camera ${camera} Supabase-loss baseline browser is missing`);
    else {
      if (browser.pageLoadedAt !== expectedBrowser.pageLoadedAt || browser.pageBuildVersion !== expectedBrowser.pageBuildVersion || browser.configurationVersion !== expectedBrowser.configurationVersion) {
        problems.push(`Camera ${camera} Supabase-loss browser identity changed`);
      }
      for (const field of QUALITY_FIELDS) if (browser.video?.[field] !== expectedBrowser.video?.[field]) problems.push(`Camera ${camera} Supabase-loss browser ${field} changed`);
      if (phase === "outage") problems.push(...lastGoodScoreProblems(expectedBrowser.scoreRender, browser.scoreRender, camera));
    }
  }
  if (phase !== "outage" && (!browser.scoreRender.loaded || !browser.scoreRender.connected || browser.scoreRender.stale || browser.scoreRender.frozen || browser.scoreRender.domMismatchReason)) {
    problems.push(`Camera ${camera} Supabase-loss score did not return healthy`);
  }
  return unique(problems);
}

export function evaluateSupabaseLossRehearsal({ event, generationId, camera, renderer, profile, target, prepare, fault, restore, cleanup, baseline, outage, recovery, completedAt }) {
  const binding = validateRendererBinding(renderer);
  const problems = [];
  if (typeof event !== "string" || event !== target?.event || generationId !== target?.generationId) problems.push("Supabase-loss event binding is invalid");
  if (target?.publicOrigin !== `https://${target?.publicHost}${target?.pathPrefix}` || target?.pathPrefix !== `/_scorecheck-supabase-fault/${event}/`) problems.push("Supabase-loss public dependency binding is invalid");
  if (prepare?.status !== "HEALTHY") problems.push("Supabase-loss proxy was not prepared healthy");
  if (fault?.status !== "FAULTED") problems.push("Supabase-loss fault was not durably observed");
  if (restore?.status !== "HEALTHY") problems.push("Supabase-loss dependency did not restore healthy");
  if (cleanup?.status !== "CLEAN") problems.push("Supabase-loss temporary TLS route and sidecar were not removed");
  for (const phase of [baseline, outage, recovery]) if (phase?.passed !== true) problems.push(`${phase?.label ?? "unknown"} Supabase-loss evidence did not pass`);
  const baselineDependency = baseline?.final?.dependency ?? null;
  problems.push(...dependencyProblems("baseline", baselineDependency, null));
  problems.push(...dependencyProblems("outage", outage?.final?.dependency ?? null, baselineDependency));
  problems.push(...dependencyProblems("recovery", recovery?.final?.dependency ?? null, baselineDependency));

  const baselineBrowser = phaseBrowser(baseline, "first", camera);
  const outageBrowser = phaseBrowser(outage, "final", camera);
  const recoveryBrowser = phaseBrowser(recovery, "final", camera);
  if (!baselineBrowser || !outageBrowser || !recoveryBrowser) problems.push("Supabase-loss browser endpoint evidence is incomplete");
  else {
    for (const current of [outageBrowser, recoveryBrowser]) {
      if (current.pageLoadedAt !== baselineBrowser.pageLoadedAt || current.pageBuildVersion !== baselineBrowser.pageBuildVersion || current.configurationVersion !== baselineBrowser.configurationVersion) problems.push("Supabase-loss browser identity changed end to end");
      for (const field of QUALITY_FIELDS) if (!Number.isFinite(baselineBrowser.video[field]) || current.video[field] !== baselineBrowser.video[field]) problems.push(`Supabase-loss browser ${field} changed end to end`);
    }
    const elapsedMs = Date.parse(recoveryBrowser.receivedAt) - Date.parse(baselineBrowser.receivedAt);
    const frameDelta = recoveryBrowser.video.framesRendered - baselineBrowser.video.framesRendered;
    const aggregateFps = elapsedMs > 0 ? frameDelta * 1_000 / elapsedMs : NaN;
    const expectedFps = profile?.framesPerSecond;
    const tolerance = expectedFps === 60 ? 1 : 0.5;
    if (!Number.isFinite(aggregateFps) || !Number.isFinite(expectedFps) || Math.abs(aggregateFps - expectedFps) > tolerance) problems.push(`Supabase-loss aggregate rendered cadence was ${Number.isFinite(aggregateFps) ? aggregateFps.toFixed(3) : "unavailable"}fps`);
  }

  const detectionMs = timestampDelta(outage?.startedAt, fault?.faultedAt);
  const recoveryMs = timestampDelta(recovery?.startedAt, restore?.restoredAt);
  if (!boundedTransition(detectionMs)) problems.push(`Supabase-loss detection took ${String(detectionMs)}ms`);
  if (!boundedTransition(recoveryMs)) problems.push(`Supabase-loss recovery took ${String(recoveryMs)}ms`);
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
    dependency: {
      publicOrigin: target?.publicOrigin ?? null,
      upstreamHostname: safeHostname(target?.upstreamOrigin),
      baseline: summarizeDependency(baseline?.final?.dependency),
      outage: summarizeDependency(outage?.final?.dependency),
      recovery: summarizeDependency(recovery?.final?.dependency)
    },
    startedAt: baseline?.startedAt ?? null,
    completedAt,
    transitions: { dependencyUnavailableMs: detectionMs, dependencyRecoveredMs: recoveryMs, maximumMs: MAX_TRANSITION_MS },
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
    prepare,
    fault,
    restore,
    cleanup,
    problems: unique(problems)
  };
}

function dependencyProblems(phase, dependency, baseline) {
  const service = dependency?.service;
  const counters = service?.counters;
  const initial = baseline?.service?.counters;
  const problems = [];
  const expected = phase === "outage" ? "FAULTED" : "HEALTHY";
  if (dependency?.status !== expected || service?.status !== expected) return [`Supabase-loss dependency is not ${expected.toLowerCase()}`];
  if (!counters) return ["Supabase-loss dependency counters are missing"];
  if (phase === "baseline") {
    if (counters.httpRequestsForwarded < 1) problems.push("Supabase-loss baseline did not traverse authoritative HTTP repair");
    if (counters.webSocketsForwarded < 1 || counters.activeWebSockets !== 1) problems.push("Supabase-loss baseline did not traverse exactly one Realtime socket");
    if (counters.faultCount !== 0 || counters.restoreCount !== 0 || counters.requestsRejectedDuringFault !== 0) problems.push("Supabase-loss baseline counters are not clean");
  } else if (!initial) {
    problems.push("Supabase-loss dependency baseline counters are missing");
  } else if (phase === "outage") {
    if (counters.faultCount !== initial.faultCount + 1 || counters.restoreCount !== initial.restoreCount) problems.push("Supabase-loss fault count is not exact");
    if (counters.requestsRejectedDuringFault <= initial.requestsRejectedDuringFault) problems.push("Supabase-loss outage did not reject an authoritative repair request");
    if (counters.activeHttpRequests !== 0 || counters.pendingWebSocketUpgrades !== 0 || counters.activeWebSockets !== 0) problems.push("Supabase-loss outage retained active dependency connections");
  } else {
    if (counters.faultCount !== initial.faultCount + 1 || counters.restoreCount !== initial.restoreCount + 1) problems.push("Supabase-loss restore count is not exact");
    if (counters.httpRequestsForwarded <= initial.httpRequestsForwarded) problems.push("Supabase-loss recovery did not resume authoritative HTTP repair");
    if (counters.webSocketsForwarded <= initial.webSocketsForwarded || counters.activeWebSockets !== 1) problems.push("Supabase-loss recovery did not re-establish exactly one Realtime socket");
  }
  return problems;
}

function lastGoodScoreProblems(expected, current, camera) {
  const problems = [];
  if (!current?.loaded || current.connected || !current.stale) problems.push(`Camera ${camera} did not hold a loaded disconnected stale score during Supabase loss`);
  if (current?.domMismatchReason || current?.sourceSignature == null || current.renderedSignature == null || current.sourceSignature !== current.renderedSignature) problems.push(`Camera ${camera} last-good score DOM is not aligned during Supabase loss`);
  for (const field of ["matchId", "phase", "sourceSignature", "renderedSignature", "stateUpdatedAt", "frozen"]) {
    if (current?.[field] !== expected?.[field]) problems.push(`Camera ${camera} last-good score ${field} changed during Supabase loss`);
  }
  return problems;
}

function outageIncidentProblems(snapshot, camera) {
  const active = (snapshot.incidents ?? []).filter((incident) => incident.status !== "resolved");
  const target = active.filter((incident) => incident.courtNumber === camera && incident.stage === "SCORE_RENDER" && incident.issueCode === "SCOREBUG_STATE_UNAVAILABLE");
  const unexpected = active.filter((incident) => !target.includes(incident));
  const problems = [];
  if (unexpected.length) problems.push("Supabase-loss fault produced an unrelated active incident");
  if (target.length !== 1) problems.push(`Camera ${camera} Supabase-loss incident count was ${target.length}`);
  return problems;
}

function youtubeSnapshotProblems(snapshot, activeCameras) {
  const problems = [];
  for (const camera of activeCameras) {
    const value = court(snapshot, camera)?.youtube;
    if (!value || value.state !== "HEALTHY" || value.streamStatus !== "active" || value.healthStatus !== "good" || value.configurationIssues?.length !== 0 || value.broadcastLifecycle !== "live") {
      problems.push(`Camera ${camera} YouTube monitor state changed during Supabase loss`);
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

function summarizeDependency(value) {
  if (!value) return null;
  const service = value.service ?? value;
  const counters = service.counters;
  return {
    status: value.status ?? service.status,
    faultCount: counters?.faultCount ?? null,
    restoreCount: counters?.restoreCount ?? null,
    httpRequestsForwarded: counters?.httpRequestsForwarded ?? null,
    webSocketsForwarded: counters?.webSocketsForwarded ?? null,
    requestsRejectedDuringFault: counters?.requestsRejectedDuringFault ?? null,
    activeWebSockets: counters?.activeWebSockets ?? null
  };
}

function safeHostname(value) {
  try { return new URL(value).hostname; } catch { return null; }
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
