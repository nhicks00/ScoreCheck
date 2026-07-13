export type PacingDiagnosticSample = {
  sampledAtMs: number;
  connectionState: string;
  framesPerSecond: number | null;
  rttMs: number | null;
  jitterMs: number | null;
  jitterBufferMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
  freezeCount: number | null;
  totalFreezesDurationMs: number | null;
  nackCount: number | null;
  pliCount: number | null;
  firCount: number | null;
};

export type PacingDiagnosticSummary = {
  sampleCount: number;
  measuredDurationMs: number;
  connectedSampleRatio: number;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  frameDropRatio: number | null;
  freezeCount: number;
  freezeDurationMs: number;
  freezeTimeRatio: number | null;
  packetsReceived: number;
  packetsLost: number;
  packetLossRatio: number | null;
  nackCount: number;
  pliCount: number;
  firCount: number;
  medianFps: number | null;
  p95JitterBufferMs: number | null;
  p95JitterMs: number | null;
  p95RttMs: number | null;
  sufficient: boolean;
};

export type PacingComparison = {
  classification: "HEALTHY" | "PROGRAM_PATH" | "SHARED" | "INCONCLUSIVE";
  summary: string;
};

const WARNING_DROP_RATIO = 0.005;
const WARNING_FREEZE_RATIO = 0.01;
const MIN_FRAMES = 900;
const MIN_DURATION_MS = 30_000;

export function summarizePacingSamples(samples: PacingDiagnosticSample[]): PacingDiagnosticSummary {
  const ordered = [...samples]
    .filter((sample) => Number.isFinite(sample.sampledAtMs))
    .sort((left, right) => left.sampledAtMs - right.sampledAtMs);
  const connected = ordered.filter((sample) => sample.connectionState === "connected");
  const measuredDurationMs = connected.length >= 2
    ? Math.max(0, connected.at(-1)!.sampledAtMs - connected[0].sampledAtMs)
    : 0;
  const framesReceived = resetSafeIncrease(connected, "framesReceived");
  const framesDecoded = resetSafeIncrease(connected, "framesDecoded");
  const framesDropped = resetSafeIncrease(connected, "framesDropped");
  const freezeCount = resetSafeIncrease(connected, "freezeCount");
  const freezeDurationMs = resetSafeIncrease(connected, "totalFreezesDurationMs");
  const packetsReceived = resetSafeIncrease(connected, "packetsReceived");
  const packetsLost = resetSafeIncrease(connected, "packetsLost");

  return {
    sampleCount: ordered.length,
    measuredDurationMs,
    connectedSampleRatio: ordered.length ? connected.length / ordered.length : 0,
    framesReceived,
    framesDecoded,
    framesDropped,
    frameDropRatio: framesReceived > 0 ? framesDropped / framesReceived : null,
    freezeCount,
    freezeDurationMs,
    freezeTimeRatio: measuredDurationMs > 0 ? freezeDurationMs / measuredDurationMs : null,
    packetsReceived,
    packetsLost,
    packetLossRatio: packetsReceived + packetsLost > 0 ? packetsLost / (packetsReceived + packetsLost) : null,
    nackCount: resetSafeIncrease(connected, "nackCount"),
    pliCount: resetSafeIncrease(connected, "pliCount"),
    firCount: resetSafeIncrease(connected, "firCount"),
    medianFps: percentile(values(connected, "framesPerSecond"), 0.5),
    p95JitterBufferMs: percentile(values(connected, "jitterBufferMs"), 0.95),
    p95JitterMs: percentile(values(connected, "jitterMs"), 0.95),
    p95RttMs: percentile(values(connected, "rttMs"), 0.95),
    sufficient: measuredDurationMs >= MIN_DURATION_MS && framesReceived >= MIN_FRAMES && connected.length >= 24
  };
}

export function comparePacingPhases(
  previewA: PacingDiagnosticSummary,
  program: PacingDiagnosticSummary,
  previewB: PacingDiagnosticSummary
): PacingComparison {
  if (![previewA, program, previewB].every((summary) => summary.sufficient)) {
    return {
      classification: "INCONCLUSIVE",
      summary: "One or more phases did not collect enough connected frames for attribution."
    };
  }

  const previewADegraded = isDegraded(previewA);
  const programDegraded = isDegraded(program);
  const previewBDegraded = isDegraded(previewB);

  if (!previewADegraded && !programDegraded && !previewBDegraded) {
    return {
      classification: "HEALTHY",
      summary: "Neither preview nor delayed program crossed the browser pacing warning bands."
    };
  }
  if (!previewADegraded && programDegraded && !previewBDegraded) {
    return {
      classification: "PROGRAM_PATH",
      summary: "Only the delayed program phase crossed a pacing warning band; investigate the delay/remux path before the shared source or client."
    };
  }
  if (previewADegraded && programDegraded && previewBDegraded) {
    return {
      classification: "SHARED",
      summary: "All three phases crossed a pacing warning band; the evidence does not isolate the delayed program branch."
    };
  }
  return {
    classification: "INCONCLUSIVE",
    summary: "The two preview controls disagree or only one control is degraded; repeat the test under stable client and network load."
  };
}

function isDegraded(summary: PacingDiagnosticSummary): boolean {
  return (summary.frameDropRatio ?? 0) > WARNING_DROP_RATIO
    || (summary.freezeTimeRatio ?? 0) > WARNING_FREEZE_RATIO;
}

function resetSafeIncrease<K extends CounterKey>(samples: PacingDiagnosticSample[], key: K): number {
  let previous: number | null = null;
  let total = 0;
  for (const sample of samples) {
    const current = sample[key];
    if (current == null || !Number.isFinite(current) || current < 0) continue;
    if (previous != null && current >= previous) total += current - previous;
    previous = current;
  }
  return total;
}

function values<K extends GaugeKey>(samples: PacingDiagnosticSample[], key: K): number[] {
  return samples
    .map((sample) => sample[key])
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0);
}

function percentile(input: number[], ratio: number): number | null {
  if (!input.length) return null;
  const ordered = [...input].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * ratio) - 1));
  return ordered[index];
}

type CounterKey = "packetsLost" | "packetsReceived" | "framesReceived" | "framesDecoded" | "framesDropped" | "freezeCount" | "totalFreezesDurationMs" | "nackCount" | "pliCount" | "firCount";
type GaugeKey = "framesPerSecond" | "rttMs" | "jitterMs" | "jitterBufferMs";
