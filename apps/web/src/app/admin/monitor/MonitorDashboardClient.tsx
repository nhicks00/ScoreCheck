"use client";

import {
  Activity,
  AlertTriangle,
  Bell,
  BellOff,
  Camera,
  CheckCircle2,
  Clock3,
  Eye,
  Gauge,
  Headphones,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  Signal,
  VideoOff,
  WifiOff,
  X,
  Youtube
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StreamPlayer } from "@/components/StreamPlayer";
import type { MonitorCourt, MonitorCourtPipelineRange, MonitorHealthState, MonitorIncident, MonitorMediaPath, MonitorSilence, MonitorSnapshotEnvelope, MonitorStage } from "@/lib/monitoringTypes";
import { PacingComparator } from "./PacingComparator";

const POLL_INTERVAL_MS = 5_000;
const STATE_RANK: Record<MonitorHealthState, number> = { CRITICAL: 9, UNKNOWN: 8, DEGRADED: 7, RECOVERING: 6, STARTING: 5, HEALTHY: 4, MAINTENANCE: 3, EXPECTED_OFF: 2, NOT_APPLICABLE: 1 };

export function MonitorDashboardClient({ initial, configured }: { initial: MonitorSnapshotEnvelope | null; configured: boolean }) {
  const [envelope, setEnvelope] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(initial ? null : configured ? "Monitoring data is unavailable." : "Monitoring API is not configured.");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCourt, setSelectedCourt] = useState(() => firstAttentionCourt(initial) ?? 1);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [mobileInspectionOpen, setMobileInspectionOpen] = useState(false);
  const [inspectionQuality, setInspectionQuality] = useState<"data_saver" | "detail">("data_saver");
  const [pacingOpen, setPacingOpen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [ackReasons, setAckReasons] = useState<Record<string, string>>({});
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [ackError, setAckError] = useState<Record<string, string | undefined>>({});
  const [silenceReasons, setSilenceReasons] = useState<Record<string, string>>({});
  const [silenceDurations, setSilenceDurations] = useState<Record<string, number>>({});
  const [silenceBusy, setSilenceBusy] = useState<string | null>(null);
  const [silenceError, setSilenceError] = useState<Record<string, string | undefined>>({});
  const [nowMs, setNowMs] = useState(() => initial ? Date.parse(initial.fetchedAt) : 0);
  const [history, setHistory] = useState<MonitorCourtPipelineRange | null>(null);
  const previousCriticalIds = useRef(new Set(initial?.snapshot.incidents.filter((incident) => incident.severity === "critical").map((incident) => incident.id) ?? []));
  const previewBeforePacing = useRef(false);
  const inspectionRef = useRef<HTMLElement | null>(null);
  const inspectionCloseRef = useRef<HTMLButtonElement | null>(null);
  const cameraNavScrollRef = useRef<HTMLDivElement | null>(null);

  const closeMobileInspection = useCallback(() => {
    setMobileInspectionOpen(false);
    setPreviewEnabled(false);
    setPacingOpen(false);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-camera-inspect="${selectedCourt}"]`)?.focus();
    });
  }, [selectedCourt]);

  useEffect(() => {
    setSoundEnabled(window.localStorage.getItem("scorecheck-monitor-sound") === "on");
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!mobileInspectionOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => inspectionCloseRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMobileInspection();
        return;
      }
      if (event.key !== "Tab" || !inspectionRef.current) return;
      const focusable = Array.from(inspectionRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], video[controls], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.hasAttribute("hidden"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeMobileInspection, mobileInspectionOpen]);

  useEffect(() => {
    const mobileQuery = window.matchMedia("(max-width: 860px)");
    const onViewportChange = (event: MediaQueryListEvent) => {
      if (event.matches && (previewEnabled || pacingOpen)) setMobileInspectionOpen(true);
      if (!event.matches) setMobileInspectionOpen(false);
    };
    mobileQuery.addEventListener("change", onViewportChange);
    return () => mobileQuery.removeEventListener("change", onViewportChange);
  }, [pacingOpen, previewEnabled]);

  useEffect(() => {
    const scroller = cameraNavScrollRef.current;
    const selectedButton = scroller?.querySelector<HTMLElement>(`[data-camera-jump="${selectedCourt}"]`);
    if (!scroller || !selectedButton || !window.matchMedia("(max-width: 860px)").matches) return;
    const left = selectedButton.offsetLeft - (scroller.clientWidth - selectedButton.offsetWidth) / 2;
    scroller.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [selectedCourt]);

  const refresh = useCallback(async () => {
    if (!configured) return;
    setRefreshing(true);
    try {
      const response = await fetch("/api/admin/monitor/snapshot", { cache: "no-store" });
      const payload = await response.json().catch(() => null) as MonitorSnapshotEnvelope | { error?: string } | null;
      if (!response.ok || !payload || !("snapshot" in payload)) throw new Error(payload && "error" in payload ? payload.error : "Monitoring poll failed.");
      setEnvelope(payload);
      setPollError(null);
      const criticalIds = new Set(payload.snapshot.incidents.filter((incident) => incident.severity === "critical" && incident.status === "open").map((incident) => incident.id));
      const newCritical = [...criticalIds].find((id) => !previousCriticalIds.current.has(id));
      if (newCritical) {
        const incident = payload.snapshot.incidents.find((entry) => entry.id === newCritical);
        if (incident?.courtNumber) {
          setSelectedCourt(incident.courtNumber);
          setPreviewEnabled(false);
          setPacingOpen(false);
        }
        if (soundEnabled) playAlertTone();
      }
      previousCriticalIds.current = criticalIds;
    } catch (error) {
      setPollError(error instanceof Error ? error.message : "Monitoring poll failed.");
    } finally {
      setRefreshing(false);
    }
  }, [configured, soundEnabled]);

  useEffect(() => {
    if (!configured) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_INTERVAL_MS);
    const onVisibility = () => !document.hidden && void refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [configured, refresh]);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    async function refreshHistory() {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/admin/monitor/range/court-pipeline", { cache: "no-store" });
        const payload = await response.json().catch(() => null) as MonitorCourtPipelineRange | null;
        if (!cancelled && response.ok && payload?.courts) setHistory(payload);
      } catch {
        // Current health remains authoritative when optional trend history is unavailable.
      }
    }
    void refreshHistory();
    const timer = window.setInterval(() => void refreshHistory(), 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [configured]);

  function toggleSound() {
    const next = !soundEnabled;
    setSoundEnabled(next);
    window.localStorage.setItem("scorecheck-monitor-sound", next ? "on" : "off");
    if (next) playAlertTone();
  }

  function inspectCamera(courtNumber: number) {
    const mobile = window.matchMedia("(max-width: 860px)").matches;
    setSelectedCourt(courtNumber);
    setPreviewEnabled(true);
    setPacingOpen(false);
    setMobileInspectionOpen(mobile);
    window.requestAnimationFrame(() => {
      if (mobile) inspectionRef.current?.scrollTo({ top: 0 });
      else inspectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function jumpToCamera(courtNumber: number) {
    setSelectedCourt(courtNumber);
    setMobileInspectionOpen(false);
    setPreviewEnabled(false);
    setPacingOpen(false);
    window.requestAnimationFrame(() => {
      document.getElementById(`monitor-camera-${courtNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function acknowledge(incident: MonitorIncident) {
    const reason = ackReasons[incident.id]?.trim() ?? "";
    if (reason.length < 3) {
      setAckError((current) => ({ ...current, [incident.id]: "Enter a brief reason." }));
      return;
    }
    setAckBusy(incident.id);
    setAckError((current) => ({ ...current, [incident.id]: undefined }));
    try {
      const response = await fetch(`/api/admin/monitor/incidents/${incident.id}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason })
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "Acknowledgement failed.");
      setAckReasons((current) => ({ ...current, [incident.id]: "" }));
      await refresh();
    } catch (error) {
      setAckError((current) => ({ ...current, [incident.id]: error instanceof Error ? error.message : "Acknowledgement failed." }));
    } finally {
      setAckBusy(null);
    }
  }

  async function silenceIncident(incident: MonitorIncident) {
    const reason = silenceReasons[incident.id]?.trim() ?? "";
    if (reason.length < 3) {
      setSilenceError((current) => ({ ...current, [incident.id]: "Enter a brief maintenance reason." }));
      return;
    }
    setSilenceBusy(incident.id);
    setSilenceError((current) => ({ ...current, [incident.id]: undefined }));
    try {
      const response = await fetch("/api/admin/monitor/silences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: incident.eventId,
          courtNumber: incident.courtNumber,
          stage: incident.stage,
          issueCode: incident.issueCode,
          reason,
          durationMinutes: silenceDurations[incident.id] ?? 30
        })
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? "Silence failed.");
      setSilenceReasons((current) => ({ ...current, [incident.id]: "" }));
      await refresh();
    } catch (error) {
      setSilenceError((current) => ({ ...current, [incident.id]: error instanceof Error ? error.message : "Silence failed." }));
    } finally {
      setSilenceBusy(null);
    }
  }

  if (!envelope) {
    return (
      <section className="monitor-empty" role="status">
        <WifiOff size={26} aria-hidden="true" />
        <div><strong>Monitoring unavailable</strong><p>{pollError}</p></div>
        <button type="button" onClick={() => void refresh()} disabled={!configured || refreshing}><RefreshCw size={16} /> Retry</button>
      </section>
    );
  }

  const snapshot = envelope.snapshot;
  const snapshotAgeMs = Math.max(0, nowMs - Date.parse(snapshot.generatedAt));
  const stale = envelope.source === "checkpoint" || snapshotAgeMs > 15_000;
  const overall = systemState(snapshot.courts, snapshot.incidents);
  const selected = snapshot.courts.find((court) => court.courtNumber === selectedCourt) ?? snapshot.courts[0] ?? null;
  const dataSaverAdmitted = selected?.expectation.broadcastExpectation !== "LIVE";
  const activeInspectionQuality = dataSaverAdmitted ? inspectionQuality : "detail";
  const activeIncidents = snapshot.incidents.filter((incident) => incident.status !== "resolved");
  const activeSilences = snapshot.silences.filter((silence) => Date.parse(silence.expiresAt) > nowMs);

  function togglePacing() {
    if (pacingOpen) {
      setPacingOpen(false);
      setPreviewEnabled(previewBeforePacing.current);
      return;
    }
    previewBeforePacing.current = previewEnabled;
    setPreviewEnabled(false);
    setPacingOpen(true);
  }

  return (
    <div className="monitor-dashboard">
      <header className="monitor-heading">
        <div>
          <p className="eyebrow">Live operations</p>
          <div className="monitor-title-line"><h1>System Monitor</h1><StateBadge state={overall} label={systemStateLabel(overall)} /></div>
          <p className="monitor-event-name">{snapshot.event?.name ?? "No active event"}</p>
        </div>
        <div className="monitor-heading-actions">
          <button className="monitor-icon-button" type="button" onClick={toggleSound} title={soundEnabled ? "Disable dashboard alert sound" : "Enable dashboard alert sound"} aria-label={soundEnabled ? "Disable dashboard alert sound" : "Enable dashboard alert sound"}>
            {soundEnabled ? <Bell size={18} /> : <BellOff size={18} />}
          </button>
          <button className="monitor-icon-button" type="button" onClick={() => void refresh()} disabled={refreshing} title="Refresh monitoring data" aria-label="Refresh monitoring data">
            <RefreshCw className={refreshing ? "is-spinning" : ""} size={18} />
          </button>
        </div>
      </header>

      <nav className="monitor-mobile-camera-nav" aria-label="Jump to camera">
        <span>Cameras</span>
        <div ref={cameraNavScrollRef}>
          {snapshot.courts.map((court) => {
            const state = effectiveCourtState(court);
            return (
              <button
                key={court.courtNumber}
                type="button"
                className={court.courtNumber === selectedCourt ? "is-selected" : ""}
                onClick={() => jumpToCamera(court.courtNumber)}
                aria-current={court.courtNumber === selectedCourt ? "true" : undefined}
                aria-label={`Jump to Camera ${court.courtNumber}, ${systemStateLabel(state)}`}
                data-camera-jump={court.courtNumber}
              >
                <StateDot state={state} />
                <strong>Camera {court.courtNumber}</strong>
              </button>
            );
          })}
        </div>
      </nav>

      <section className="monitor-global-strip" aria-label="Global health">
        <GlobalItem icon={<Activity size={17} />} label="Collector" value={`${snapshot.collector.agentsFresh}/${snapshot.collector.agentsExpected} agents`} state={snapshot.collector.state} />
        <GlobalItem icon={<Signal size={17} />} label="Control" value={snapshot.controlPlane.worker.state === "NOT_APPLICABLE" ? "Idle" : snapshot.controlPlane.worker.state} state={snapshot.controlPlane.state} />
        <GlobalItem icon={<Youtube size={17} />} label="YouTube" value={friendlyState(snapshot.youtube.state)} state={snapshot.youtube.state} />
        <GlobalItem icon={<Bell size={17} />} label="Paging" value={pagingLabel(snapshot.notifications)} state={snapshot.notifications.state === "DEGRADED" ? "DEGRADED" : snapshot.notifications.state === "UNKNOWN" ? "UNKNOWN" : snapshot.notifications.state === "HEALTHY" ? "HEALTHY" : "NOT_APPLICABLE"} />
        <GlobalItem icon={<Radio size={17} />} label="Watchdog" value={deadManLabel(snapshot.deadMan)} state={snapshot.deadMan.state === "DEGRADED" ? "DEGRADED" : snapshot.deadMan.state === "UNKNOWN" ? "UNKNOWN" : snapshot.deadMan.state === "HEALTHY" ? "HEALTHY" : "NOT_APPLICABLE"} />
        <GlobalItem icon={<ShieldAlert size={17} />} label="Incidents" value={activeIncidents.length ? `${activeIncidents.length} active` : "Clear"} state={activeIncidents.some((incident) => incident.severity === "critical") ? "CRITICAL" : activeIncidents.length ? "DEGRADED" : "HEALTHY"} />
        <div className={`monitor-freshness ${stale ? "is-stale" : ""}`}>
          <Clock3 size={16} aria-hidden="true" />
          <span>{envelope.source === "checkpoint" ? "Checkpoint" : `${formatDuration(snapshotAgeMs)} ago`}</span>
        </div>
      </section>

      {(pollError || envelope.monitorError || stale) && (
        <div className="monitor-banner" role="alert"><AlertTriangle size={17} /><span>{pollError ?? envelope.monitorError ?? "Monitoring snapshot is stale."}</span></div>
      )}

      <div className="monitor-bandwidth-note">
        <Camera size={17} aria-hidden="true" />
        <div><strong>Low-data overview</strong><span>Camera cards use one 256×144 snapshot every 15 seconds. Live video opens only for the selected camera.</span></div>
      </div>

      <section className="monitor-court-matrix" aria-label="Camera monitoring matrix">
        {snapshot.courts.map((court) => (
          <CourtCard key={court.courtNumber} court={court} history={history?.courts.find((entry) => entry.courtNumber === court.courtNumber) ?? null} selected={court.courtNumber === selectedCourt} nowMs={nowMs} onSelect={() => inspectCamera(court.courtNumber)} />
        ))}
      </section>

      {selected && (
        <section
          ref={inspectionRef}
          className={`monitor-detail-band ${mobileInspectionOpen ? "is-mobile-open" : ""}`}
          aria-label={`Camera ${selected.courtNumber} live inspection`}
          role={mobileInspectionOpen ? "dialog" : undefined}
          aria-modal={mobileInspectionOpen || undefined}
        >
          <div className="monitor-mobile-inspection-bar">
            <button ref={inspectionCloseRef} type="button" onClick={closeMobileInspection} aria-label="Return to camera list">
              <X size={19} aria-hidden="true" />
              <span>Camera list</span>
            </button>
            <strong>Camera {selected.courtNumber} inspection</strong>
          </div>
          <div className="monitor-section-heading">
            <div><p className="eyebrow">Live inspection</p><h2>Camera {selected.courtNumber}</h2><p className="monitor-detail-assignment">{assignedCourtLabel(selected)}</p></div>
            <div className="monitor-detail-actions">
              <label className="monitor-quality-control">
                <span>Video quality</span>
                <select value={activeInspectionQuality} onChange={(event) => setInspectionQuality(event.target.value as "data_saver" | "detail")}>
                  <option value="data_saver" disabled={!dataSaverAdmitted}>{dataSaverAdmitted ? "Data saver · 360p / 10 fps · ~0.4 Mbps" : "Data saver · unavailable during full production"}</option>
                  <option value="detail">Detail · 720p / 30 fps · ~2.6 Mbps</option>
                </select>
              </label>
              <button type="button" className="button ghost" onClick={() => setPreviewEnabled(false)} disabled={!previewEnabled || pacingOpen}><VideoOff size={16} /> Close video</button>
              <button type="button" className="button ghost" onClick={togglePacing} aria-expanded={pacingOpen}><Gauge size={16} /> {pacingOpen ? "Close path test" : "Path test"}</button>
              <StateBadge state={effectiveCourtState(selected)} label={systemStateLabel(effectiveCourtState(selected))} />
            </div>
          </div>
          <div className="monitor-inspection-grid">
            <div className="monitor-live-player">
              {pacingOpen ? <div className="monitor-preview-paused"><Gauge size={18} /><span>Live video paused for isolated path test</span></div> : previewEnabled ? <StreamPlayer key={`${selected.courtNumber}-${activeInspectionQuality}`} courtNumber={selected.courtNumber} adminQuality={activeInspectionQuality} enabled /> : (
                <button className="monitor-preview-start" type="button" onClick={() => setPreviewEnabled(true)}><Eye size={18} /> Open live video</button>
              )}
            </div>
            <div className="monitor-stage-detail">
              {selected.stages.map((stage) => <StageDetail key={stage.stage} stage={stage} />)}
            </div>
          </div>
          {pacingOpen && <PacingComparator courtNumber={selected.courtNumber} />}
        </section>
      )}

      <section className="monitor-shared-band" aria-label="Shared services">
        <div className="monitor-section-heading"><div><p className="eyebrow">Shared dependencies</p><h2>Hosts &amp; services</h2></div></div>
        <div className="monitor-agent-grid">
          {snapshot.agents.map((agent) => (
            <article className="monitor-agent" key={agent.agentId} data-state={agent.state}>
              <div className="monitor-agent-head"><Server size={17} /><strong>{agent.agentId}</strong><StateDot state={agent.state} /></div>
              <div className="monitor-agent-metrics">
                <Metric label="Load" value={agent.host ? agent.host.load1.toFixed(2) : "--"} />
                <Metric label="Memory" value={agent.host ? percent(agent.host.memoryTotalBytes - agent.host.memoryAvailableBytes, agent.host.memoryTotalBytes) : "--"} />
                <Metric label="Disk" value={agent.host?.diskTotalBytes && agent.host.diskFreeBytes != null ? percent(agent.host.diskTotalBytes - agent.host.diskFreeBytes, agent.host.diskTotalBytes) : "--"} />
              </div>
              <div className="monitor-service-list">
                {agent.services.map((service) => <span key={service.name} className={service.running && service.healthy !== false && !service.oomKilled ? "is-ok" : "is-bad"}>{service.name} · {service.restartCount}r</span>)}
                {agent.nativeServices?.egress && <span className={agent.nativeServices.egress.canAcceptRequest ? "is-ok" : "is-bad"}>Egress {agent.nativeServices.egress.idle ? "idle" : "busy"} · {agent.nativeServices.egress.canAcceptRequest ? "ready" : "at capacity"} · CPU {formatPercentRatio(agent.nativeServices.egress.cpuLoadRatio)}</span>}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="monitor-incidents-band" aria-label="Active incidents">
        <div className="monitor-section-heading"><div><p className="eyebrow">Incident queue</p><h2>{activeIncidents.length ? `${activeIncidents.length} active${activeSilences.length ? ` · ${activeSilences.length} silenced` : ""}` : "No active incidents"}</h2></div></div>
        {activeIncidents.length > 0 && (
          <div className="monitor-incident-list">
            {activeIncidents.map((incident) => {
              const silence = matchingSilence(incident, activeSilences, nowMs);
              return (
              <article className="monitor-incident" key={incident.id} data-severity={incident.severity}>
                <div className="monitor-incident-main">
                  <div className="monitor-incident-title"><StateDot state={incident.severity === "critical" ? "CRITICAL" : "DEGRADED"} /><strong>{incident.issueCode}</strong><span>{incident.courtNumber ? `Court ${incident.courtNumber}` : incident.rootDependency}</span></div>
                  <p>{incident.summary}</p>
                  {incident.firstAction && <p className="monitor-first-action"><strong>First action:</strong> {incident.firstAction}</p>}
                </div>
                <div className="monitor-incident-actions">
                  {incident.status === "open" ? (
                    <div className="monitor-ack-form">
                      <input aria-label={`Acknowledgement reason for ${incident.issueCode}`} value={ackReasons[incident.id] ?? ""} onChange={(event) => setAckReasons((current) => ({ ...current, [incident.id]: event.target.value }))} placeholder="Acknowledgement reason" maxLength={300} />
                      <button type="button" onClick={() => void acknowledge(incident)} disabled={ackBusy === incident.id}><CheckCircle2 size={16} /> Acknowledge</button>
                      {ackError[incident.id] && <span className="monitor-form-error">{ackError[incident.id]}</span>}
                    </div>
                  ) : <span className="status info">Acknowledged by {incident.acknowledgedBy ?? "operator"}</span>}
                  {silence ? (
                    <span className="status warning">Paging silenced until {formatTime(silence.expiresAt)} · {silence.reason}</span>
                  ) : incident.status === "open" && (
                    <div className="monitor-silence-form">
                      <input aria-label={`Silence reason for ${incident.issueCode}`} value={silenceReasons[incident.id] ?? ""} onChange={(event) => setSilenceReasons((current) => ({ ...current, [incident.id]: event.target.value }))} placeholder="Planned maintenance reason" maxLength={300} />
                      <select aria-label={`Silence duration for ${incident.issueCode}`} value={silenceDurations[incident.id] ?? 30} onChange={(event) => setSilenceDurations((current) => ({ ...current, [incident.id]: Number(event.target.value) }))}>
                        <option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>1 hour</option><option value={120}>2 hours</option>
                      </select>
                      <button type="button" onClick={() => void silenceIncident(incident)} disabled={silenceBusy === incident.id}><BellOff size={16} /> Silence</button>
                      {silenceError[incident.id] && <span className="monitor-form-error">{silenceError[incident.id]}</span>}
                    </div>
                  )}
                </div>
              </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function matchingSilence(incident: MonitorIncident, silences: MonitorSilence[], nowMs: number): MonitorSilence | null {
  return silences.find((silence) => Date.parse(silence.expiresAt) > nowMs
    && (silence.eventId == null || silence.eventId === incident.eventId)
    && (silence.courtNumber == null || silence.courtNumber === incident.courtNumber)
    && (silence.stage == null || silence.stage === incident.stage)
    && (silence.issueCode == null || silence.issueCode === incident.issueCode)) ?? null;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function CourtCard({ court, history, selected, nowMs, onSelect }: { court: MonitorCourt; history: MonitorCourtPipelineRange["courts"][number] | null; selected: boolean; nowMs: number; onSelect: () => void }) {
  const browser = court.browser;
  const raw = court.paths.raw;
  const preview = court.ffmpeg.preview;
  const cameraStage = court.stages.find((stage) => stage.stage === "RAW_INGEST");
  const cameraState = cameraStage?.state ?? "UNKNOWN";
  const productionState = productionPipelineState(court);
  const effectiveState = effectiveCourtState(court);
  const current = court.competition?.currentMatch;
  const score = court.competition?.score;
  const relevantStages = court.stages.filter((stage) => stage.stage === "RAW_INGEST"
    || court.expectation.broadcastExpectation !== "OFF"
    || court.expectation.commentaryExpectation !== "NONE"
    || court.expectation.scoringExpectation !== "NONE");
  const issue = relevantStages.find((stage) => stage.state === "CRITICAL") ?? relevantStages.find((stage) => ["DEGRADED", "UNKNOWN"].includes(stage.state));
  const thumbnailFresh = court.thumbnail && nowMs - Date.parse(court.thumbnail.receivedAt) <= 45_000;
  const browserLost = browser?.video.packetsLost;
  const browserReceived = browser?.video.packetsReceived;
  const loss = browserLost != null && browserReceived != null
    ? percent(browserLost, browserLost + browserReceived)
    : transportLoss(raw);
  const rttMs = browser?.video.rttMs ?? raw?.transport?.rttMs;
  const rawTrend = history?.rawBitrate ?? [];
  const fpsTrend = history?.programFps.length ? history.programFps : history?.previewFps ?? [];
  return (
    <article id={`monitor-camera-${court.courtNumber}`} className={`monitor-court ${selected ? "is-selected" : ""}`} data-state={effectiveState}>
      <header className="monitor-court-head">
        <div><span className="monitor-court-number">{court.courtNumber}</span><div><h2>Camera {court.courtNumber}</h2><p>{assignedCourtLabel(court)} · {court.expectation.coveragePhase.replaceAll("_", " ")}</p></div></div>
        <div className="monitor-court-statuses">
          <StateBadge state={cameraState} compact label={cameraStateLabel(raw, cameraState)} />
          <StateBadge state={productionState} compact label={pipelineStateLabel(productionState)} />
        </div>
      </header>
      <button className="monitor-thumbnail" type="button" onClick={onSelect} aria-label={`Inspect Camera ${court.courtNumber}`} data-camera-inspect={court.courtNumber}>
        {thumbnailFresh ? <>
          {/* Authenticated no-store snapshots intentionally bypass the Next image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/admin/monitor/courts/${court.courtNumber}/thumbnail?t=${encodeURIComponent(court.thumbnail!.receivedAt)}`} alt={`Latest low-data snapshot from Camera ${court.courtNumber}`} />
          <span className="monitor-thumbnail-meta">256×144 snapshot · {formatDuration(nowMs - Date.parse(court.thumbnail!.receivedAt))} ago</span>
        </> : <div className="monitor-thumbnail-empty"><Camera size={24} /><span>{raw?.ready ? "Snapshot not available" : "Camera feed is offline"}</span></div>}
        <span className="monitor-thumbnail-action"><Eye size={15} /> Open live video</span>
      </button>
      <div className="monitor-metrics">
        <Metric label="Camera bitrate" value={formatBitrate(raw?.inboundBitrateBps)} />
        <Metric label="Preview speed" value={formatFps(preview?.framesPerSecond)} />
        <Metric label="Rendered speed" value={formatFps(browser?.video.framesPerSecond)} />
        <Metric label="Picture size" value={browser?.video.width && browser.video.height ? `${browser.video.width}×${browser.video.height}` : "--"} />
        <Metric label="Network delay" value={formatMs(rttMs)} />
        <Metric label="Packet loss" value={loss} />
      </div>
      <div className="monitor-trends" aria-label="Five minute trends">
        <div className="monitor-trends-heading"><strong>Last 5 minutes</strong><div className="monitor-trends-legend"><span className="is-bitrate">Camera bitrate · {formatBitrate(latestPoint(rawTrend))}</span><span className="is-fps">Rendered speed · {formatFps(latestPoint(fpsTrend))}</span></div></div>
        <div className="monitor-trends-plots">
          <Sparkline values={rawTrend} label="Camera bitrate, five minutes" className="is-bitrate" />
          <Sparkline values={fpsTrend} label="Rendered frames per second, five minutes" className="is-fps" fixedMax={30} />
        </div>
      </div>
      <div className="monitor-stage-grid">
        {court.stages.map((stage) => <StageRow key={stage.stage} stage={stage} />)}
      </div>
      <div className="monitor-match">
        {current ? <><div><strong>{current.teamA ?? "TBD"}</strong><span>{score ? `${score.teamASets} · ${score.teamAScore}` : "--"}</span></div><div><strong>{current.teamB ?? "TBD"}</strong><span>{score ? `${score.teamBSets} · ${score.teamBScore}` : "--"}</span></div><p>{current.roundName ?? "Match"}{current.matchNumber ? ` · #${current.matchNumber}` : ""}</p></> : <p>No current match</p>}
      </div>
      <div className="monitor-court-footer">
        <span className="monitor-source-profile" title={sourceDetail(raw)}><Signal size={14} /> {sourceProfile(raw)}</span>
        <span><Camera size={14} /> {visualLabel(browser)}</span>
        <span><Headphones size={14} /> {commentaryLabel(browser)}</span>
        <span><Youtube size={14} /> {friendlyState(court.youtube?.state ?? "NOT_APPLICABLE")}</span>
        <span title={browserQualityDetail(browser)}><Activity size={14} /> {browserQualityLabel(browser, history)}</span>
        <span><Gauge size={14} /> {browser ? `${browser.video.reconnectCount} reconnects` : "--"}</span>
      </div>
      {issue?.issueCode && <div className="monitor-court-alert"><AlertTriangle size={14} /><span>{issue.summary}</span></div>}
    </article>
  );
}

function StageRow({ stage }: { stage: MonitorStage }) {
  return <div className="monitor-stage-row" title={`${stageLabel(stage.stage)}: ${stage.summary}`}><StateDot state={stage.state} /><span className="monitor-stage-name">{stageLabel(stage.stage)}</span><span className="monitor-stage-state">{stageStateLabel(stage.state)}</span></div>;
}

function StageDetail({ stage }: { stage: MonitorStage }) {
  return <div className="monitor-stage-detail-row" data-state={stage.state}><div><StateDot state={stage.state} /><strong>{stageLabel(stage.stage)}</strong></div><p>{stage.summary}</p>{stage.firstAction && <small>{stage.firstAction}</small>}</div>;
}

function GlobalItem({ icon, label, value, state }: { icon: React.ReactNode; label: string; value: string; state: MonitorHealthState }) {
  return <div className="monitor-global-item" data-state={state}>{icon}<div><span>{label}</span><strong>{value}</strong></div><StateDot state={state} /></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="monitor-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Sparkline({ values, label, className, fixedMax }: { values: Array<[number, number]>; label: string; className: string; fixedMax?: number }) {
  const usable = values.slice(-40).filter((point) => Number.isFinite(point[1]));
  if (usable.length < 2) return <div className={`monitor-sparkline ${className} is-empty`} aria-label={`${label}: unavailable`} />;
  const maximum = Math.max(fixedMax ?? 0, ...usable.map((point) => point[1]), 1);
  const points = usable.map((point, index) => `${(index / (usable.length - 1) * 100).toFixed(2)},${(24 - Math.min(1, point[1] / maximum) * 22).toFixed(2)}`).join(" ");
  return <svg className={`monitor-sparkline ${className}`} viewBox="0 0 100 26" preserveAspectRatio="none" role="img" aria-label={label}><polyline points={points} /></svg>;
}

function StateBadge({ state, compact = false, label }: { state: MonitorHealthState; compact?: boolean; label?: string }) {
  const Icon = state === "CRITICAL" ? ShieldAlert : state === "DEGRADED" || state === "UNKNOWN" ? AlertTriangle : state === "EXPECTED_OFF" || state === "NOT_APPLICABLE" ? Radio : CheckCircle2;
  return <span className={`monitor-state-badge ${compact ? "is-compact" : ""}`} data-state={state}><Icon size={compact ? 13 : 15} />{label ?? friendlyState(state)}</span>;
}

function StateDot({ state }: { state: MonitorHealthState }) {
  return <span className="monitor-state-dot" data-state={state} aria-label={friendlyState(state)} />;
}

function systemState(courts: MonitorCourt[], incidents: MonitorIncident[]): MonitorHealthState {
  if (incidents.some((incident) => incident.status !== "resolved" && incident.severity === "critical")) return "CRITICAL";
  return courts.reduce((worst, court) => {
    const state = effectiveCourtState(court);
    return STATE_RANK[state] > STATE_RANK[worst] ? state : worst;
  }, "NOT_APPLICABLE" as MonitorHealthState);
}

function firstAttentionCourt(envelope: MonitorSnapshotEnvelope | null): number | null {
  const court = envelope?.snapshot.courts.find((entry) => effectiveCourtState(entry) === "CRITICAL")
    ?? envelope?.snapshot.courts.find((entry) => effectiveCourtState(entry) === "DEGRADED");
  return court?.courtNumber ?? null;
}

function assignedCourtLabel(court: MonitorCourt): string {
  const physical = court.competition?.physicalCourtLabel || court.competition?.displayName;
  return physical ? `Assigned to ${physical}` : "Court assignment not set";
}

function stageLabel(stage: MonitorStage["stage"]): string {
  return ({ RAW_INGEST: "Camera feed", PREVIEW: "Video preview", PROGRAM_PATH: "Broadcast video", PROGRAM_BROWSER: "Video renderer", COMMENTARY: "Commentary", SCORE_SOURCE: "Live score", SCORE_RENDER: "Scoreboard", YOUTUBE: "YouTube", EGRESS: "Broadcast output", VENUE: "Venue internet", HOST: "Server", CONTROL: "Control", MONITORING: "Monitoring", NOTIFICATION: "Phone alerts" } as Record<string, string>)[stage] ?? stage;
}

function stageStateLabel(state: MonitorHealthState): string {
  return ({ HEALTHY: "OK", CRITICAL: "Problem", DEGRADED: "Warning", UNKNOWN: "No data", RECOVERING: "Recovering", STARTING: "Starting", MAINTENANCE: "Maintenance", EXPECTED_OFF: "Idle", NOT_APPLICABLE: "Not used" } as Record<MonitorHealthState, string>)[state];
}

function cameraStateLabel(raw: MonitorMediaPath | undefined, state: MonitorHealthState): string {
  if (raw?.ready && state === "HEALTHY") return "Camera live";
  if (raw?.ready && state === "DEGRADED") return "Camera unstable";
  if (raw?.ready && state === "CRITICAL") return "Camera problem";
  if (state === "EXPECTED_OFF" || state === "NOT_APPLICABLE") return "Camera off";
  if (state === "UNKNOWN") return "Camera status unknown";
  return "Camera offline";
}

function productionPipelineState(court: MonitorCourt): MonitorHealthState {
  if (court.expectation.broadcastExpectation === "OFF"
    && court.expectation.commentaryExpectation === "NONE"
    && court.expectation.scoringExpectation === "NONE") {
    return "EXPECTED_OFF";
  }
  const productionStages = court.stages.filter((stage) => stage.stage !== "RAW_INGEST");
  return productionStages.reduce(
    (worst, stage) => STATE_RANK[stage.state] > STATE_RANK[worst] ? stage.state : worst,
    "NOT_APPLICABLE" as MonitorHealthState
  );
}

function effectiveCourtState(court: MonitorCourt): MonitorHealthState {
  const cameraState = court.stages.find((stage) => stage.stage === "RAW_INGEST")?.state ?? "UNKNOWN";
  const productionState = productionPipelineState(court);
  return STATE_RANK[cameraState] > STATE_RANK[productionState] ? cameraState : productionState;
}

function pipelineStateLabel(state: MonitorHealthState): string {
  if (state === "HEALTHY") return "Production ready";
  if (state === "CRITICAL") return "Production issue";
  if (state === "DEGRADED" || state === "UNKNOWN") return "Production warning";
  if (state === "STARTING" || state === "RECOVERING") return friendlyState(state);
  return "Production idle";
}

function systemStateLabel(state: MonitorHealthState): string {
  if (state === "HEALTHY") return "Ready";
  if (state === "CRITICAL") return "Action needed";
  if (state === "DEGRADED" || state === "UNKNOWN") return "Check system";
  if (state === "EXPECTED_OFF" || state === "NOT_APPLICABLE") return "Idle";
  return friendlyState(state);
}

function friendlyState(state: string): string {
  return state.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function formatBitrate(value: number | null | undefined): string {
  if (value == null) return "--";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbps` : `${Math.round(value / 1_000)} kbps`;
}

function formatFps(value: number | null | undefined): string {
  return value == null ? "--" : `${value.toFixed(1)} fps`;
}

function formatMs(value: number | null | undefined): string {
  return value == null ? "--" : `${Math.round(value)} ms`;
}

function sourceProfile(path: MonitorMediaPath | undefined): string {
  if (!path?.sourceProtocol) return "source profile --";
  const mode = path.sourceMode ? ` ${path.sourceMode.toLowerCase()}` : "";
  const resolution = path.videoWidth && path.videoHeight ? ` ${path.videoWidth}×${path.videoHeight}` : "";
  const video = path.videoCodec ? ` · ${path.videoCodec}${resolution}` : "";
  const audio = path.audioCodec ? ` · ${path.audioCodec}` : "";
  return `${path.sourceProtocol}${mode}${video}${audio}`;
}

function sourceDetail(path: MonitorMediaPath | undefined): string {
  if (!path) return "No current media source details.";
  const details = [sourceProfile(path)];
  if (path.videoProfile) details.push(`video profile ${path.videoProfile}`);
  if (path.audioSampleRateHz) details.push(`${Math.round(path.audioSampleRateHz / 1_000)} kHz audio`);
  if (path.audioChannelCount) details.push(`${path.audioChannelCount} audio channels`);
  if (path.transport?.receiveBufferMs != null) details.push(`${Math.round(path.transport.receiveBufferMs)} ms receive buffer`);
  if (path.transport?.configuredLatencyMs != null) details.push(`${Math.round(path.transport.configuredLatencyMs)} ms configured latency`);
  return details.join(" · ");
}

function transportLoss(path: MonitorMediaPath | undefined): string {
  const lost = path?.transport?.packetsLost;
  const received = path?.transport?.packetsReceived;
  return lost != null && received != null ? percent(lost, lost + received) : "--";
}

function percent(value: number, total: number): string {
  return total > 0 ? `${(value / total * 100).toFixed(1)}%` : "0.0%";
}

function browserQualityLabel(browser: MonitorCourt["browser"], history: MonitorCourtPipelineRange["courts"][number] | null): string {
  if (!browser) return "decode --";
  const recentDropRatio = latestPoint(history?.programDropRatio);
  const recentFreezeRatio = latestPoint(history?.programFreezeRatio);
  if (recentDropRatio != null || recentFreezeRatio != null) {
    return `2m ${formatQualityRatio(recentDropRatio)} drop · ${formatQualityRatio(recentFreezeRatio)} frozen`;
  }
  const received = browser.video.framesReceived;
  const dropped = browser.video.framesDropped;
  const dropRatio = received != null && dropped != null ? percent(dropped, received) : "--";
  const freezes = browser.video.freezeCount == null ? "--" : String(browser.video.freezeCount);
  return `${dropRatio} drop · ${freezes} freezes`;
}

function browserQualityDetail(browser: MonitorCourt["browser"]): string {
  if (!browser) return "Program browser decode quality is unavailable.";
  const video = browser.video;
  const freezeDuration = video.totalFreezesDurationMs == null ? "--" : formatDuration(video.totalFreezesDurationMs);
  return `Page session: ${video.framesReceived ?? "--"} received, ${video.framesDecoded ?? "--"} decoded, ${video.framesDropped ?? "--"} dropped, ${video.freezeCount ?? "--"} freezes totaling ${freezeDuration}.`;
}

function latestPoint(points: Array<[number, number]> | undefined): number | null {
  const value = points?.at(-1)?.[1];
  return value != null && Number.isFinite(value) ? value : null;
}

function formatQualityRatio(value: number | null): string {
  return value == null ? "--" : `${(value * 100).toFixed(1)}%`;
}

function formatPercentRatio(value: number | null): string {
  return value == null ? "--" : `${Math.round(value * 100)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

function visualLabel(browser: MonitorCourt["browser"]): string {
  if (!browser?.visual.sampledAt) return "picture --";
  if (browser.visual.blackDurationMs > 0) return `black ${formatDuration(browser.visual.blackDurationMs)}`;
  if (browser.visual.frozenDurationMs > 0) return `still ${formatDuration(browser.visual.frozenDurationMs)}`;
  if (!browser.commentary.cameraTrackPresent) return "audio missing";
  if ((browser.commentary.cameraClippedSampleRatio ?? 0) > 0.05) return "audio clipping";
  return "picture active";
}

function commentaryLabel(browser: MonitorCourt["browser"]): string {
  const commentary = browser?.commentary;
  if (!commentary?.configured) return "off";
  if (!commentary.roomConnected) return "disconnected";
  if (commentary.audioTrackCount === 0) return "no track";
  if (commentary.mutedAudioTrackCount > 0) return "muted";
  if ((commentary.clippedSampleRatio ?? 0) > 0.05) return "clipping";
  if ((commentary.secondsSinceAudio ?? 0) > 60) return "silent";
  return commentary.syncStatus;
}

function pagingLabel(notifications: MonitorSnapshotEnvelope["snapshot"]["notifications"]): string {
  if (notifications.state === "NOT_APPLICABLE") return "Not configured";
  if (notifications.state === "UNKNOWN") return "Not tested";
  return notifications.state === "HEALTHY" ? "Verified" : "Degraded";
}

function deadManLabel(deadMan: MonitorSnapshotEnvelope["snapshot"]["deadMan"]): string {
  if (deadMan.state === "NOT_APPLICABLE") return "Not configured";
  if (deadMan.state === "DEGRADED") return "Delivery failed";
  if (deadMan.state === "UNKNOWN") return "Verifying";
  return deadMan.active.mode === "RUNNING" ? "Coverage active" : "Idle protected";
}

function playAlertTone() {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 740;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.3);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // Browser notification sound is supplemental only.
  }
}
