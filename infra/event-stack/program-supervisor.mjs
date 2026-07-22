const FAILURE_SAMPLES_BEFORE_RESTART = 6;
const RESTART_COOLDOWN_MS = 10 * 60_000;
const MAX_RESTARTS_PER_GENERATION = 2;
const MAX_BROWSER_AGE_MS = 15_000;

export function initialProgramSupervisor(activeCameras) {
  validateCameras(activeCameras);
  return {
    schemaVersion: 1,
    cameras: Object.fromEntries(activeCameras.map((camera) => [camera, {
      consecutiveFailures: 0,
      restartCount: 0,
      lastRestartAt: null,
      exhausted: false
    }]))
  };
}

export function programSupervisorStep(state, snapshot, activeCameras, nowMs) {
  validateState(state, activeCameras);
  if (!Number.isFinite(nowMs)) throw new Error("program supervisor timestamp is invalid");
  const next = structuredClone(state);
  const actions = [];
  for (const camera of activeCameras) {
    const runtime = next.cameras[camera];
    const status = cameraStatus(snapshot, camera, nowMs);
    if (status !== "browser-failed") {
      runtime.consecutiveFailures = 0;
      continue;
    }
    runtime.consecutiveFailures += 1;
    if (runtime.consecutiveFailures < FAILURE_SAMPLES_BEFORE_RESTART) continue;
    const lastRestartMs = runtime.lastRestartAt ? Date.parse(runtime.lastRestartAt) : -Infinity;
    if (runtime.restartCount >= MAX_RESTARTS_PER_GENERATION) {
      if (!runtime.exhausted) actions.push({ type: "exhausted", camera, reason: "bounded restart limit reached" });
      runtime.exhausted = true;
      continue;
    }
    if (nowMs - lastRestartMs < RESTART_COOLDOWN_MS) continue;
    runtime.restartCount += 1;
    runtime.lastRestartAt = new Date(nowMs).toISOString();
    runtime.consecutiveFailures = 0;
    actions.push({ type: "restart", camera, attempt: runtime.restartCount, reason: "upstream healthy while the program browser remained unavailable" });
  }
  return { state: next, actions };
}

function cameraStatus(snapshot, camera, nowMs) {
  const court = snapshot?.courts?.find((entry) => entry.courtNumber === camera);
  const agent = snapshot?.agents?.find((entry) => entry.role === "compositor" && entry.assignedCourts?.includes(camera));
  const egress = agent?.nativeServices?.egress;
  const upstreamHealthy = court?.paths?.raw?.ready === true
    && court.paths.raw.frameErrors === 0
    && court?.paths?.program?.ready === true
    && court.paths.program.frameErrors === 0
    && agent?.state === "HEALTHY"
    && egress?.idle === false
    && egress.activeWebRequests === 1;
  if (!upstreamHealthy) return "dependency-failed";
  const browser = court?.browser;
  const ageMs = browser ? nowMs - Date.parse(browser.receivedAt) : Infinity;
  const browserHealthy = browser
    && Number.isFinite(ageMs)
    && ageMs >= 0
    && ageMs <= MAX_BROWSER_AGE_MS
    && browser.video?.state === "playing"
    && browser.video?.connectionState === "connected"
    && browser.video?.transport === "whep";
  return browserHealthy ? "healthy" : "browser-failed";
}

function validateState(state, activeCameras) {
  validateCameras(activeCameras);
  if (!state || state.schemaVersion !== 1 || !state.cameras || typeof state.cameras !== "object") throw new Error("program supervisor state is invalid");
  if (JSON.stringify(Object.keys(state.cameras).map(Number).sort((left, right) => left - right)) !== JSON.stringify(activeCameras)) throw new Error("program supervisor camera set changed");
  for (const camera of activeCameras) {
    const value = state.cameras[camera];
    if (!value || !Number.isInteger(value.consecutiveFailures) || value.consecutiveFailures < 0 || !Number.isInteger(value.restartCount) || value.restartCount < 0 || value.restartCount > MAX_RESTARTS_PER_GENERATION || typeof value.exhausted !== "boolean") throw new Error(`Camera ${camera} program supervisor state is invalid`);
    if (value.lastRestartAt !== null && !Number.isFinite(Date.parse(value.lastRestartAt))) throw new Error(`Camera ${camera} program supervisor restart timestamp is invalid`);
  }
}

function validateCameras(cameras) {
  if (!Array.isArray(cameras) || cameras.length < 1 || JSON.stringify([...new Set(cameras)].sort((left, right) => left - right)) !== JSON.stringify(cameras) || cameras.some((camera) => !Number.isInteger(camera) || camera < 1 || camera > 8)) throw new Error("program supervisor cameras are invalid");
}
