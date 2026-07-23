import { productionSnapshotProblems } from "./production-soak.mjs";
import { validateRendererBinding } from "./renderer-binding.mjs";

const QUALITY_COUNTERS = ["framesDropped", "freezeCount", "totalFreezesDurationMs", "packetsLost", "reconnectCount", "reloadCount"];

export function overlayExceptionSnapshotProblems({ phase, snapshot, page, previous = null, baseline = null, profiles, venue, camera, renderer, nowMs = Date.now() }) {
  if (!new Set(["baseline", "fault"]).has(phase)) throw new Error("overlay-exception phase is invalid");
  const binding = validateRendererBinding(renderer);
  const expectedScoreProblem = `Camera ${camera} scoreboard overlay is not loaded, connected, and current`;
  let problems = productionSnapshotProblems(snapshot, profiles, venue, previous, nowMs);
  if (phase === "fault") {
    problems = problems.filter((problem) => problem !== expectedScoreProblem && problem !== "monitor has an active incident");
    problems.push(...faultIncidentProblems(snapshot, camera));
  }
  problems.push(...youtubeProblems(snapshot, venue.activeCameras));

  const browser = court(snapshot, camera)?.browser ?? null;
  if (!browser) return unique([...problems, `Camera ${camera} overlay-exception browser is missing`]);
  if (browser.pageBuildVersion !== binding.gitSha) problems.push(`Camera ${camera} overlay-exception browser build changed`);
  const expectedBrowser = baseline ? court(baseline, camera)?.browser ?? null : null;
  if (baseline && !expectedBrowser) problems.push(`Camera ${camera} overlay-exception baseline browser is missing`);
  if (expectedBrowser && (browser.pageLoadedAt !== expectedBrowser.pageLoadedAt || browser.pageBuildVersion !== expectedBrowser.pageBuildVersion || browser.configurationVersion !== expectedBrowser.configurationVersion)) {
    problems.push(`Camera ${camera} overlay-exception browser identity changed`);
  }

  if (phase === "baseline") {
    if (!healthyScoreRender(browser.scoreRender)) problems.push(`Camera ${camera} score render was not healthy before the exception`);
  } else if (!failedScoreRender(browser.scoreRender)) {
    problems.push(`Camera ${camera} score render did not fail transparent after the exception`);
  }

  problems.push(...pageProblems({ page, phase, camera }));
  return unique(problems);
}

export function evaluateOverlayExceptionRehearsal({ event, generationId, camera, renderer, profile, target, owner, prepared, activation, installed, armed, baseline, fault, completed, completedAt }) {
  const binding = validateRendererBinding(renderer);
  const problems = [];
  if (typeof event !== "string" || target?.event !== event || target?.generationId !== generationId) problems.push("overlay-exception event binding is invalid");
  if (target?.camera !== camera || target?.rendererGitSha !== binding.gitSha || target?.rendererDeploymentId !== binding.deploymentId || target?.rendererOrigin !== binding.origin) problems.push("overlay-exception target is not bound to the approved renderer");
  if (owner?.event !== event || owner?.camera !== camera || owner?.rendererGitSha !== binding.gitSha || owner?.rendererDeploymentId !== binding.deploymentId) problems.push("overlay-exception Egress owner binding is incomplete");
  if (!/^EG_[A-Za-z0-9]+$/u.test(owner?.egressId ?? "") || activation?.egressId !== owner?.egressId) problems.push("overlay-exception active Egress identity is incomplete");
  if (prepared?.status !== "PREPARED") problems.push("overlay-exception debug runtime was not prepared");
  if (!installed?.installed || installed.armed || installed.throwCount !== 0 || installed.interceptCount !== 0) problems.push("overlay-exception control was not installed dormant");
  if (!armed?.status?.installed || !armed.status.armed) problems.push("overlay-exception control was not armed");
  if (completed?.status !== "COMPLETE") problems.push("overlay-exception debug runtime was not sealed complete");
  for (const phase of [baseline, fault]) if (phase?.passed !== true) problems.push(`${phase?.label ?? "unknown"} overlay-exception evidence did not pass`);

  const baselineBrowser = phaseBrowser(baseline, "first", camera);
  const faultBrowser = phaseBrowser(fault, "final", camera);
  const baselinePage = baseline?.first?.page ?? null;
  const faultPage = fault?.final?.page ?? null;
  if (!baselineBrowser || !faultBrowser || !baselinePage || !faultPage) {
    problems.push("overlay-exception endpoint evidence is incomplete");
  } else {
    if (faultBrowser.pageLoadedAt !== baselineBrowser.pageLoadedAt || faultBrowser.pageBuildVersion !== baselineBrowser.pageBuildVersion || faultBrowser.configurationVersion !== baselineBrowser.configurationVersion) problems.push("overlay-exception browser identity changed end to end");
    for (const field of QUALITY_COUNTERS) {
      if (!Number.isFinite(baselineBrowser.video?.[field]) || faultBrowser.video?.[field] !== baselineBrowser.video[field]) problems.push(`overlay-exception browser ${field} changed end to end`);
    }
    const elapsedMs = Date.parse(faultBrowser.receivedAt) - Date.parse(baselineBrowser.receivedAt);
    const frameDelta = faultBrowser.video.framesRendered - baselineBrowser.video.framesRendered;
    const aggregateFps = elapsedMs > 0 ? frameDelta * 1_000 / elapsedMs : NaN;
    const expectedFps = profile?.framesPerSecond;
    const tolerance = expectedFps === 60 ? 1 : 0.5;
    if (!Number.isFinite(aggregateFps) || !Number.isFinite(expectedFps) || Math.abs(aggregateFps - expectedFps) > tolerance) problems.push(`overlay-exception aggregate rendered cadence was ${Number.isFinite(aggregateFps) ? aggregateFps.toFixed(3) : "unavailable"}fps`);
    if (!(faultPage.video?.currentTime > baselinePage.video?.currentTime)) problems.push("overlay-exception page video time did not advance");
    if (faultPage.throwCount !== 2 || faultPage.interceptCount < 1 || faultPage.boardPresent || !faultPage.programRootPresent) problems.push("overlay-exception did not produce the bounded transparent scorebug failure");
  }

  const elapsedMs = baselineBrowser && faultBrowser ? Date.parse(faultBrowser.receivedAt) - Date.parse(baselineBrowser.receivedAt) : null;
  const aggregateFps = baselineBrowser && faultBrowser && elapsedMs > 0
    ? (faultBrowser.video.framesRendered - baselineBrowser.video.framesRendered) * 1_000 / elapsedMs
    : null;
  return {
    schemaVersion: 1,
    classification: problems.length ? "FAIL" : "PASS",
    event,
    generationId,
    camera,
    gateId: target?.gateId ?? null,
    renderer: { origin: binding.origin, deploymentId: binding.deploymentId, gitSha: binding.gitSha },
    egressOwner: { egressId: owner?.egressId ?? null, destinationId: owner?.destinationId ?? null, outputGeneration: owner?.outputGeneration ?? null },
    config: { baselineSha256: target?.baselineConfigSha256 ?? null, debugSha256: target?.debugConfigSha256 ?? null },
    startedAt: baseline?.startedAt ?? null,
    completedAt,
    browser: baselineBrowser && faultBrowser ? {
      pageLoadedAt: baselineBrowser.pageLoadedAt,
      pageBuildVersion: baselineBrowser.pageBuildVersion,
      configurationVersion: baselineBrowser.configurationVersion,
      baselineFramesRendered: baselineBrowser.video.framesRendered,
      faultFramesRendered: faultBrowser.video.framesRendered,
      aggregateFramesPerSecond: aggregateFps,
      reconnectCount: faultBrowser.video.reconnectCount,
      reloadCount: faultBrowser.video.reloadCount,
      framesDropped: faultBrowser.video.framesDropped,
      freezeCount: faultBrowser.video.freezeCount,
      packetsLost: faultBrowser.video.packetsLost
    } : null,
    fault: faultPage ? { throwCount: faultPage.throwCount, interceptCount: faultPage.interceptCount, scorebugPresent: faultPage.boardPresent, programRootPresent: faultPage.programRootPresent } : null,
    phases: Object.fromEntries([baseline, fault].filter(Boolean).map((phase) => [phase.label, summarizePhase(phase)])),
    prepared,
    activation: activation ? { egressId: activation.egressId, activatedAt: activation.activatedAt } : null,
    completed,
    problems: unique(problems)
  };
}

function healthyScoreRender(value) {
  return Boolean(value?.loaded && value.connected && !value.stale && !value.frozen && !value.domMismatchReason);
}

function failedScoreRender(value) {
  return Boolean(value && !value.loaded && !value.connected && value.stale && value.frozen && value.phase === "ERROR" && value.sourceSignature == null && value.renderedSignature == null && value.domMismatchReason == null);
}

function pageProblems({ page, phase, camera }) {
  const problems = [];
  if (!page?.installed || !page.programRootPresent) return [`Camera ${camera} overlay-exception page control is unavailable`];
  const video = page.video;
  if (!video || video.paused || video.readyState < 2 || video.width !== 1920 || video.height !== 1080 || !Number.isFinite(video.currentTime)) problems.push(`Camera ${camera} Program video did not remain visibly playable`);
  if (phase === "baseline" && (page.armed || page.throwCount !== 0 || page.interceptCount !== 0 || !page.boardPresent)) problems.push(`Camera ${camera} overlay-exception control was not dormant with a visible scorebug`);
  if (phase === "fault" && (!page.armed || page.throwCount !== 2 || page.interceptCount < 1 || page.boardPresent)) problems.push(`Camera ${camera} overlay exception was not bounded and transparent`);
  return problems;
}

function faultIncidentProblems(snapshot, camera) {
  const active = (snapshot.incidents ?? []).filter((incident) => incident.status !== "resolved");
  const target = active.filter((incident) => incident.courtNumber === camera && incident.stage === "SCORE_RENDER" && incident.issueCode === "SCOREBUG_STATE_UNAVAILABLE");
  const unexpected = active.filter((incident) => !target.includes(incident));
  const problems = [];
  if (target.length !== 1) problems.push(`Camera ${camera} overlay-exception incident count was ${target.length}`);
  if (unexpected.length) problems.push("overlay-exception fault produced an unrelated active incident");
  return problems;
}

function youtubeProblems(snapshot, activeCameras) {
  const problems = [];
  for (const camera of activeCameras) {
    const value = court(snapshot, camera)?.youtube;
    if (!value || value.state !== "HEALTHY" || value.streamStatus !== "active" || value.healthStatus !== "good" || value.broadcastLifecycle !== "live") problems.push(`Camera ${camera} YouTube monitor state changed during the overlay exception`);
  }
  return problems;
}

function phaseBrowser(phase, edge, camera) {
  return court(phase?.[edge]?.monitor, camera)?.browser ?? null;
}

function court(snapshot, camera) {
  const matches = (snapshot?.courts ?? []).filter((entry) => entry.courtNumber === camera);
  return matches.length === 1 ? matches[0] : null;
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

function unique(values) {
  return [...new Set(values)];
}
