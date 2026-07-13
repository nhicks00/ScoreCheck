"use client";

import { Activity, Download, Play, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StreamPlayer, type StreamConnectionHealth } from "@/components/StreamPlayer";
import {
  comparePacingPhases,
  summarizePacingSamples,
  type PacingComparison,
  type PacingDiagnosticSample,
  type PacingDiagnosticSummary
} from "@/lib/pacingDiagnostic";

type PhaseId = "preview-a" | "program" | "preview-b";
type Branch = "preview" | "program";

type PacingSources = {
  version: 1;
  courtNumber: number;
  preview: { path: string; whepUrl: string };
  program: { path: string; whepUrl: string };
};

type PhaseReport = {
  phase: PhaseId;
  branch: Branch;
  path: string;
  startedAt: string;
  completedAt: string;
  summary: PacingDiagnosticSummary;
  samples: PacingDiagnosticSample[];
};

type ActivePhase = {
  phase: PhaseId;
  branch: Branch;
  path: string;
  collectAfterMs: number;
  samples: PacingDiagnosticSample[];
};

const PHASES: Array<{ id: PhaseId; branch: Branch; label: string }> = [
  { id: "preview-a", branch: "preview", label: "Preview A" },
  { id: "program", branch: "program", label: "Program" },
  { id: "preview-b", branch: "preview", label: "Preview B" }
];
const WARMUP_MS = 10_000;

export function PacingComparator({ courtNumber }: { courtNumber: number }) {
  const [durationSeconds, setDurationSeconds] = useState(120);
  const [runState, setRunState] = useState<"idle" | "loading" | "running" | "complete">("idle");
  const [activeSource, setActiveSource] = useState<{ phase: PhaseId; whepUrl: string } | null>(null);
  const [activePhaseIndex, setActivePhaseIndex] = useState(-1);
  const [phaseEndsAtMs, setPhaseEndsAtMs] = useState<number | null>(null);
  const [phaseCollectsAtMs, setPhaseCollectsAtMs] = useState<number | null>(null);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [liveHealth, setLiveHealth] = useState<StreamConnectionHealth | null>(null);
  const [reports, setReports] = useState<PhaseReport[]>([]);
  const [comparison, setComparison] = useState<PacingComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);
  const [runCompletedAt, setRunCompletedAt] = useState<string | null>(null);
  const [runDurationSeconds, setRunDurationSeconds] = useState<number | null>(null);
  const runTokenRef = useRef(0);
  const activePhaseRef = useRef<ActivePhase | null>(null);

  const stop = useCallback((reason: string | null = null) => {
    runTokenRef.current += 1;
    activePhaseRef.current = null;
    setActiveSource(null);
    setActivePhaseIndex(-1);
    setPhaseEndsAtMs(null);
    setPhaseCollectsAtMs(null);
    setLiveHealth(null);
    setRunState("idle");
    if (reason) setError(reason);
  }, []);

  useEffect(() => {
    stop();
    setReports([]);
    setComparison(null);
    setError(null);
    setRunStartedAt(null);
    setRunCompletedAt(null);
    setRunDurationSeconds(null);
  }, [courtNumber, stop]);

  useEffect(() => () => {
    runTokenRef.current += 1;
    activePhaseRef.current = null;
  }, []);

  useEffect(() => {
    if (runState !== "running") return;
    const timer = window.setInterval(() => setClockMs(Date.now()), 500);
    const onVisibility = () => {
      if (document.hidden) stop("Path test stopped because the browser tab became hidden.");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [runState, stop]);

  const onConnectionHealth = useCallback((health: StreamConnectionHealth | null) => {
    setLiveHealth(health);
    const active = activePhaseRef.current;
    const nowMs = Date.now();
    if (!active || !health || nowMs < active.collectAfterMs) return;
    active.samples.push({
      sampledAtMs: nowMs,
      connectionState: health.connectionState,
      framesPerSecond: health.framesPerSecond,
      rttMs: health.rttMs,
      jitterMs: health.jitterMs,
      jitterBufferMs: health.jitterBufferMs,
      packetsLost: health.packetsLost,
      packetsReceived: health.packetsReceived,
      framesReceived: health.framesReceived,
      framesDecoded: health.framesDecoded,
      framesDropped: health.framesDropped,
      freezeCount: health.freezeCount,
      totalFreezesDurationMs: health.totalFreezesDurationMs,
      nackCount: health.nackCount,
      pliCount: health.pliCount,
      firCount: health.firCount
    });
  }, []);

  async function start() {
    const token = runTokenRef.current + 1;
    const selectedDurationSeconds = durationSeconds;
    runTokenRef.current = token;
    setRunState("loading");
    setReports([]);
    setComparison(null);
    setError(null);
    setLiveHealth(null);
    const startedAt = new Date().toISOString();
    setRunStartedAt(startedAt);
    setRunCompletedAt(null);
    setRunDurationSeconds(selectedDurationSeconds);

    try {
      const response = await fetch(`/api/admin/monitor/courts/${courtNumber}/pacing-sources`, { cache: "no-store" });
      const payload = await response.json().catch(() => null) as PacingSources | { error?: string } | null;
      if (!response.ok || !payload || !("preview" in payload)) {
        throw new Error(payload && "error" in payload ? payload.error : "Path sources are unavailable.");
      }
      if (runTokenRef.current !== token) return;

      setRunState("running");
      const completed: PhaseReport[] = [];
      for (let index = 0; index < PHASES.length; index += 1) {
        if (runTokenRef.current !== token) return;
        const phase = PHASES[index];
        const source = payload[phase.branch];
        const phaseStartedAtMs = Date.now();
        const active: ActivePhase = {
          phase: phase.id,
          branch: phase.branch,
          path: source.path,
          collectAfterMs: phaseStartedAtMs + WARMUP_MS,
          samples: []
        };
        activePhaseRef.current = active;
        setActivePhaseIndex(index);
        setPhaseCollectsAtMs(active.collectAfterMs);
        setPhaseEndsAtMs(active.collectAfterMs + selectedDurationSeconds * 1_000);
        setActiveSource({ phase: phase.id, whepUrl: source.whepUrl });
        setLiveHealth(null);
        await wait(WARMUP_MS + selectedDurationSeconds * 1_000);
        if (runTokenRef.current !== token) return;

        setActiveSource(null);
        activePhaseRef.current = null;
        const report: PhaseReport = {
          phase: phase.id,
          branch: phase.branch,
          path: active.path,
          startedAt: new Date(active.collectAfterMs).toISOString(),
          completedAt: new Date().toISOString(),
          summary: summarizePacingSamples(active.samples),
          samples: active.samples
        };
        completed.push(report);
        setReports([...completed]);
        setLiveHealth(null);
        await wait(1_000);
      }

      if (runTokenRef.current !== token) return;
      const result = comparePacingPhases(completed[0].summary, completed[1].summary, completed[2].summary);
      setComparison(result);
      setRunCompletedAt(new Date().toISOString());
      setRunState("complete");
      setActivePhaseIndex(-1);
      setPhaseCollectsAtMs(null);
      setPhaseEndsAtMs(null);
    } catch (caught) {
      if (runTokenRef.current !== token) return;
      stop(caught instanceof Error ? caught.message : "Path test failed.");
    }
  }

  const phaseStatus = useMemo(() => {
    if (runState !== "running" || activePhaseIndex < 0 || phaseEndsAtMs == null || phaseCollectsAtMs == null) return null;
    if (clockMs < phaseCollectsAtMs) return `Warmup ${Math.max(0, Math.ceil((phaseCollectsAtMs - clockMs) / 1_000))}s`;
    return `${Math.max(0, Math.ceil((phaseEndsAtMs - clockMs) / 1_000))}s`;
  }, [activePhaseIndex, clockMs, phaseCollectsAtMs, phaseEndsAtMs, runState]);

  function downloadReport() {
    if (!comparison || !runStartedAt || !runCompletedAt || runDurationSeconds == null) return;
    const body = JSON.stringify({
      version: 1,
      courtNumber,
      phaseDurationSeconds: runDurationSeconds,
      warmupSeconds: WARMUP_MS / 1_000,
      startedAt: runStartedAt,
      completedAt: runCompletedAt,
      comparison,
      phases: reports
    }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `scorecheck-court-${courtNumber}-pacing-${runStartedAt.replaceAll(":", "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="monitor-pacing" aria-label={`Court ${courtNumber} preview and program pacing test`}>
      <header className="monitor-pacing-head">
        <div><p className="eyebrow">Transport diagnostics</p><h3>Path pacing test</h3></div>
        <div className="monitor-pacing-controls">
          <label>Phase
            <select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))} disabled={runState === "loading" || runState === "running"}>
              <option value={60}>1 min</option>
              <option value={120}>2 min</option>
              <option value={300}>5 min</option>
            </select>
          </label>
          {runState === "loading" || runState === "running" ? (
            <button type="button" onClick={() => stop()}><Square size={15} /> Stop</button>
          ) : (
            <button type="button" onClick={() => void start()}><Play size={15} /> Run A/B/A</button>
          )}
          {comparison && <button className="monitor-icon-button" type="button" onClick={downloadReport} title="Download pacing evidence" aria-label="Download pacing evidence"><Download size={17} /></button>}
        </div>
      </header>

      <div className="monitor-pacing-phases" aria-label="Test phases">
        {PHASES.map((phase, index) => {
          const report = reports.find((entry) => entry.phase === phase.id);
          const state = report ? (report.summary.sufficient ? "complete" : "insufficient") : index === activePhaseIndex ? "active" : "pending";
          return <div key={phase.id} data-state={state}><span>{index + 1}</span><strong>{phase.label}</strong>{index === activePhaseIndex && phaseStatus ? <small>{phaseStatus}</small> : report ? <small>{formatRatio(report.summary.frameDropRatio)} drop</small> : null}</div>;
        })}
      </div>

      {error && <div className="monitor-banner" role="alert">{error}</div>}

      {activeSource && (
        <div className="monitor-pacing-live">
          <div className="monitor-pacing-player">
            <StreamPlayer
              key={`${courtNumber}:${activeSource.phase}`}
              courtNumber={courtNumber}
              sources={{ whepUrl: activeSource.whepUrl, hlsUrl: null }}
              mode="preview"
              chromeless
              onConnectionHealth={onConnectionHealth}
            />
          </div>
          <div className="monitor-pacing-live-metrics">
            <PacingMetric label="State" value={liveHealth?.connectionState ?? "connecting"} />
            <PacingMetric label="FPS" value={formatNumber(liveHealth?.framesPerSecond, 1)} />
            <PacingMetric label="Dropped" value={formatCount(liveHealth?.framesDropped)} />
            <PacingMetric label="Freezes" value={formatCount(liveHealth?.freezeCount)} />
            <PacingMetric label="Jitter buf" value={formatMs(liveHealth?.jitterBufferMs)} />
            <PacingMetric label="RTT" value={formatMs(liveHealth?.rttMs)} />
          </div>
        </div>
      )}

      {reports.length > 0 && (
        <div className="monitor-pacing-results" role="table" aria-label="Pacing phase results">
          <div className="monitor-pacing-result is-heading" role="row"><span>Phase</span><span>Drop</span><span>Frozen</span><span>FPS</span><span>Jitter buffer</span><span>RTP loss</span></div>
          {reports.map((report) => (
            <div className="monitor-pacing-result" role="row" key={report.phase} data-state={report.summary.sufficient ? "complete" : "insufficient"}>
              <strong>{PHASES.find((phase) => phase.id === report.phase)?.label}</strong>
              <span>{formatRatio(report.summary.frameDropRatio)}</span>
              <span>{formatRatio(report.summary.freezeTimeRatio)}</span>
              <span>{formatNumber(report.summary.medianFps, 1)}</span>
              <span>{formatMs(report.summary.p95JitterBufferMs)}</span>
              <span>{formatRatio(report.summary.packetLossRatio)}</span>
            </div>
          ))}
        </div>
      )}

      {comparison && <div className="monitor-pacing-verdict" data-classification={comparison.classification}><Activity size={17} /><div><strong>{comparison.classification.replaceAll("_", " ")}</strong><p>{comparison.summary}</p></div></div>}
    </section>
  );
}

function PacingMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function formatRatio(value: number | null | undefined): string {
  return value == null ? "--" : `${(value * 100).toFixed(2)}%`;
}

function formatMs(value: number | null | undefined): string {
  return value == null ? "--" : `${Math.round(value)} ms`;
}

function formatNumber(value: number | null | undefined, digits: number): string {
  return value == null ? "--" : value.toFixed(digits);
}

function formatCount(value: number | null | undefined): string {
  return value == null ? "--" : Math.trunc(value).toLocaleString();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
