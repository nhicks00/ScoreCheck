const EXPECTATION_TTL_MS = 18 * 60 * 60 * 1_000;

export class MonitoringExpectationRuntime {
  constructor({ supabaseUrl, serviceRoleKey, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.origin = protectedOrigin(supabaseUrl);
    this.serviceRoleKey = requiredSecret(serviceRoleKey, "Supabase service-role key");
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async resolve(activeCameras) {
    validateCameras(activeCameras);
    const events = await this.#request("/rest/v1/events?select=id&is_active=eq.true&limit=2");
    if (!Array.isArray(events) || events.length !== 1 || typeof events[0]?.id !== "string") {
      throw new Error("production monitoring requires exactly one active Supabase event");
    }
    const eventId = events[0].id;
    const courts = await this.#request(`/rest/v1/courts?select=id,court_number&event_id=eq.${encodeURIComponent(eventId)}&court_number=in.(${activeCameras.join(",")})`);
    if (!Array.isArray(courts)) throw new Error("production monitoring court mapping response is invalid");
    const mapping = {};
    for (const court of courts) {
      if (!activeCameras.includes(court?.court_number) || typeof court?.id !== "string" || mapping[court.court_number]) {
        throw new Error("production monitoring court mapping is invalid");
      }
      mapping[court.court_number] = court.id;
    }
    if (Object.keys(mapping).length !== activeCameras.length) throw new Error("production monitoring does not map every active camera");
    const courtIds = Object.values(mapping);
    const existing = await this.#request(`/rest/v1/court_monitoring_expectations?select=court_id,override_created_by,override_expires_at&event_id=eq.${encodeURIComponent(eventId)}&court_id=in.(${courtIds.map(encodeURIComponent).join(",")})`);
    if (!Array.isArray(existing) || existing.some((row) => activeOverrideExists(row, this.now()))) {
      throw new Error("production monitoring requires no active pre-existing overrides for active cameras");
    }
    return { eventId, cameras: mapping };
  }

  async set({ binding, camera, phase, commentaryParticipating, runId }) {
    if (!binding || typeof binding.eventId !== "string" || typeof binding.cameras?.[camera] !== "string") throw new Error(`Camera ${camera} monitoring binding is invalid`);
    if (!new Set(["TESTING", "LIVE"]).has(phase)) throw new Error(`Camera ${camera} monitoring phase is invalid`);
    const observedAt = new Date(this.now()).toISOString();
    const row = {
      event_id: binding.eventId,
      court_id: binding.cameras[camera],
      coverage_phase: "WARMUP",
      media_expectation: "REQUIRED",
      broadcast_expectation: phase,
      commentary_expectation: commentaryParticipating ? "OPTIONAL" : "NONE",
      scoring_expectation: "SCHEDULED",
      override_created_by: "scorecheck-production-soak",
      override_created_at: observedAt,
      override_reason: expectationReason(runId, camera, phase),
      override_expires_at: new Date(this.now() + EXPECTATION_TTL_MS).toISOString(),
      updated_at: observedAt
    };
    const result = await this.#request("/rest/v1/court_monitoring_expectations?on_conflict=event_id,court_id", {
      method: "POST",
      headers: { prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row)
    });
    if (!Array.isArray(result) || result.length !== 1) throw new Error(`Camera ${camera} monitoring expectation was not durably returned`);
    for (const field of ["event_id", "court_id", "coverage_phase", "media_expectation", "broadcast_expectation", "commentary_expectation", "scoring_expectation"]) {
      if (result[0]?.[field] !== row[field]) throw new Error(`Camera ${camera} monitoring expectation verification failed for ${field}`);
    }
    return { phase, observedAt, eventId: row.event_id, courtId: row.court_id };
  }

  async clear({ binding, camera, runId }) {
    if (!binding || typeof binding.eventId !== "string" || typeof binding.cameras?.[camera] !== "string") throw new Error(`Camera ${camera} monitoring binding is invalid`);
    const lookupPath = `/rest/v1/court_monitoring_expectations?select=override_created_by,override_reason&event_id=eq.${encodeURIComponent(binding.eventId)}&court_id=eq.${encodeURIComponent(binding.cameras[camera])}`;
    const current = await this.#request(lookupPath);
    const allowedReasons = new Set([expectationReason(runId, camera, "TESTING"), expectationReason(runId, camera, "LIVE")]);
    if (!Array.isArray(current) || current.length !== 1 || current[0]?.override_created_by !== "scorecheck-production-soak" || !allowedReasons.has(current[0]?.override_reason)) {
      throw new Error(`Camera ${camera} monitoring expectation cleanup does not own the current row`);
    }
    const reason = current[0].override_reason;
    const path = `/rest/v1/court_monitoring_expectations?event_id=eq.${encodeURIComponent(binding.eventId)}&court_id=eq.${encodeURIComponent(binding.cameras[camera])}&override_created_by=eq.scorecheck-production-soak&override_reason=eq.${encodeURIComponent(reason)}`;
    const observedAt = new Date(this.now()).toISOString();
    const result = await this.#request(path, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        coverage_phase: "OFF",
        media_expectation: "OFF",
        broadcast_expectation: "OFF",
        commentary_expectation: "NONE",
        scoring_expectation: "NONE",
        override_created_by: null,
        override_created_at: null,
        override_reason: null,
        override_expires_at: null,
        updated_at: observedAt
      })
    });
    if (!Array.isArray(result) || result.length !== 1) throw new Error(`Camera ${camera} monitoring expectation cleanup did not restore exactly one run-owned row`);
    return { phase: "CLEARED", observedAt, eventId: binding.eventId, courtId: binding.cameras[camera] };
  }

  async #request(path, options = {}) {
    const response = await this.fetchImpl(new URL(path, this.origin), {
      ...options,
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        ...options.headers
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`production monitoring request returned HTTP ${response.status}`);
    return response.json();
  }
}

function protectedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Supabase URL is invalid"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error("Supabase URL must be an HTTPS origin");
  return url;
}

function requiredSecret(value, label) {
  if (typeof value !== "string" || value.length < 16 || /[\r\n\0]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validateCameras(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((camera, index) => !Number.isInteger(camera) || camera < 1 || camera > 8 || (index > 0 && camera <= value[index - 1]))) {
    throw new Error("production monitoring active cameras are invalid");
  }
}

function expectationReason(runId, camera, phase) {
  if (typeof runId !== "string" || runId.length < 1 || /[\r\n\0]/u.test(runId)) throw new Error("production monitoring run id is invalid");
  if (!new Set(["TESTING", "LIVE"]).has(phase)) throw new Error("production monitoring phase is invalid");
  return `Production soak ${runId} set Camera ${camera} ${phase.toLowerCase()}.`;
}

function activeOverrideExists(row, nowMs) {
  if (!row || typeof row.court_id !== "string") return true;
  if (row.override_created_by === null) return false;
  if (typeof row.override_created_by !== "string" || row.override_created_by.length < 1) return true;
  if (row.override_expires_at === null) return true;
  const expiresAt = Date.parse(row.override_expires_at);
  return !Number.isFinite(expiresAt) || expiresAt > nowMs;
}
