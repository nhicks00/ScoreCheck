import { parseZombieEventLine, summarizeZombieRoleEvents } from "./zombie-evidence.mjs";

const HOST_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export function parsePoolHostEventsNdjson(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("pool host evidence is empty");
  const events = lines.map((line, index) => {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`pool host evidence row ${index + 1} is not valid JSON`);
    }
    if (typeof raw?.hostId !== "string" || !HOST_ID.test(raw.hostId)) {
      throw new Error(`pool host evidence row ${index + 1} has an invalid hostId`);
    }
    return { ...parseZombieEventLine(line), hostId: raw.hostId };
  });

  const hostRoles = new Map();
  const lastObserved = new Map();
  const sampleSlots = new Set();
  for (const event of events) {
    const knownRole = hostRoles.get(event.hostId);
    if (knownRole && knownRole !== event.role) throw new Error(`pool host ${event.hostId} changed role`);
    hostRoles.set(event.hostId, event.role);
    const previous = lastObserved.get(event.hostId);
    if (previous != null && event.observedAtMs < previous) throw new Error(`pool host ${event.hostId} events are not chronological`);
    lastObserved.set(event.hostId, event.observedAtMs);
    if (event.event === "host_sample") {
      const key = `${event.hostId}\u0000${event.sampleSlotAtMs}`;
      if (sampleSlots.has(key)) throw new Error(`pool host ${event.hostId} has a duplicate sample slot`);
      sampleSlots.add(key);
    }
  }
  return events;
}

export function summarizePoolHost(events, { hostId, role, startEpochSeconds, endEpochSeconds, stepSeconds }) {
  if (typeof hostId !== "string" || !HOST_ID.test(hostId)) throw new Error("pool hostId is invalid");
  if (!new Set(["ingest", "compositor"]).has(role)) throw new Error("pool host role is invalid");
  const selected = events.filter((event) => event.hostId === hostId);
  if (selected.length === 0) throw new Error(`pool host evidence has no events for ${hostId}`);
  if (selected.some((event) => event.role !== role)) throw new Error(`pool host ${hostId} role does not match ${role}`);
  const machineFingerprints = [...new Set(selected
    .filter((event) => event.event === "watcher_started")
    .map((event) => event.machineFingerprint)
    .filter((value) => typeof value === "string"))];
  return {
    hostId,
    role,
    machineFingerprint: machineFingerprints.length === 1 ? machineFingerprints[0] : null,
    samples: summarizeSamples(selected, { startEpochSeconds, endEpochSeconds, stepSeconds }),
    zombies: summarizeZombieRoleEvents(selected, { startEpochSeconds, endEpochSeconds })
  };
}

export function pairPoolHostSamples(ingest, compositor) {
  const values = [ingest, compositor];
  const maximum = (field) => nullableMaximum(values.map((entry) => entry[field]));
  return {
    coverageRatio: Math.min(ingest.coverageRatio, compositor.coverageRatio),
    p95GapSeconds: maximum("p95GapSeconds"),
    maxGapSeconds: maximum("maxGapSeconds"),
    startEdgeGapSeconds: maximum("startEdgeGapSeconds"),
    endEdgeGapSeconds: maximum("endEdgeGapSeconds"),
    baselineAgeSeconds: maximum("baselineAgeSeconds"),
    ingestHostCpuP95Ratio: ingest.cpuP95Ratio,
    ingestHostCpuMaxRatio: ingest.cpuMaxRatio,
    ingestSampleLagP95Ms: ingest.sampleLagP95Ms,
    ingestSampleLagMaxMs: ingest.sampleLagMaxMs,
    compositorHostCpuP95Ratio: compositor.cpuP95Ratio,
    compositorHostCpuMaxRatio: compositor.cpuMaxRatio,
    compositorSampleLagP95Ms: compositor.sampleLagP95Ms,
    compositorSampleLagMaxMs: compositor.sampleLagMaxMs,
    egressShmMaxRatio: compositor.shmMaxRatio
  };
}

function summarizeSamples(events, { startEpochSeconds, endEpochSeconds, stepSeconds }) {
  const startMs = startEpochSeconds * 1_000;
  const endMs = endEpochSeconds * 1_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("pool host sample window is invalid");
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) throw new Error("pool host sample stepSeconds must be positive");
  const rows = events.filter((event) => event.event === "host_sample");
  const baselineStartMs = startMs - (stepSeconds * 2_000);
  const baseline = rows
    .filter((row) => row.sampleSlotAtMs >= baselineStartMs && row.sampleSlotAtMs < startMs && validSample(row))
    .at(-1) ?? null;
  const windowRows = rows.filter((row) => row.sampleSlotAtMs >= startMs && row.sampleSlotAtMs <= endMs);
  const validRows = windowRows.filter(validSample);
  const expectedSamples = Math.floor((endEpochSeconds - startEpochSeconds) / stepSeconds) + 1;
  const gaps = validRows.slice(1).map((row, index) => (row.sampleSlotAtMs - validRows[index].sampleSlotAtMs) / 1_000);
  return {
    expectedSamples,
    observedRows: windowRows.length,
    validSamples: validRows.length,
    failedSamples: windowRows.length - validRows.length,
    coverageRatio: expectedSamples > 0 ? Math.min(1, validRows.length / expectedSamples) : 0,
    p95GapSeconds: percentile(gaps, 0.95),
    maxGapSeconds: nullableMaximum(gaps),
    startEdgeGapSeconds: validRows.length ? (validRows[0].sampleSlotAtMs - startMs) / 1_000 : null,
    endEdgeGapSeconds: validRows.length ? (endMs - validRows.at(-1).sampleSlotAtMs) / 1_000 : null,
    baselineSampleAt: baseline?.sampleSlotAt ?? null,
    baselineAgeSeconds: baseline ? (startMs - baseline.sampleSlotAtMs) / 1_000 : null,
    cpuP95Ratio: percentile(validRows.map((row) => row.cpuRatio), 0.95),
    cpuMaxRatio: nullableMaximum(validRows.map((row) => row.cpuRatio)),
    sampleLagP95Ms: percentile(validRows.map((row) => row.sampleLagMs), 0.95),
    sampleLagMaxMs: nullableMaximum(validRows.map((row) => row.sampleLagMs)),
    shmMaxRatio: nullableMaximum(validRows.map((row) => row.shmRatio))
  };
}

function validSample(event) {
  return event.sampleOk
    && Number.isFinite(event.cpuRatio)
    && Number.isFinite(event.sampleLagMs)
    && Number.isFinite(event.shmRatio);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function nullableMaximum(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}
