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
    return { eventId, cameras: mapping };
  }

  async set({ binding, camera, phase, commentaryParticipating, runId, youtubeVideoId = null }) {
    if (!binding || typeof binding.eventId !== "string" || typeof binding.cameras?.[camera] !== "string") throw new Error(`Camera ${camera} monitoring binding is invalid`);
    if (!new Set(["TESTING", "LIVE"]).has(phase)) throw new Error(`Camera ${camera} monitoring phase is invalid`);
    if (phase === "LIVE") await this.#bindYouTubeVideo({ binding, camera, youtubeVideoId });
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
      override_reason: `Production soak ${runId} set Camera ${camera} ${phase.toLowerCase()}.`,
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
    return { phase, observedAt, eventId: row.event_id, courtId: row.court_id, youtubeVideoId };
  }

  async #bindYouTubeVideo({ binding, camera, youtubeVideoId }) {
    if (typeof youtubeVideoId !== "string" || !/^[A-Za-z0-9_-]{6,64}$/u.test(youtubeVideoId)) {
      throw new Error(`Camera ${camera} YouTube video id is invalid`);
    }
    const courtId = binding.cameras[camera];
    const result = await this.#request(`/rest/v1/courts?id=eq.${encodeURIComponent(courtId)}&event_id=eq.${encodeURIComponent(binding.eventId)}&select=id,event_id,court_number,youtube_video_id`, {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({ youtube_video_id: youtubeVideoId })
    });
    if (!Array.isArray(result) || result.length !== 1
      || result[0]?.id !== courtId
      || result[0]?.event_id !== binding.eventId
      || result[0]?.court_number !== camera
      || result[0]?.youtube_video_id !== youtubeVideoId) {
      throw new Error(`Camera ${camera} YouTube video binding verification failed`);
    }
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
