const HEADER = [
  "sampled_at",
  "ingest_cpu_ratio",
  "ingest_sample_lag_ms",
  "compositor_cpu_ratio",
  "compositor_sample_lag_ms",
  "egress_shm_ratio",
  "sample_ok"
];

export function parseHostSamplesCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("host sample CSV must contain a header and at least one sample");
  const header = lines[0].split(",");
  if (header.length !== HEADER.length || header.some((value, index) => value !== HEADER[index])) {
    throw new Error(`host sample CSV header must be ${HEADER.join(",")}`);
  }

  const seen = new Set();
  const rows = lines.slice(1).map((line, index) => {
    const fields = line.split(",");
    if (fields.length !== HEADER.length) throw new Error(`host sample CSV row ${index + 2} has ${fields.length} fields`);
    const sampledAtMs = Date.parse(fields[0]);
    if (!Number.isFinite(sampledAtMs)) throw new Error(`host sample CSV row ${index + 2} has an invalid timestamp`);
    if (seen.has(sampledAtMs)) throw new Error(`host sample CSV contains duplicate timestamp ${fields[0]}`);
    seen.add(sampledAtMs);
    return {
      sampledAt: new Date(sampledAtMs).toISOString(),
      sampledAtMs,
      ingestCpuRatio: finiteNumber(fields[1]),
      ingestSampleLagMs: finiteNumber(fields[2]),
      compositorCpuRatio: finiteNumber(fields[3]),
      compositorSampleLagMs: finiteNumber(fields[4]),
      egressShmRatio: finiteNumber(fields[5]),
      sampleOk: fields[6] === "1"
    };
  });
  return rows.sort((left, right) => left.sampledAtMs - right.sampledAtMs);
}

export function summarizeHostSamples(rows, { startEpochSeconds, endEpochSeconds, stepSeconds }) {
  const startMs = startEpochSeconds * 1_000;
  const endMs = endEpochSeconds * 1_000;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("host sample window is invalid");
  if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) throw new Error("host sample stepSeconds must be positive");

  const baselineWindowStartMs = startMs - (stepSeconds * 2_000);
  const baseline = rows.reduce((latest, row) => {
    if (row.sampledAtMs < baselineWindowStartMs || row.sampledAtMs >= startMs || !validRow(row)) return latest;
    return latest == null || row.sampledAtMs > latest.sampledAtMs ? row : latest;
  }, null);
  const windowRows = rows.filter((row) => row.sampledAtMs >= startMs && row.sampledAtMs <= endMs);
  const validRows = windowRows.filter(validRow);
  const expectedSamples = Math.floor((endEpochSeconds - startEpochSeconds) / stepSeconds) + 1;
  const gaps = validRows.slice(1).map((row, index) => (row.sampledAtMs - validRows[index].sampledAtMs) / 1_000);

  return {
    schemaVersion: 1,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    stepSeconds,
    expectedSamples,
    observedRows: windowRows.length,
    validSamples: validRows.length,
    failedSamples: windowRows.length - validRows.length,
    coverageRatio: expectedSamples > 0 ? Math.min(1, validRows.length / expectedSamples) : 0,
    medianGapSeconds: percentile(gaps, 0.5),
    p95GapSeconds: percentile(gaps, 0.95),
    maxGapSeconds: gaps.length > 0 ? Math.max(...gaps) : null,
    startEdgeGapSeconds: validRows.length > 0 ? (validRows[0].sampledAtMs - startMs) / 1_000 : null,
    endEdgeGapSeconds: validRows.length > 0 ? (endMs - validRows.at(-1).sampledAtMs) / 1_000 : null,
    baselineSampleAt: baseline?.sampledAt ?? null,
    baselineAgeSeconds: baseline ? (startMs - baseline.sampledAtMs) / 1_000 : null,
    ingestHostCpuP95Ratio: percentile(validRows.map((row) => row.ingestCpuRatio), 0.95),
    ingestHostCpuMaxRatio: maximum(validRows.map((row) => row.ingestCpuRatio)),
    ingestSampleLagP95Ms: percentile(validRows.map((row) => row.ingestSampleLagMs), 0.95),
    ingestSampleLagMaxMs: maximum(validRows.map((row) => row.ingestSampleLagMs)),
    compositorHostCpuP95Ratio: percentile(validRows.map((row) => row.compositorCpuRatio), 0.95),
    compositorHostCpuMaxRatio: maximum(validRows.map((row) => row.compositorCpuRatio)),
    compositorSampleLagP95Ms: percentile(validRows.map((row) => row.compositorSampleLagMs), 0.95),
    compositorSampleLagMaxMs: maximum(validRows.map((row) => row.compositorSampleLagMs)),
    egressShmMaxRatio: maximum(validRows.map((row) => row.egressShmRatio))
  };
}

function validRow(row) {
  return row.sampleOk
    && Number.isFinite(row.ingestCpuRatio)
    && Number.isFinite(row.ingestSampleLagMs)
    && Number.isFinite(row.compositorCpuRatio)
    && Number.isFinite(row.compositorSampleLagMs)
    && Number.isFinite(row.egressShmRatio)
    && row.ingestCpuRatio >= 0
    && row.ingestSampleLagMs >= 0
    && row.compositorCpuRatio >= 0
    && row.compositorSampleLagMs >= 0
    && row.egressShmRatio >= 0;
}

function finiteNumber(value) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : null;
}
