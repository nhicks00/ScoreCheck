const ROLES = ["ingest", "compositor"];
const EVENTS = new Set([
  "watcher_started",
  "heartbeat",
  "host_sample",
  "zombie_open",
  "zombie_close",
  "zombie_observation_end",
  "watcher_stopped"
]);
const CLASSIFICATION = /^(?:unclassified|observer\.capacity-ssh|healthcheck\.(?:monitor-agent|egress|mediamtx|redis)(?:\.runtime)?|workload\.egress-(?:chrome|pactl|gst-plugin-scan))$/;
const FINGERPRINT = /^[a-f0-9]{16}$/;
const IDENTITY = /^\d+:\d+$/;
const PROVIDER_RESOURCE_ID = /^[1-9]\d{0,19}$/;
const PROVIDER_HOSTNAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/;

export function parseZombieEventLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new Error("zombie event is not valid JSON");
  }
  if (event?.schemaVersion !== 1) throw new Error("zombie event schemaVersion must be 1");
  if (!ROLES.includes(event.role)) throw new Error("zombie event role is invalid");
  if (!EVENTS.has(event.event)) throw new Error("zombie event type is invalid");
  const observedAtMs = Date.parse(event.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error("zombie event observedAt is invalid");

  const output = {
    schemaVersion: 1,
    role: event.role,
    event: event.event,
    observedAt: new Date(observedAtMs).toISOString(),
    observedAtMs
  };
  if (event.event === "watcher_started") {
    output.pollIntervalMs = boundedInteger(event.pollIntervalMs, 25, 250, "pollIntervalMs");
    output.watcherPid = positiveInteger(event.watcherPid, "watcherPid");
    output.machineFingerprint = optionalFingerprint(event.machineFingerprint, "machineFingerprint");
    output.provider = optionalProvider(event.provider);
    output.providerResourceId = optionalProviderResourceId(event.providerResourceId);
    output.providerHostname = optionalProviderHostname(event.providerHostname);
  } else if (event.event === "heartbeat") {
    output.scanCount = nonnegativeInteger(event.scanCount, "scanCount");
    output.activeZombieCount = nonnegativeInteger(event.activeZombieCount, "activeZombieCount");
    output.maximumScanGapMs = boundedNumber(event.maximumScanGapMs, 0, 60_000, "maximumScanGapMs");
  } else if (event.event === "host_sample") {
    const sampleSlotAtMs = Date.parse(event.sampleSlotAt);
    if (!Number.isFinite(sampleSlotAtMs)) throw new Error("zombie event sampleSlotAt is invalid");
    output.sampleSlotAt = new Date(sampleSlotAtMs).toISOString();
    output.sampleSlotAtMs = sampleSlotAtMs;
    output.sampleLagMs = boundedNumber(event.sampleLagMs, 0, 60_000, "sampleLagMs");
    if (typeof event.sampleOk !== "boolean") throw new Error("zombie event sampleOk is invalid");
    output.sampleOk = event.sampleOk;
    output.cpuRatio = nullableBoundedNumber(event.cpuRatio, 0, 1, "cpuRatio");
    output.shmRatio = nullableBoundedNumber(event.shmRatio, 0, 1, "shmRatio");
    if (event.sampleOk && (output.cpuRatio == null || output.shmRatio == null)) {
      throw new Error("successful host sample must contain CPU and shared-memory ratios");
    }
  } else if (event.event === "zombie_open") {
    output.identity = identity(event.identity);
    output.pid = positiveInteger(event.pid, "pid");
    output.ppid = nonnegativeInteger(event.ppid, "ppid");
    if (event.state !== "Z") throw new Error("zombie_open state must be Z");
    output.state = "Z";
    output.command = safeText(event.command, "command", false);
    output.parentCommand = safeText(event.parentCommand, "parentCommand", true);
    output.executable = safeText(event.executable, "executable", true);
    output.commandFingerprint = optionalFingerprint(event.commandFingerprint, "commandFingerprint");
    output.cgroupFingerprint = optionalFingerprint(event.cgroupFingerprint, "cgroupFingerprint");
    if (typeof event.initialObservation !== "boolean") throw new Error("zombie event initialObservation is invalid");
    output.initialObservation = event.initialObservation;
    if (typeof event.classification !== "string" || !CLASSIFICATION.test(event.classification)) {
      throw new Error("zombie event classification is invalid");
    }
    output.classification = event.classification;
  } else if (event.event === "zombie_close" || event.event === "zombie_observation_end") {
    output.identity = identity(event.identity);
    output.durationMs = boundedNumber(event.durationMs, 0, 86_400_000, "durationMs");
    if (typeof event.classification !== "string" || !CLASSIFICATION.test(event.classification)) {
      throw new Error("zombie event classification is invalid");
    }
    output.classification = event.classification;
  } else if (event.event === "watcher_stopped") {
    output.scanCount = nonnegativeInteger(event.scanCount, "scanCount");
    output.activeZombieCount = nonnegativeInteger(event.activeZombieCount, "activeZombieCount");
  }
  return output;
}

export function parseZombieEventsNdjson(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("zombie event evidence is empty");
  const events = lines.map(parseZombieEventLine);
  for (const role of ROLES) {
    const roleEvents = events.filter((event) => event.role === role);
    if (roleEvents.length === 0) throw new Error(`zombie event evidence has no ${role} watcher events`);
    for (let index = 1; index < roleEvents.length; index += 1) {
      if (roleEvents[index].observedAtMs < roleEvents[index - 1].observedAtMs) {
        throw new Error(`${role} zombie events are not chronological`);
      }
    }
  }
  return events;
}

export function summarizeZombieEvents(events, { startEpochSeconds, endEpochSeconds }) {
  const startMs = startEpochSeconds * 1_000;
  const endMs = endEpochSeconds * 1_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("zombie evidence window is invalid");
  }
  return {
    schemaVersion: 1,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    roles: Object.fromEntries(ROLES.map((role) => [role, summarizeRole(events.filter((event) => event.role === role), startMs, endMs)]))
  };
}

export function summarizeZombieRoleEvents(events, { startEpochSeconds, endEpochSeconds }) {
  const startMs = startEpochSeconds * 1_000;
  const endMs = endEpochSeconds * 1_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("zombie evidence window is invalid");
  }
  return summarizeRole(events, startMs, endMs);
}

function summarizeRole(events, startMs, endMs) {
  const starts = events.filter((event) => event.event === "watcher_started" && event.observedAtMs <= startMs);
  const activeStart = starts.at(-1) ?? null;
  const restartsInWindow = events.filter((event) => event.event === "watcher_started" && event.observedAtMs > startMs && event.observedAtMs <= endMs).length;
  const stoppedInWindow = events.filter((event) => event.event === "watcher_stopped" && event.observedAtMs >= startMs && event.observedAtMs < endMs).length;
  const heartbeats = events.filter((event) => event.event === "heartbeat");
  const before = heartbeats.filter((event) => event.observedAtMs <= startMs).at(-1) ?? null;
  const after = heartbeats.find((event) => event.observedAtMs >= endMs) ?? null;
  const spanning = heartbeats.filter((event) =>
    event.observedAtMs >= (before?.observedAtMs ?? startMs)
    && event.observedAtMs <= (after?.observedAtMs ?? endMs)
  );
  const heartbeatGaps = spanning.slice(1).map((event, index) => (event.observedAtMs - spanning[index].observedAtMs) / 1_000);
  const inWindowHeartbeats = heartbeats.filter((event) => event.observedAtMs >= startMs && event.observedAtMs <= endMs);

  const active = new Map();
  for (const event of events) {
    if (event.observedAtMs >= startMs) break;
    if (event.event === "zombie_open") active.set(event.identity, event);
    if (event.event === "zombie_close" || event.event === "zombie_observation_end") active.delete(event.identity);
  }
  const baselineUnclassifiedEvents = [...active.values()].filter((event) => event.classification === "unclassified");
  const baselineUnclassified = new Set(baselineUnclassifiedEvents.map((event) => event.identity));
  let concurrent = active.size;
  let maximumConcurrent = concurrent;
  const observerOpens = [];
  const workloadOpens = [];
  const newUnclassified = [];
  const openByIdentity = new Map(events.filter((event) => event.event === "zombie_open").map((event) => [event.identity, event]));
  const closeByIdentity = new Map(events.filter((event) => event.event === "zombie_close").map((event) => [event.identity, event]));
  const endByIdentity = new Map(events
    .filter((event) => event.event === "zombie_close" || event.event === "zombie_observation_end")
    .map((event) => [event.identity, event]));

  for (const event of events) {
    if (event.observedAtMs < startMs || event.observedAtMs > endMs) continue;
    if (event.event === "zombie_open") {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      if (event.classification === "unclassified") {
        newUnclassified.push(event);
      } else if (event.classification.startsWith("workload.")) {
        workloadOpens.push(event);
      } else {
        observerOpens.push(event);
      }
    } else if (event.event === "zombie_close") {
      concurrent = Math.max(0, concurrent - 1);
    }
  }

  const observerEpisodes = [...openByIdentity.values()].filter((event) => {
    if (event.classification === "unclassified" || event.classification.startsWith("workload.") || event.observedAtMs > endMs) return false;
    const ended = endByIdentity.get(event.identity);
    return ended == null || ended.observedAtMs >= startMs;
  });
  const workloadEpisodes = [...openByIdentity.values()].filter((event) => {
    if (!event.classification.startsWith("workload.") || event.observedAtMs > endMs) return false;
    const ended = endByIdentity.get(event.identity);
    return ended == null || ended.observedAtMs >= startMs;
  });
  const observerDurations = observerEpisodes.map((event) => {
    const ended = endByIdentity.get(event.identity);
    if (ended?.durationMs != null) return ended.durationMs;
    return Math.max(0, endMs - event.observedAtMs);
  });
  const workloadDurations = workloadEpisodes.map((event) => {
    const ended = endByIdentity.get(event.identity);
    if (ended?.durationMs != null) return ended.durationMs;
    return Math.max(0, endMs - event.observedAtMs);
  });
  const classifications = {};
  for (const event of observerOpens) classifications[event.classification] = (classifications[event.classification] ?? 0) + 1;

  return {
    watcherStartedAt: activeStart?.observedAt ?? null,
    pollIntervalMs: activeStart?.pollIntervalMs ?? null,
    watcherRestarts: restartsInWindow,
    watcherStops: stoppedInWindow,
    heartbeatSamples: inWindowHeartbeats.length,
    startEdgeGapSeconds: before ? (startMs - before.observedAtMs) / 1_000 : null,
    endEdgeGapSeconds: after ? (after.observedAtMs - endMs) / 1_000 : null,
    maximumHeartbeatGapSeconds: heartbeatGaps.length > 0 ? Math.max(...heartbeatGaps) : null,
    maximumScanGapMs: maximum(inWindowHeartbeats.map((event) => event.maximumScanGapMs)),
    baselineUnclassifiedCount: baselineUnclassified.size,
    baselineUnclassifiedIdentities: [...baselineUnclassified],
    baselineUnclassifiedEvents: baselineUnclassifiedEvents.slice(0, 20).map(boundedOpenEvent),
    newUnclassifiedCount: newUnclassified.length,
    newUnclassifiedEvents: newUnclassified.slice(0, 20).map(boundedOpenEvent),
    observerEventCount: observerOpens.length,
    observerClassifications: classifications,
    observerMaximumDurationMs: maximum(observerDurations),
    observerMaximumRollingMinuteCount: rollingMinuteMaximum(observerOpens.map((event) => event.observedAtMs)),
    workloadEventCount: workloadOpens.length,
    workloadClassifications: classificationCounts(workloadOpens),
    workloadMaximumDurationMs: maximum(workloadDurations),
    workloadMaximumRollingMinuteCount: rollingMinuteMaximum(workloadOpens.map((event) => event.observedAtMs)),
    workloadMaximumConcurrentCount: maximumConcurrentFor(workloadEpisodes, endByIdentity, startMs, endMs),
    maximumConcurrentZombies: Math.max(maximumConcurrent, maximum(inWindowHeartbeats.map((event) => event.activeZombieCount)) ?? 0),
    unclosedObserverCount: observerEpisodes.filter((event) => !closeByIdentity.has(event.identity)).length,
    unclosedWorkloadCount: workloadEpisodes.filter((event) => !closeByIdentity.has(event.identity)).length,
    orphanCloseCount: events.filter((event) =>
      event.observedAtMs > startMs
      && event.observedAtMs <= endMs
      && event.event === "zombie_close"
      && !openByIdentity.has(event.identity)
    ).length
  };
}

function classificationCounts(events) {
  const counts = {};
  for (const event of events) counts[event.classification] = (counts[event.classification] ?? 0) + 1;
  return counts;
}

function maximumConcurrentFor(events, endByIdentity, startMs, endMs) {
  const boundaries = [];
  for (const event of events) {
    boundaries.push({ at: Math.max(startMs, event.observedAtMs), delta: 1 });
    const ended = endByIdentity.get(event.identity);
    if (ended) boundaries.push({ at: Math.min(endMs, ended.observedAtMs), delta: -1 });
  }
  boundaries.sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximumValue = 0;
  for (const boundary of boundaries) {
    active = Math.max(0, active + boundary.delta);
    maximumValue = Math.max(maximumValue, active);
  }
  return maximumValue;
}

function boundedOpenEvent(event) {
  return {
    observedAt: event.observedAt,
    identity: event.identity,
    pid: event.pid,
    ppid: event.ppid,
    command: event.command,
    parentCommand: event.parentCommand,
    executable: event.executable,
    commandFingerprint: event.commandFingerprint,
    cgroupFingerprint: event.cgroupFingerprint,
    classification: event.classification
  };
}

function rollingMinuteMaximum(values) {
  let left = 0;
  let maximumValue = 0;
  for (let right = 0; right < values.length; right += 1) {
    while (values[right] - values[left] >= 60_000) left += 1;
    maximumValue = Math.max(maximumValue, right - left + 1);
  }
  return maximumValue;
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : null;
}

function safeText(value, name, nullable) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`zombie event ${name} is invalid`);
  }
  return value;
}

function optionalFingerprint(value, name) {
  if (value == null) return null;
  if (typeof value !== "string" || !FINGERPRINT.test(value)) throw new Error(`zombie event ${name} is invalid`);
  return value;
}

function optionalProvider(value) {
  if (value == null) return null;
  if (value !== "digitalocean") throw new Error("zombie event provider is invalid");
  return value;
}

function optionalProviderResourceId(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !PROVIDER_RESOURCE_ID.test(value)) throw new Error("zombie event providerResourceId is invalid");
  return value;
}

function optionalProviderHostname(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !PROVIDER_HOSTNAME.test(value)) throw new Error("zombie event providerHostname is invalid");
  return value;
}

function identity(value) {
  if (typeof value !== "string" || !IDENTITY.test(value)) throw new Error("zombie event identity is invalid");
  return value;
}

function boundedNumber(value, minimum, maximumValue, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximumValue) throw new Error(`zombie event ${name} is invalid`);
  return value;
}

function nullableBoundedNumber(value, minimum, maximumValue, name) {
  return value == null ? null : boundedNumber(value, minimum, maximumValue, name);
}

function boundedInteger(value, minimum, maximumValue, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximumValue) throw new Error(`zombie event ${name} is invalid`);
  return value;
}

function positiveInteger(value, name) {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, name);
}

function nonnegativeInteger(value, name) {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, name);
}
