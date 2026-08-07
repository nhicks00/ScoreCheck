"use client";

import {
  Activity,
  AlertTriangle,
  Bell,
  Camera,
  Cable,
  CheckCircle2,
  Clock3,
  Eye,
  Gauge,
  Headphones,
  LayoutDashboard,
  Network,
  Radio,
  RefreshCw,
  Router as RouterIcon,
  Server,
  ShieldAlert,
  Signal,
  Smartphone,
  VideoOff,
  Wifi,
  WifiOff,
  X,
  Youtube
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { StreamPlayer } from "@/components/StreamPlayer";
import { deriveMonitorBrowserLiveness, type MonitorBrowserLiveness } from "@/lib/monitorBrowserLiveness";
import { deriveMonitorDeadManReadiness } from "@/lib/monitorDeadManReadiness";
import { egressRuntimeHealthy } from "@/lib/monitorEgressPresentation";
import { deriveMonitorPagingReadiness } from "@/lib/monitorPagingReadiness";
import { deriveRawCameraState, isCheckpointEventOperational, isCourtExpectedOff, isMonitorSnapshotCurrent, isTelemetryCurrent, unavailableState } from "@/lib/monitorPresentation";
import type { MonitorAgent, MonitorCourt, MonitorCourtPipelineRange, MonitorHealthState, MonitorMediaPath, MonitorNetworkSwitch, MonitorRouter, MonitorSnapshot, MonitorSnapshotEnvelope, MonitorStage, MonitorUniFi } from "@/lib/monitoringTypes";
import { PacingComparator } from "./PacingComparator";

const POLL_INTERVAL_MS = 5_000;
const STATE_RANK: Record<MonitorHealthState, number> = { CRITICAL: 9, UNKNOWN: 8, DEGRADED: 7, RECOVERING: 6, STARTING: 5, HEALTHY: 4, MAINTENANCE: 3, EXPECTED_OFF: 2, NOT_APPLICABLE: 1 };
const ROUTER_UNAVAILABLE: MonitorRouter = {
  state: "UNKNOWN",
  required: false,
  configured: false,
  apiReachable: null,
  sampledAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  identity: null,
  resources: null,
  speedFusion: null,
  clients: null,
  wans: [],
  problems: []
};
const UNIFI_UNAVAILABLE: MonitorUniFi = {
  state: "NOT_APPLICABLE",
  required: false,
  configured: false,
  apiReachable: null,
  sampledAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  siteId: null,
  expectedAccessPoints: 0,
  onlineAccessPoints: 0,
  connectedClients: 0,
  accessPoints: [],
  clients: [],
  problems: []
};
const SWITCH_UNAVAILABLE: MonitorNetworkSwitch = {
  state: "NOT_APPLICABLE",
  required: false,
  configured: false,
  reachable: null,
  sampledAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  model: null,
  firmwareVersion: null,
  uptimeSeconds: null,
  ports: [],
  poe: { supported: null, budgetWatts: null, consumptionWatts: null, remainingWatts: null },
  problems: []
};
type MonitorTab = "overview" | "cameras" | "wifi" | "switch" | "router" | "system";
const MONITOR_TABS: MonitorTab[] = ["overview", "cameras", "wifi", "switch", "router", "system"];

export function MonitorDashboardClient({ initial, configured }: { initial: MonitorSnapshotEnvelope | null; configured: boolean }) {
  const [envelope, setEnvelope] = useState(initial);
  const [activeTab, setActiveTab] = useState<MonitorTab>("overview");
  const [pollError, setPollError] = useState<string | null>(initial ? null : configured ? "Monitoring data is unavailable." : "Monitoring API is not configured.");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCourt, setSelectedCourt] = useState(() => firstAttentionCourt(initial) ?? 1);
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [mobileInspectionOpen, setMobileInspectionOpen] = useState(false);
  const [inspectionQuality, setInspectionQuality] = useState<"data_saver" | "detail">("data_saver");
  const [pacingOpen, setPacingOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => initial ? Date.parse(initial.fetchedAt) : 0);
  const [history, setHistory] = useState<MonitorCourtPipelineRange | null>(null);
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
    } catch (error) {
      setPollError(error instanceof Error ? error.message : "Monitoring poll failed.");
    } finally {
      setRefreshing(false);
    }
  }, [configured]);

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

  function inspectCamera(courtNumber: number) {
    const mobile = window.matchMedia("(max-width: 860px)").matches;
    setActiveTab("cameras");
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
    setActiveTab("cameras");
    setSelectedCourt(courtNumber);
    setMobileInspectionOpen(false);
    setPreviewEnabled(false);
    setPacingOpen(false);
    window.requestAnimationFrame(() => {
      document.getElementById(`monitor-camera-${courtNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function selectTab(tab: MonitorTab) {
    setActiveTab(tab);
    if (tab !== "cameras") {
      setPreviewEnabled(false);
      setPacingOpen(false);
      setMobileInspectionOpen(false);
    }
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
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
  const router = snapshot.router ?? ROUTER_UNAVAILABLE;
  const unifi = snapshot.unifi ?? UNIFI_UNAVAILABLE;
  const networkSwitch = snapshot.networkSwitch ?? SWITCH_UNAVAILABLE;
  const snapshotAgeMs = Math.max(0, nowMs - Date.parse(snapshot.generatedAt));
  const snapshotCurrent = isMonitorSnapshotCurrent(envelope, nowMs);
  const eventOperational = snapshotCurrent
    ? snapshot.event?.status.toLowerCase() === "active"
    : isCheckpointEventOperational(snapshot.event, nowMs);
  const stale = !snapshotCurrent;
  const routerCurrent = isTelemetryCurrent(snapshotCurrent, router.sampledAt, nowMs, 90_000) && router.apiReachable === true;
  const unifiCurrent = isTelemetryCurrent(snapshotCurrent, unifi.sampledAt, nowMs, 90_000) && unifi.apiReachable === true;
  const switchCurrent = isTelemetryCurrent(snapshotCurrent, networkSwitch.sampledAt, nowMs, 90_000) && networkSwitch.reachable === true;
  const pagingReadiness = deriveMonitorPagingReadiness(snapshot.notifications);
  const deadManReadiness = deriveMonitorDeadManReadiness(snapshot.deadMan);
  const monitorUnavailableMessage = stale && !eventOperational
    ? "Event infrastructure is off. No current telemetry is available, so historical measurements are hidden."
    : pollError ?? envelope.monitorError ?? "Monitoring snapshot is stale.";
  const selected = snapshot.courts.find((court) => court.courtNumber === selectedCourt) ?? snapshot.courts[0] ?? null;
  const dataSaverAdmitted = selected?.expectation.broadcastExpectation !== "LIVE";
  const activeInspectionQuality = dataSaverAdmitted ? inspectionQuality : "detail";
  const activeIncidents = snapshot.incidents.filter((incident) => incident.status !== "resolved");

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
          <div className="monitor-title-line"><h1>System Monitor</h1></div>
          <p className="monitor-event-name">{eventOperational ? snapshot.event?.name : "No active event"}</p>
        </div>
        <div className="monitor-heading-actions">
          <button className="monitor-icon-button" type="button" onClick={() => void refresh()} disabled={refreshing} title="Refresh monitoring data" aria-label="Refresh monitoring data">
            <RefreshCw className={refreshing ? "is-spinning" : ""} size={18} />
          </button>
        </div>
      </header>

      <nav className="monitor-domain-tabs" role="tablist" aria-label="Monitor categories">
        <MonitorTabButton id="overview" label="Overview" shortLabel="Overview" icon={<LayoutDashboard size={17} />} activeTab={activeTab} onSelect={selectTab} />
        <MonitorTabButton id="cameras" label="Cameras" shortLabel="Cameras" icon={<Camera size={17} />} activeTab={activeTab} onSelect={selectTab} />
        <MonitorTabButton id="wifi" label="Wi-Fi & APs" shortLabel="Wi-Fi" icon={<Wifi size={17} />} activeTab={activeTab} onSelect={selectTab} />
        <MonitorTabButton id="switch" label="PoE switch" shortLabel="Switch" icon={<Network size={17} />} activeTab={activeTab} onSelect={selectTab} />
        <MonitorTabButton id="router" label="Router & WAN" shortLabel="Router" icon={<RouterIcon size={17} />} activeTab={activeTab} onSelect={selectTab} />
        <MonitorTabButton id="system" label="System" shortLabel="System" icon={<Server size={17} />} activeTab={activeTab} onSelect={selectTab} />
      </nav>

      {activeTab === "cameras" && <nav className="monitor-mobile-camera-nav" aria-label="Jump to camera">
        <span>Cameras</span>
        <div ref={cameraNavScrollRef}>
          {snapshot.courts.map((court) => {
            const state = displayedCourtState(court, snapshotCurrent, eventOperational);
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
      </nav>}

      {activeTab === "system" && <section id="monitor-panel-system" className="monitor-global-strip monitor-tab-panel" role="tabpanel" aria-labelledby="monitor-tab-system" aria-label="Global health">
        <GlobalItem icon={<Activity size={17} />} label="Collector" value={snapshotCurrent ? `${snapshot.collector.agentsFresh}/${snapshot.collector.agentsExpected} agents` : eventOperational ? "No current data" : "Off"} state={snapshotCurrent ? snapshot.collector.state : unavailableState(!eventOperational)} />
        <GlobalItem icon={<Signal size={17} />} label="Control" value={snapshotCurrent ? snapshot.controlPlane.worker.state === "NOT_APPLICABLE" ? "Idle" : snapshot.controlPlane.worker.state : eventOperational ? "No current data" : "Off"} state={snapshotCurrent ? snapshot.controlPlane.state : unavailableState(!eventOperational)} />
        <GlobalItem icon={<Youtube size={17} />} label="YouTube" value={snapshotCurrent ? friendlyState(snapshot.youtube.state) : eventOperational ? "No current data" : "Off"} state={snapshotCurrent ? snapshot.youtube.state : unavailableState(!eventOperational)} />
        <GlobalItem icon={<Bell size={17} />} label="Phone alerts" value={snapshotCurrent ? pagingReadiness.label : eventOperational ? "No current data" : "Off"} state={snapshotCurrent ? pagingReadiness.state : unavailableState(!eventOperational)} wrapValue />
        <GlobalItem icon={<Radio size={17} />} label="Watchdog" value={snapshotCurrent ? deadManReadiness.label : eventOperational ? "No current data" : "Off"} state={snapshotCurrent ? deadManReadiness.state : unavailableState(!eventOperational)} wrapValue />
        <GlobalItem icon={<ShieldAlert size={17} />} label="Incidents" value={snapshotCurrent ? activeIncidents.length ? `${activeIncidents.length} active` : "Clear" : eventOperational ? "No current data" : "Off"} state={snapshotCurrent ? activeIncidents.some((incident) => incident.severity === "critical") ? "CRITICAL" : activeIncidents.length ? "DEGRADED" : "HEALTHY" : unavailableState(!eventOperational)} />
        <div className={`monitor-freshness ${stale ? "is-stale" : ""}`}>
          <Clock3 size={16} aria-hidden="true" />
          <span>{envelope.source === "checkpoint" ? "Checkpoint" : `${formatDuration(snapshotAgeMs)} ago`}</span>
        </div>
      </section>}

      {(pollError || envelope.monitorError || stale) && (
        <div className={`monitor-banner ${stale && !eventOperational ? "is-idle" : ""}`} role={stale && !eventOperational ? "status" : "alert"}><AlertTriangle size={17} /><span>{monitorUnavailableMessage}</span></div>
      )}

      {activeTab === "overview" && <OverviewPanel
        snapshot={snapshot}
        snapshotCurrent={snapshotCurrent}
        eventOperational={eventOperational}
        unifi={unifi}
        unifiCurrent={unifiCurrent}
        networkSwitch={networkSwitch}
        switchCurrent={switchCurrent}
        router={router}
        routerCurrent={routerCurrent}
        nowMs={nowMs}
      />}
      {activeTab === "wifi" && <UniFiBand unifi={unifi} nowMs={nowMs} current={unifiCurrent} expectedOff={!eventOperational} />}
      {activeTab === "switch" && <NetworkSwitchBand networkSwitch={networkSwitch} nowMs={nowMs} current={switchCurrent} expectedOff={!eventOperational} />}
      {activeTab === "router" && <RouterBand router={router} nowMs={nowMs} current={routerCurrent} expectedOff={!eventOperational} />}

      {activeTab === "cameras" && <div id="monitor-panel-cameras" className="monitor-tab-panel" role="tabpanel" aria-labelledby="monitor-tab-cameras">
      <div className="monitor-bandwidth-note">
        <Camera size={17} aria-hidden="true" />
        <div><strong>Low-data overview</strong><span>Camera cards use one 256×144 snapshot every 15 seconds. Live video opens only for the selected camera.</span></div>
      </div>

      <section className="monitor-court-matrix" aria-label="Camera monitoring matrix">
          {snapshot.courts.map((court) => (
          <CourtCard key={court.courtNumber} court={court} history={snapshotCurrent ? history?.courts.find((entry) => entry.courtNumber === court.courtNumber) ?? null : null} selected={court.courtNumber === selectedCourt} nowMs={nowMs} current={snapshotCurrent} eventOperational={eventOperational} onSelect={() => inspectCamera(court.courtNumber)} />
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
            <div><p className="eyebrow">Live inspection</p><h2>Camera {selected.courtNumber}</h2><p className="monitor-detail-assignment">{eventOperational ? assignedCourtLabel(selected) : `Camera ${selected.courtNumber} · Off`}</p></div>
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
              {selected.stages.map((stage) => <StageDetail key={stage.stage} stage={snapshotCurrent ? stage : { ...stage, state: unavailableState(!eventOperational || isCourtExpectedOff(selected)), summary: "No current telemetry is available." }} />)}
            </div>
          </div>
          <ProgramTelemetry court={selected} nowMs={nowMs} current={snapshotCurrent} />
          {pacingOpen && <PacingComparator courtNumber={selected.courtNumber} />}
        </section>
      )}
      </div>}

      {activeTab === "system" && <section className="monitor-shared-band" aria-label="Shared services">
        <div className="monitor-section-heading"><div><p className="eyebrow">Shared dependencies</p><h2>Hosts &amp; services</h2></div></div>
        <div className="monitor-agent-grid">
          {snapshot.agents.map((agent) => {
            const agentCurrent = isAgentCurrent(agent, snapshotCurrent, nowMs);
            const agentState = agentCurrent ? agent.state : unavailableState(!eventOperational);
            return (
            <article className="monitor-agent" key={agent.agentId} data-state={agentState}>
              <div className="monitor-agent-head"><Server size={17} /><strong>{agent.agentId}</strong><StateBadge state={agentState} compact label={agentCurrent ? friendlyState(agentState) : eventOperational ? "No current data" : "Off"} /></div>
              <div className="monitor-agent-metrics">
                <Metric label="Load" value={agentCurrent && agent.host ? agent.host.load1.toFixed(2) : "--"} />
                <Metric label="Memory" value={agentCurrent && agent.host ? percent(agent.host.memoryTotalBytes - agent.host.memoryAvailableBytes, agent.host.memoryTotalBytes) : "--"} />
                <Metric label="Disk" value={agentCurrent && agent.host?.diskTotalBytes && agent.host.diskFreeBytes != null ? percent(agent.host.diskTotalBytes - agent.host.diskFreeBytes, agent.host.diskTotalBytes) : "--"} />
                {agentCurrent && agent.nativeServices?.egress && <>
                  <Metric label="Egress memory" value={formatBytes(agent.nativeServices.egress.cgroupMemoryBytes)} />
                  <Metric label="Egress CPU" value={formatPercentRatio(agent.nativeServices.egress.cpuLoadRatio)} />
                  <Metric label="Egress memory load" value={formatPercentRatio(agent.nativeServices.egress.memoryLoadRatio)} />
                </>}
              </div>
              <div className="monitor-service-list">
                {agentCurrent ? agent.services.map((service) => <span key={service.name} className={service.running && service.healthy !== false && !service.oomKilled ? "is-ok" : "is-bad"}>{service.name} · {service.restartCount}r</span>) : <span>No live server telemetry</span>}
                {agentCurrent && agent.nativeServices?.egress && <span className={egressRuntimeHealthy(agent.nativeServices.egress) ? "is-ok" : "is-bad"}>Egress {agent.nativeServices.egress.idle ? "idle" : "busy"} · {agent.nativeServices.egress.activeWebRequests}/{agent.nativeServices.egress.maximumWebRequests} outputs · {agent.nativeServices.egress.canAcceptRequest ? "ready" : "admission closed"}</span>}
              </div>
            </article>
            );
          })}
        </div>
      </section>}

    </div>
  );
}

function CourtCard({ court, history, selected, nowMs, current, eventOperational, onSelect }: { court: MonitorCourt; history: MonitorCourtPipelineRange["courts"][number] | null; selected: boolean; nowMs: number; current: boolean; eventOperational: boolean; onSelect: () => void }) {
  const browser = current ? court.browser : null;
  const raw = current ? court.paths.raw : undefined;
  const program = current ? court.paths.program : undefined;
  const preview = current ? court.ffmpeg.preview : null;
  const browserLiveness = deriveMonitorBrowserLiveness({
    receivedAt: browser?.receivedAt,
    programReaderCount: program?.readerCount,
    nowMs
  });
  const liveBrowser = browserLiveness.state === "LIVE" ? browser : null;
  const cameraStage = court.stages.find((stage) => stage.stage === "RAW_INGEST");
  const expectedOff = !eventOperational || isCourtExpectedOff(court);
  const cameraState = current ? cameraStage?.state ?? "UNKNOWN" : unavailableState(expectedOff);
  const productionState = current ? productionPipelineState(court) : unavailableState(expectedOff);
  const effectiveState = displayedCourtState(court, current, eventOperational);
  const match = current ? court.competition?.currentMatch : null;
  const score = current ? court.competition?.score : null;
  const relevantStages = court.stages.filter((stage) => stage.stage === "RAW_INGEST"
    || court.expectation.broadcastExpectation !== "OFF"
    || court.expectation.commentaryExpectation !== "NONE"
    || court.expectation.scoringExpectation !== "NONE");
  const issue = current ? relevantStages.find((stage) => stage.state === "CRITICAL") ?? relevantStages.find((stage) => ["DEGRADED", "UNKNOWN"].includes(stage.state)) : undefined;
  const thumbnailFresh = current && court.thumbnail && nowMs - Date.parse(court.thumbnail.receivedAt) <= 45_000;
  const browserLost = liveBrowser?.video.packetsLost;
  const browserReceived = liveBrowser?.video.packetsReceived;
  const viewerLoss = browserLost != null && browserReceived != null
    ? percent(browserLost, browserLost + browserReceived)
    : "--";
  const rawTrend = history?.rawBitrate ?? [];
  const fpsTrend = history?.programFps.length ? history.programFps : history?.previewFps ?? [];
  return (
    <article id={`monitor-camera-${court.courtNumber}`} className={`monitor-court ${selected ? "is-selected" : ""}`} data-state={effectiveState}>
      <header className="monitor-court-head">
        <div><span className="monitor-court-number">{court.courtNumber}</span><div><h2>Camera {court.courtNumber}</h2><p>{eventOperational ? `${assignedCourtLabel(court)} · ${court.expectation.coveragePhase.replaceAll("_", " ")}` : `Camera ${court.courtNumber} · Off`}</p></div></div>
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
        <Metric label="Rendered speed" value={formatFps(liveBrowser?.video.framesPerSecond)} />
        <Metric label="Picture size" value={liveBrowser?.video.width && liveBrowser.video.height ? `${liveBrowser.video.width}×${liveBrowser.video.height}` : "--"} />
        <Metric label="SRT retransmissions" value={transportRecovery(raw)} />
        <Metric label="Viewer packet loss" value={viewerLoss} />
      </div>
      <div className="monitor-trends" aria-label="Five minute trends">
        <div className="monitor-trends-heading"><strong>Last 5 minutes</strong><div className="monitor-trends-legend"><span className="is-bitrate">Camera bitrate · {formatBitrate(latestPoint(rawTrend))}</span><span className="is-fps">{liveBrowser ? "Rendered speed" : "Last rendered speed"} · {formatFps(latestPoint(fpsTrend))}</span></div></div>
        <div className="monitor-trends-plots">
          <Sparkline values={rawTrend} label="Camera bitrate, five minutes" className="is-bitrate" />
          <Sparkline values={fpsTrend} label="Rendered frames per second, five minutes" className="is-fps" fixedMax={30} />
        </div>
      </div>
      <div className="monitor-stage-grid">
        {court.stages.map((stage) => <StageRow key={stage.stage} stage={current ? stage : { ...stage, state: unavailableState(expectedOff), summary: "No current telemetry is available." }} />)}
      </div>
      <div className="monitor-match">
        {match ? <><div><strong>{match.teamA ?? "TBD"}</strong><span>{score ? `${score.teamASets} · ${score.teamAScore}` : "--"}</span></div><div><strong>{match.teamB ?? "TBD"}</strong><span>{score ? `${score.teamBSets} · ${score.teamBScore}` : "--"}</span></div><p>{match.roundName ?? "Match"}{match.matchNumber ? ` · #${match.matchNumber}` : ""}</p></> : <p>No current match</p>}
      </div>
      <div className="monitor-court-footer">
        <span className="monitor-source-profile" title={sourceDetail(raw)}><Signal size={14} /> {sourceProfile(raw)}</span>
        <span><Camera size={14} /> {visualLabel(current ? court.contentAnalysis : null)}</span>
        <span><Headphones size={14} /> {commentaryLabel(liveBrowser)}</span>
        <span><Youtube size={14} /> {current ? friendlyState(court.youtube?.state ?? "NOT_APPLICABLE") : "no current data"}</span>
        <span title={browserQualityDetail(liveBrowser)}><Activity size={14} /> {browserQualityLabel(liveBrowser, liveBrowser ? history : null)}</span>
        <span title={browserLivenessDetail(browserLiveness)}><Gauge size={14} /> {browserLivenessLabel(browserLiveness)}</span>
      </div>
      {issue?.issueCode && <div className="monitor-court-alert"><AlertTriangle size={14} /><span>{issue.summary}</span></div>}
    </article>
  );
}

function MonitorTabButton({ id, label, shortLabel, icon, activeTab, onSelect }: {
  id: MonitorTab;
  label: string;
  shortLabel?: string;
  icon: React.ReactNode;
  activeTab: MonitorTab;
  onSelect: (tab: MonitorTab) => void;
}) {
  const selected = activeTab === id;
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = MONITOR_TABS.indexOf(id);
    const nextIndex = event.key === "ArrowRight" ? (currentIndex + 1) % MONITOR_TABS.length
      : event.key === "ArrowLeft" ? (currentIndex - 1 + MONITOR_TABS.length) % MONITOR_TABS.length
        : event.key === "Home" ? 0 : event.key === "End" ? MONITOR_TABS.length - 1 : null;
    if (nextIndex == null) return;
    event.preventDefault();
    const next = MONITOR_TABS[nextIndex]!;
    onSelect(next);
    window.requestAnimationFrame(() => document.getElementById(`monitor-tab-${next}`)?.focus());
  }
  return (
    <button
      id={`monitor-tab-${id}`}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={`monitor-panel-${id}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(id)}
      onKeyDown={onKeyDown}
    >
      {icon}
      <span className="monitor-tab-label">{label}</span>
      {shortLabel && <span className="monitor-tab-label-short">{shortLabel}</span>}
    </button>
  );
}

function OverviewPanel({ snapshot, snapshotCurrent, eventOperational, unifi, unifiCurrent, networkSwitch, switchCurrent, router, routerCurrent, nowMs }: {
  snapshot: MonitorSnapshot;
  snapshotCurrent: boolean;
  eventOperational: boolean;
  unifi: MonitorUniFi;
  unifiCurrent: boolean;
  networkSwitch: MonitorNetworkSwitch;
  switchCurrent: boolean;
  router: MonitorRouter;
  routerCurrent: boolean;
  nowMs: number;
}) {
  const cameraStates = snapshot.courts.map((court) => displayedCourtState(court, snapshotCurrent, eventOperational));
  const cameraState = cameraStates.reduce<MonitorHealthState>((worst, state) => STATE_RANK[state] > STATE_RANK[worst] ? state : worst, "NOT_APPLICABLE");
  const activeCameras = snapshotCurrent ? snapshot.courts.filter((court) => court.paths.raw?.ready).length : 0;
  const routerState = routerCurrent ? router.state : unavailableState(!eventOperational);
  const unifiState = unifiCurrent ? unifi.state : unavailableState(!eventOperational);
  const switchState = switchCurrent ? networkSwitch.state : unavailableState(!eventOperational);
  const expectedPorts = networkSwitch.ports.filter((port) => port.expected);
  const switchErrors = networkSwitch.ports.reduce((total, port) => total
    + (port.inputErrorsPerSecond ?? 0)
    + (port.outputErrorsPerSecond ?? 0)
    + (port.inputDiscardsPerSecond ?? 0)
    + (port.outputDiscardsPerSecond ?? 0), 0);
  const cameraClients = unifiCurrent ? unifi.clients.filter((client) => cameraNumberFromClientName(client.name) != null) : [];
  const requiredWans = router.wans.filter((wan) => wan.required);
  const requiredWansConnected = requiredWans.filter((wan) => wan.connected).length;
  const worstApRetriesPct = unifiCurrent
    ? Math.max(0, ...unifi.accessPoints.flatMap((accessPoint) => accessPoint.radios.map((radio) => radio.txRetriesPct ?? 0)))
    : null;
  const youtubeState = snapshotCurrent ? snapshot.youtube.state : unavailableState(!eventOperational);
  return (
    <section id="monitor-panel-overview" className="monitor-tab-panel monitor-overview-panel" role="tabpanel" aria-labelledby="monitor-tab-overview">
      <OverviewSectionHeading icon={<Camera size={19} />} title="Cameras" state={cameraState} label={activeCameras > 0 ? `${activeCameras} live` : eventOperational && !snapshotCurrent ? "No current data" : "All off"} />
      <div className="monitor-overview-table-wrap">
        <table className="monitor-overview-table monitor-camera-overview-table">
          <thead><tr><th>Camera</th><th>Status</th><th>Ingest bitrate</th><th>SRT retransmissions</th><th>Access point</th><th>Wi-Fi signal</th><th>Program</th></tr></thead>
          <tbody>
            {snapshot.courts.map((court) => {
              const state = displayedCourtState(court, snapshotCurrent, eventOperational);
              const raw = snapshotCurrent ? court.paths.raw : undefined;
              const client = unifiCurrent ? findCameraClient(unifi, court.courtNumber) : null;
              const accessPoint = client ? unifi.accessPoints.find((entry) => entry.deviceId === client.uplinkDeviceId) : null;
              return <tr key={court.courtNumber} data-state={state}>
                <th scope="row"><span className="monitor-camera-cell"><StateDot state={state} />Camera {court.courtNumber}</span></th>
                <td data-label="Status"><StateBadge state={state} compact label={cameraOverviewStatus(court, snapshotCurrent, eventOperational)} /></td>
                <td data-label="Ingest bitrate">{raw?.ready ? formatBitrate(raw.inboundBitrateBps) : "--"}</td>
                <td data-label="SRT retransmissions">{raw?.ready ? transportRecovery(raw) : "--"}</td>
                <td data-label="Access point">{accessPoint?.name ?? "--"}</td>
                <td data-label="Wi-Fi signal">--</td>
                <td data-label="Program">{programOverviewStatus(court, snapshotCurrent, eventOperational)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>

      <OverviewSectionHeading icon={<Network size={19} />} title="Venue network and power" state={worstState([routerState, unifiState, switchState, youtubeState])} label={snapshotCurrent ? "Current telemetry" : eventOperational ? "No current data" : "All off"} />
      <div className="monitor-overview-table-wrap">
        <table className="monitor-overview-table monitor-infrastructure-overview-table">
          <thead><tr><th>System</th><th>Status</th><th>Primary reading</th><th>Quality</th></tr></thead>
          <tbody>
            <OverviewInfrastructureRow icon={<RouterIcon size={16} />} name="Router and internet" state={routerState} status={routerCurrent ? routerStateLabel(router.state) : offlineLabel(eventOperational)} primary={routerCurrent && router.clients ? `${router.clients.connected} connected devices` : "--"} quality={routerCurrent ? `${requiredWansConnected}/${requiredWans.length} required WANs · ${router.speedFusion?.connected ? "SpeedFusion connected" : "SpeedFusion disconnected"}` : "--"} />
            <OverviewInfrastructureRow icon={<Wifi size={16} />} name="Wi-Fi access points" state={unifiState} status={unifiCurrent ? `${unifi.onlineAccessPoints}/${unifi.expectedAccessPoints} online` : offlineLabel(eventOperational)} primary={unifiCurrent ? `${cameraClients.length} cameras connected` : "--"} quality={worstApRetriesPct == null ? "--" : `Highest AP retries ${worstApRetriesPct.toFixed(1)}%`} />
            <OverviewInfrastructureRow icon={<Network size={16} />} name="PoE switch" state={switchState} status={switchCurrent ? networkSwitchStateLabel(networkSwitch) : offlineLabel(eventOperational)} primary={switchCurrent ? `${expectedPorts.filter((port) => port.operationalUp).length}/${expectedPorts.length} expected links up` : "--"} quality={switchCurrent ? `${formatWatts(networkSwitch.poe.consumptionWatts)} used · ${switchErrors === 0 ? "no errors" : `${switchErrors.toFixed(2)}/s errors`}` : "--"} />
            <OverviewInfrastructureRow icon={<Youtube size={16} />} name="YouTube delivery" state={youtubeState} status={snapshotCurrent ? friendlyState(snapshot.youtube.state) : offlineLabel(eventOperational)} primary={snapshotCurrent ? `${snapshot.courts.filter((court) => court.youtube?.broadcastLifecycle === "live").length} live outputs` : "--"} quality={snapshotCurrent ? `${snapshot.courts.filter((court) => court.youtube?.healthStatus === "good").length} healthy destinations` : "--"} />
          </tbody>
        </table>
      </div>

      <OverviewSectionHeading icon={<Server size={19} />} title="Event servers" state={serverOverviewState(snapshot.agents, snapshotCurrent, eventOperational, nowMs)} label={snapshotCurrent ? `${snapshot.agents.filter((agent) => isAgentCurrent(agent, true, nowMs)).length} reporting` : eventOperational ? "No current data" : "All off"} />
      <div className="monitor-overview-table-wrap">
        <table className="monitor-overview-table monitor-server-overview-table">
          <thead><tr><th>Server</th><th>Status</th><th>Load</th><th>Memory</th><th>Disk</th></tr></thead>
          <tbody>
            {snapshot.agents.length ? snapshot.agents.map((agent) => {
              const current = isAgentCurrent(agent, snapshotCurrent, nowMs);
              const state = current ? agent.state : unavailableState(!eventOperational);
              return <tr key={agent.agentId} data-state={state}>
                <th scope="row"><span className="monitor-server-cell"><StateDot state={state} /><span><strong>{agent.agentId}</strong><small>{friendlyRole(agent.role)}</small></span></span></th>
                <td data-label="Status"><StateBadge state={state} compact label={current ? friendlyState(state) : offlineLabel(eventOperational)} /></td>
                <td data-label="Load">{current && agent.host ? agent.host.load1.toFixed(2) : "--"}</td>
                <td data-label="Memory">{current && agent.host ? percent(agent.host.memoryTotalBytes - agent.host.memoryAvailableBytes, agent.host.memoryTotalBytes) : "--"}</td>
                <td data-label="Disk">{current && agent.host?.diskTotalBytes && agent.host.diskFreeBytes != null ? percent(agent.host.diskTotalBytes - agent.host.diskFreeBytes, agent.host.diskTotalBytes) : "--"}</td>
              </tr>;
            }) : <tr><td colSpan={5} className="monitor-overview-empty">No event servers are reporting.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OverviewSectionHeading({ icon, title, state, label }: { icon: React.ReactNode; title: string; state: MonitorHealthState; label: string }) {
  return (
    <div className="monitor-overview-section-heading">
      <span aria-hidden="true">{icon}</span>
      <h2>{title}</h2>
      <StateBadge state={state} compact label={label} />
    </div>
  );
}

function OverviewInfrastructureRow({ icon, name, state, status, primary, quality }: { icon: React.ReactNode; name: string; state: MonitorHealthState; status: string; primary: string; quality: string }) {
  return <tr data-state={state}>
    <th scope="row"><span className="monitor-infrastructure-cell">{icon}{name}</span></th>
    <td data-label="Status"><StateBadge state={state} compact label={status} /></td>
    <td data-label="Primary reading">{primary}</td>
    <td data-label="Quality">{quality}</td>
  </tr>;
}

function UniFiBand({ unifi, nowMs, current, expectedOff }: { unifi: MonitorUniFi; nowMs: number; current: boolean; expectedOff: boolean }) {
  const totalTxBps = unifi.accessPoints.reduce((total, accessPoint) => total + (accessPoint.txRateBps ?? 0), 0);
  const totalRxBps = unifi.accessPoints.reduce((total, accessPoint) => total + (accessPoint.rxRateBps ?? 0), 0);
  const state = current ? unifi.state : unavailableState(expectedOff);
  return (
    <section id="monitor-panel-wifi" className="monitor-tab-panel monitor-network-detail" role="tabpanel" aria-labelledby="monitor-tab-wifi">
      <div className="monitor-network-heading">
        <div><Wifi size={20} aria-hidden="true" /><div><h2>Wi-Fi access points</h2><p>Cloud-managed UniFi radio, device and client telemetry</p></div></div>
        <StateBadge state={state} label={current ? unifiStateLabel(unifi) : expectedOff ? "Off" : "No current data"} />
      </div>
      {!current ? <MonitorUnavailableNotice title={expectedOff ? "Access points are off" : "Access point telemetry is unavailable"} detail="No current AP or connected-device telemetry is available. Historical values are intentionally hidden." /> : <>
        <div className="monitor-network-summary">
          <Metric label="Access points online" value={`${unifi.onlineAccessPoints}/${unifi.expectedAccessPoints}`} />
          <Metric label="Connected devices" value={String(unifi.connectedClients)} />
          <Metric label="Traffic to APs" value={formatBitrate(totalTxBps)} />
          <Metric label="Traffic from APs" value={formatBitrate(totalRxBps)} />
          <Metric label="Controller API" value={unifi.apiReachable ? "Connected" : "Unavailable"} />
          <Metric label="Last update" value={relativeTimestamp(unifi.sampledAt, nowMs)} />
        </div>
        {unifi.problems.length > 0 && <ProblemList problems={unifi.problems} />}
        <div className="monitor-ap-grid">
          {unifi.accessPoints.map((accessPoint) => {
            const clients = unifi.clients.filter((client) => client.uplinkDeviceId === accessPoint.deviceId);
            const retries = accessPoint.radios.map((radio) => radio.txRetriesPct).filter((value): value is number => value != null);
            const state = accessPoint.state !== "ONLINE" ? "CRITICAL" : retries.some((value) => value > 25) ? "DEGRADED" : "HEALTHY";
            return (
              <article className="monitor-ap" key={accessPoint.deviceId} data-state={state}>
                <header className="monitor-ap-heading"><div><Wifi size={18} /><div><strong>{accessPoint.name}</strong><span>{accessPoint.model ?? "Model unavailable"} · {accessPoint.ipAddress ?? "No IP"}</span></div></div><StateBadge state={state} compact label={accessPoint.state === "ONLINE" ? "Online" : friendlyState(accessPoint.state)} /></header>
                <div className="monitor-ap-metrics">
                  <Metric label="Connected devices" value={String(clients.length)} />
                  <Metric label="Receive" value={formatBitrate(accessPoint.rxRateBps)} />
                  <Metric label="Send" value={formatBitrate(accessPoint.txRateBps)} />
                  <Metric label="CPU" value={formatOptionalPercent(accessPoint.cpuUtilizationPct)} />
                  <Metric label="Memory" value={formatOptionalPercent(accessPoint.memoryUtilizationPct)} />
                  <Metric label="Heartbeat" value={relativeTimestamp(accessPoint.lastHeartbeatAt, nowMs)} />
                </div>
                <div className="monitor-radio-list" aria-label={`${accessPoint.name} radio details`}>
                  {accessPoint.radios.length ? accessPoint.radios.map((radio) => <span key={radio.frequencyGHz}><strong>{radio.frequencyGHz} GHz</strong><span>{radio.txRetriesPct == null ? "Retries unavailable" : `${radio.txRetriesPct.toFixed(1)}% retries`}</span></span>) : <span><strong>Radio details</strong><span>Unavailable</span></span>}
                  <span><strong>Firmware</strong><span>{accessPoint.firmwareVersion ?? "Unavailable"}</span></span>
                </div>
                <div className="monitor-client-list">
                  <div className="monitor-subheading"><strong>Connected devices</strong><span>{clients.length}</span></div>
                  {clients.length ? clients.map((client) => <div className="monitor-client-row" key={client.id}><span><strong>{client.name || "Unnamed device"}</strong><small>{friendlyState(client.type)}</small></span><span>{client.ipAddress ?? "No IP"}</span></div>) : <p>No devices currently report through this access point.</p>}
                </div>
              </article>
            );
          })}
        </div>
      </>}
    </section>
  );
}

function NetworkSwitchBand({ networkSwitch, nowMs, current, expectedOff }: { networkSwitch: MonitorNetworkSwitch; nowMs: number; current: boolean; expectedOff: boolean }) {
  const expectedPorts = networkSwitch.ports.filter((port) => port.expected);
  const activePorts = expectedPorts.filter((port) => port.operationalUp).length;
  const state = current ? networkSwitch.state : unavailableState(expectedOff);
  return (
    <section id="monitor-panel-switch" className="monitor-tab-panel monitor-network-detail" role="tabpanel" aria-labelledby="monitor-tab-switch">
      <div className="monitor-network-heading">
        <div><Network size={20} aria-hidden="true" /><div><h2>PoE switch</h2><p>LinoVision wired links, port errors and access-point power</p></div></div>
        <StateBadge state={state} label={current ? networkSwitchStateLabel(networkSwitch) : expectedOff ? "Off" : "No current data"} />
      </div>
      {!current ? <MonitorUnavailableNotice title={expectedOff ? "PoE switch is off" : "PoE switch telemetry is unavailable"} detail="No current port, link, or power telemetry is available. Historical values are intentionally hidden." /> : <>
        <div className="monitor-network-summary">
          <Metric label="Expected links up" value={`${activePorts}/${expectedPorts.length}`} />
          <Metric label="PoE use" value={formatWatts(networkSwitch.poe.consumptionWatts)} />
          <Metric label="PoE budget" value={formatWatts(networkSwitch.poe.budgetWatts)} />
          <Metric label="PoE remaining" value={formatWatts(networkSwitch.poe.remainingWatts)} />
          <Metric label="Switch uptime" value={formatUptime(networkSwitch.uptimeSeconds)} />
          <Metric label="Last update" value={relativeTimestamp(networkSwitch.sampledAt, nowMs)} />
        </div>
        {networkSwitch.problems.length > 0 && <ProblemList problems={networkSwitch.problems} />}
        <div className="monitor-switch-port-list">
          {networkSwitch.ports.filter((port) => port.expected || port.operationalUp).map((port) => {
            const state: MonitorHealthState = port.operationalUp === true ? "HEALTHY" : port.operationalUp === false && port.expected ? "CRITICAL" : "UNKNOWN";
            const errors = (port.inputErrorsPerSecond ?? 0) + (port.outputErrorsPerSecond ?? 0) + (port.inputDiscardsPerSecond ?? 0) + (port.outputDiscardsPerSecond ?? 0);
            return <article className="monitor-switch-port" key={port.id} data-state={state}>
              <header><div><Cable size={18} /><div><strong>{port.name}</strong><span>{switchPortRoleLabel(port.role)} · port {port.id}</span></div></div><StateBadge state={state} compact label={port.operationalUp ? "Linked" : port.operationalUp === false ? "Link down" : "No data"} /></header>
              <div className="monitor-switch-port-metrics">
                <Metric label="Link" value={port.speedMbps == null ? "--" : `${port.speedMbps} Mbps ${port.duplex ?? ""}`.trim()} />
                <Metric label="Receive" value={formatBitrate(port.rxBps)} />
                <Metric label="Send" value={formatBitrate(port.txBps)} />
                <Metric label="Errors and discards" value={errors === 0 ? "None" : `${errors.toFixed(2)}/s`} />
                <Metric label="PoE power" value={formatWatts(port.poe?.powerWatts)} />
                <Metric label="Last change" value={relativeTimestamp(port.lastChangedAt, nowMs)} />
              </div>
            </article>;
          })}
        </div>
      </>}
    </section>
  );
}

function MonitorUnavailableNotice({ title, detail }: { title: string; detail: string }) {
  return <div className="monitor-commissioning-notice"><WifiOff size={22} aria-hidden="true" /><div><strong>{title}</strong><p>{detail}</p></div></div>;
}

function ProblemList({ problems }: { problems: string[] }) {
  return <div className="monitor-problem-list" role="status">{problems.map((problem) => <p key={problem}><AlertTriangle size={15} />{problem}</p>)}</div>;
}

function RouterBand({ router, nowMs, current, expectedOff }: { router: MonitorRouter; nowMs: number; current: boolean; expectedOff: boolean }) {
  const ageMs = router.sampledAt ? Math.max(0, nowMs - Date.parse(router.sampledAt)) : null;
  const requiredWans = router.wans.filter((wan) => wan.required);
  const requiredWansConnected = requiredWans.filter((wan) => wan.connected).length;
  const state = current ? router.state : unavailableState(expectedOff);
  return (
    <section id="monitor-panel-router" className="monitor-router-band monitor-tab-panel" role="tabpanel" aria-labelledby="monitor-tab-router" aria-label="Venue network">
      <div className="monitor-router-heading">
        <div><Network size={19} aria-hidden="true" /><div><h2>Peplink router and internet</h2><p>Required WAN links, SpeedFusion connection, router load and cellular radio health</p></div></div>
        <StateBadge state={state} label={current ? routerStateLabel(router.state) : expectedOff ? "Off" : "No current data"} />
      </div>
      {!current ? <MonitorUnavailableNotice title={expectedOff ? "Router is off" : "Router telemetry is unavailable"} detail="No current router, WAN, SpeedFusion, or client telemetry is available. Historical values are intentionally hidden." /> : <>
      <div className="monitor-router-summary">
        <Metric label="Router CPU" value={formatPercent(router.resources?.cpuUtilizationPct)} />
        <Metric label="Router memory" value={formatPercent(router.resources?.memoryUtilizationPct)} />
        <Metric label="Connected devices" value={router.clients ? String(router.clients.connected) : "--"} />
        <Metric label={`${router.clients?.cameraWlanSsid ?? "Camera Wi-Fi"} devices`} value={router.clients ? String(router.clients.cameraWlanConnected) : "--"} />
        <Metric label="SpeedFusion data" value={formatDataUsage(router.speedFusion?.usageMb, router.speedFusion?.quotaMb)} />
        <Metric label="SpeedFusion limit" value={router.speedFusion?.rateLimitMbps == null ? "--" : `${router.speedFusion.rateLimitMbps} Mbps`} />
        <Metric label="Router uptime" value={formatUptime(router.identity?.uptimeSeconds)} />
        <Metric label="Last update" value={relativeTimestamp(router.sampledAt, nowMs)} />
      </div>
      <div className="monitor-router-status-line">
        <span data-ok={router.apiReachable === true}>{router.apiReachable ? "InControl reporting" : "InControl unavailable"}</span>
        <span data-ok={router.identity?.online === true}>{router.identity?.online ? "Router online" : "Router offline"}</span>
        <span data-ok={router.speedFusion?.connected === true}>{router.speedFusion?.connected ? "SpeedFusion connected" : "SpeedFusion disconnected"}</span>
        <span data-ok={router.speedFusion?.linksAvailable === true}>{router.speedFusion?.linksAvailable ? "Tunnel metrics current" : "Tunnel metrics unavailable"}</span>
        <span data-ok={requiredWans.length > 0 && requiredWansConnected === requiredWans.length}>{requiredWansConnected}/{requiredWans.length} required WANs connected</span>
        <span data-ok={ageMs != null && ageMs <= 90_000}>{ageMs == null ? "No router status received" : `Updated ${formatDuration(ageMs)} ago`}</span>
        {router.identity?.firmwareVersion && <span data-ok="true">Firmware {router.identity.firmwareVersion}</span>}
      </div>
      {router.problems.length > 0 && <ProblemList problems={router.problems} />}
      {router.speedFusion && router.speedFusion.links.length > 0 && <>
        <div className="monitor-subheading"><strong>SpeedFusion tunnel links</strong><span>{router.speedFusion.links.length}</span></div>
        <div className="monitor-uplink-grid">
          {router.speedFusion.links.map((link) => {
            const linkState: MonitorHealthState = link.state === "ACTIVE"
              ? (link.transmitPacketLossPct ?? 0) >= 10 ? "CRITICAL" : (link.transmitPacketLossPct ?? 0) >= 3 ? "DEGRADED" : "HEALTHY"
              : "CRITICAL";
            return <article className="monitor-uplink" key={link.name} data-degraded={linkState !== "HEALTHY"}>
              <div className="monitor-uplink-heading"><Network size={17} aria-hidden="true" /><div><strong>{link.name}</strong><span>{link.state === "ACTIVE" ? "Active tunnel path" : link.state}</span></div><StateDot state={linkState} /></div>
              <div className="monitor-uplink-metrics">
                <Metric label="Tunnel upload" value={formatBitrate(link.transmitBitrateBps)} />
                <Metric label="Round trip" value={link.rttMs == null ? "--" : `${Math.round(link.rttMs)} ms`} />
                <Metric label="Packet loss" value={formatPercent(link.transmitPacketLossPct)} />
                <Metric label="FEC overhead" value={formatPercent(link.transmitFecPct)} />
              </div>
            </article>;
          })}
        </div>
      </>}
      {router.clients && <>
        <div className="monitor-subheading"><strong>{router.clients.cameraWlanSsid} Wi-Fi devices</strong><span>{router.clients.cameraWlanDevices.length}</span></div>
        <div className="monitor-uplink-grid">
          {router.clients.cameraWlanDevices.map((client) => {
            const signalState = routerClientSignalState(client.signalDbm);
            return <article className="monitor-uplink" key={client.macAddress} data-degraded={signalState === "CRITICAL" || signalState === "DEGRADED"}>
              <div className="monitor-uplink-heading"><Wifi size={17} aria-hidden="true" /><div><strong>{client.name ?? client.ipAddress ?? "Unnamed device"}</strong><span>{client.ipAddress ?? "No IP"} · {client.macAddress}</span></div><StateDot state={signalState} /></div>
              <div className="monitor-uplink-metrics">
                <Metric label="Signal" value={client.signalDbm == null ? "--" : `${client.signalDbm} dBm · ${routerSignalLabel(client.signalDbm)}`} />
                <Metric label="Signal bars" value={client.signalLevel == null ? "--" : `${client.signalLevel}/5`} />
                <Metric label="Upload" value={formatBitrate(client.uploadKbps == null ? null : client.uploadKbps * 1_000)} />
                <Metric label="Download" value={formatBitrate(client.downloadKbps == null ? null : client.downloadKbps * 1_000)} />
              </div>
            </article>;
          })}
        </div>
      </>}
      <div className="monitor-uplink-grid">
        {router.wans.length ? router.wans.map((wan) => {
          const Icon = wan.type === "cellular" ? Smartphone : wan.type === "wifi" ? Signal : Cable;
          const degraded = wan.required ? !wan.connected : wan.enabled && !wan.connected;
          const wanState: MonitorHealthState = wan.connected ? "HEALTHY" : wan.enabled ? "DEGRADED" : "EXPECTED_OFF";
          return (
            <article className="monitor-uplink" key={wan.id} data-degraded={degraded}>
              <div className="monitor-uplink-heading"><Icon size={17} aria-hidden="true" /><div><strong>{wan.name}</strong><span>{wan.required ? "Required" : "Optional"} · {wan.message}</span></div><StateDot state={wanState} /></div>
              <div className="monitor-uplink-metrics">
                <Metric label="Status" value={wan.connected ? "Connected" : wan.enabled ? "Disconnected" : "Disabled"} />
                <Metric label="Priority" value={wan.priority == null ? "--" : `Priority ${wan.priority}`} />
                <Metric label="Uptime" value={formatUptime(wan.uptimeSeconds)} />
                <Metric label="Network" value={[wan.carrier, wan.technology].filter(Boolean).join(" · ") || "--"} />
                <Metric label="Signal" value={wan.signalLevel == null ? "--" : `${wan.signalLevel}/5`} />
                <Metric label="Radio band" value={formatWanBands(wan.bands)} wrapValue />
              </div>
            </article>
          );
        }) : <p className="monitor-uplink-empty">Router connection details are not available yet.</p>}
      </div>
      </>}
    </section>
  );
}

function StageRow({ stage }: { stage: MonitorStage }) {
  return <div className="monitor-stage-row" title={`${stageLabel(stage.stage)}: ${stage.summary}`}><StateDot state={stage.state} /><span className="monitor-stage-name">{stageLabel(stage.stage)}</span><span className="monitor-stage-state">{stageStateLabel(stage.state)}</span></div>;
}

function ProgramTelemetry({ court, nowMs, current }: { court: MonitorCourt; nowMs: number; current: boolean }) {
  const program = current ? court.paths.program : undefined;
  const liveness = deriveMonitorBrowserLiveness({
    receivedAt: current ? court.browser?.receivedAt : null,
    programReaderCount: program?.readerCount,
    nowMs
  });
  const browser = current && liveness.state === "LIVE" ? court.browser : null;
  const video = browser?.video;
  const commentary = browser?.commentary;
  const syncGapMs = commentary?.targetDelayMs != null && commentary.appliedDelayMs != null
    ? Math.abs(commentary.targetDelayMs - commentary.appliedDelayMs)
    : null;
  return (
    <section className="monitor-program-telemetry" aria-label={`Camera ${court.courtNumber} program endurance telemetry`}>
      <div className="monitor-program-heading">
        <div><Activity size={18} aria-hidden="true" /><div><h3>Program endurance</h3><p>Buffered playback, browser ownership, memory and audio synchronization</p></div></div>
        <StateBadge state={browser ? "HEALTHY" : liveness.state === "STATUS_MISSING" ? "DEGRADED" : "UNKNOWN"} label={browser ? "Reporting now" : browserLivenessLabel(liveness)} />
      </div>
      <div className="monitor-network-summary monitor-program-summary">
        <Metric label="Transport" value={video?.transport ? video.transport.toUpperCase() : "--"} />
        <Metric label="Program delay" value={formatMs(video?.playoutDelayMs)} />
        <Metric label="Buffered ahead" value={formatMs(video?.bufferedAheadMs)} />
        <Metric label="HLS owners" value={video?.hlsActiveInstances == null ? "--" : String(video.hlsActiveInstances)} />
        <Metric label="HLS created / closed" value={video?.hlsCreatedInstances == null || video.hlsDestroyedInstances == null ? "--" : `${video.hlsCreatedInstances} / ${video.hlsDestroyedInstances}`} />
        <Metric label="Browser heap" value={formatBytes(video?.jsHeapUsedBytes)} />
        <Metric label="Dropped frames" value={video?.framesDropped == null ? "--" : String(video.framesDropped)} />
        <Metric label="Freeze time" value={video?.totalFreezesDurationMs == null ? "--" : formatDuration(video.totalFreezesDurationMs)} />
        <Metric label="Reconnects / reloads" value={video ? `${video.reconnectCount} / ${video.reloadCount}` : "--"} />
        <Metric label="Audio sync" value={commentary?.configured ? friendlyState(commentary.syncStatus) : "Not in use"} />
        <Metric label="Audio delay applied" value={commentary?.configured ? formatMs(commentary.appliedDelayMs) : "--"} />
        <Metric label="Audio sync gap" value={commentary?.configured ? formatMs(syncGapMs) : "--"} />
      </div>
    </section>
  );
}

function StageDetail({ stage }: { stage: MonitorStage }) {
  return <div className="monitor-stage-detail-row" data-state={stage.state}><div><StateDot state={stage.state} /><strong>{stageLabel(stage.stage)}</strong></div><p>{stage.summary}</p>{stage.firstAction && <small>{stage.firstAction}</small>}</div>;
}

function GlobalItem({ icon, label, value, state, wrapValue = false }: { icon: React.ReactNode; label: string; value: string; state: MonitorHealthState; wrapValue?: boolean }) {
  return <div className={`monitor-global-item ${wrapValue ? "has-wrapped-value" : ""}`} data-state={state}>{icon}<div><span>{label}</span><strong>{value}</strong></div><StateDot state={state} /></div>;
}

function Metric({ label, value, wrapValue = false }: { label: string; value: string; wrapValue?: boolean }) {
  return <div className={`monitor-metric ${wrapValue ? "has-wrapped-value" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
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
  const cameraState = deriveRawCameraState(court);
  const productionState = productionPipelineState(court);
  return STATE_RANK[cameraState] > STATE_RANK[productionState] ? cameraState : productionState;
}

function displayedCourtState(court: MonitorCourt, snapshotCurrent: boolean, eventOperational: boolean): MonitorHealthState {
  return snapshotCurrent ? effectiveCourtState(court) : unavailableState(!eventOperational || isCourtExpectedOff(court));
}

function cameraOverviewStatus(court: MonitorCourt, snapshotCurrent: boolean, eventOperational: boolean): string {
  if (!snapshotCurrent) return !eventOperational || isCourtExpectedOff(court) ? "Off" : "No current data";
  const raw = court.paths.raw;
  const state = deriveRawCameraState(court);
  if (raw?.ready) return state === "HEALTHY" ? "Live" : state === "DEGRADED" ? "Unstable" : state === "CRITICAL" ? "Problem" : "Starting";
  return court.expectation.mediaExpectation === "OFF" ? "Off" : "Offline";
}

function programOverviewStatus(court: MonitorCourt, snapshotCurrent: boolean, eventOperational: boolean): string {
  if (!snapshotCurrent) return !eventOperational || isCourtExpectedOff(court) ? "Off" : "No current data";
  if (court.expectation.broadcastExpectation === "OFF") return "Off";
  if (court.paths.program?.ready && court.youtube?.broadcastLifecycle === "live") return "Live";
  if (court.paths.program?.ready) return "Program ready";
  return "Offline";
}

function cameraNumberFromClientName(name: string): number | null {
  const match = name.trim().match(/^camera[\s_-]*(\d)$/i);
  const cameraNumber = match ? Number(match[1]) : 0;
  return cameraNumber >= 1 && cameraNumber <= 8 ? cameraNumber : null;
}

function findCameraClient(unifi: MonitorUniFi, courtNumber: number): MonitorUniFi["clients"][number] | null {
  return unifi.clients.find((client) => cameraNumberFromClientName(client.name) === courtNumber) ?? null;
}

function offlineLabel(eventOperational: boolean): string {
  return eventOperational ? "No current data" : "Off";
}

function isAgentCurrent(agent: MonitorAgent, snapshotCurrent: boolean, nowMs: number): boolean {
  return isTelemetryCurrent(snapshotCurrent, agent.lastSeenAt, nowMs, 20_000);
}

function serverOverviewState(agents: MonitorAgent[], snapshotCurrent: boolean, hasActiveEvent: boolean, nowMs: number): MonitorHealthState {
  if (!snapshotCurrent) return unavailableState(!hasActiveEvent);
  const currentAgents = agents.filter((agent) => isAgentCurrent(agent, true, nowMs));
  if (currentAgents.length === 0) return hasActiveEvent ? "UNKNOWN" : "EXPECTED_OFF";
  return worstState(currentAgents.map((agent) => agent.state));
}

function worstState(states: MonitorHealthState[]): MonitorHealthState {
  return states.reduce<MonitorHealthState>((worst, state) => STATE_RANK[state] > STATE_RANK[worst] ? state : worst, "NOT_APPLICABLE");
}

function friendlyRole(role: string): string {
  return role.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function routerStateLabel(state: MonitorHealthState): string {
  if (state === "HEALTHY") return "Connections healthy";
  if (state === "CRITICAL") return "Camera internet at risk";
  if (state === "DEGRADED") return "Connection under pressure";
  if (state === "UNKNOWN") return "Router status unavailable";
  return friendlyState(state);
}

function routerClientSignalState(signalDbm: number | null): MonitorHealthState {
  if (signalDbm == null) return "UNKNOWN";
  if (signalDbm >= -67) return "HEALTHY";
  if (signalDbm >= -75) return "DEGRADED";
  return "CRITICAL";
}

function routerSignalLabel(signalDbm: number): string {
  if (signalDbm >= -60) return "Strong";
  if (signalDbm >= -67) return "Good";
  if (signalDbm >= -75) return "Weak";
  return "Poor";
}

function unifiStateLabel(unifi: MonitorUniFi): string {
  if (!unifi.configured) return "Not commissioned";
  if (unifi.state === "HEALTHY") return "Wi-Fi healthy";
  if (unifi.state === "CRITICAL") return "Access point offline";
  if (unifi.state === "DEGRADED") return "Wi-Fi needs attention";
  if (unifi.state === "UNKNOWN") return "Wi-Fi status unavailable";
  return friendlyState(unifi.state);
}

function networkSwitchStateLabel(networkSwitch: MonitorNetworkSwitch): string {
  if (!networkSwitch.configured) return "Not commissioned";
  if (networkSwitch.state === "HEALTHY") return "Links and power healthy";
  if (networkSwitch.state === "CRITICAL") return "Switch needs action";
  if (networkSwitch.state === "DEGRADED") return "Switch needs attention";
  if (networkSwitch.state === "UNKNOWN") return "Switch status unavailable";
  return friendlyState(networkSwitch.state);
}

function switchPortRoleLabel(role: MonitorNetworkSwitch["ports"][number]["role"]): string {
  if (role === "access_point") return "Access point";
  if (role === "router_uplink") return "Router uplink";
  return "Other connection";
}

function friendlyState(state: string): string {
  return state.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function formatBitrate(value: number | null | undefined): string {
  if (value == null) return "--";
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbps` : `${Math.round(value / 1_000)} kbps`;
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "--" : `${value.toFixed(1)}%`;
}

function formatDataUsage(usageMb: number | null | undefined, quotaMb: number | null | undefined): string {
  if (usageMb == null || quotaMb == null) return "--";
  return `${formatMegabytes(usageMb)} / ${formatMegabytes(quotaMb)}`;
}

function formatMegabytes(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} GB` : `${Math.round(value)} MB`;
}

function formatWanBands(bands: MonitorRouter["wans"][number]["bands"]): string {
  if (bands.length === 0) return "--";
  return bands.map((band) => {
    const signal = band.rsrpDbm ?? band.rssiDbm;
    return `${band.name}${band.channelWidth ? ` ${band.channelWidth}` : ""}${signal == null ? "" : ` · ${signal} dBm`}`;
  }).join(", ");
}

function formatFps(value: number | null | undefined): string {
  return value == null ? "--" : `${value.toFixed(1)} fps`;
}

function formatMs(value: number | null | undefined): string {
  return value == null ? "--" : `${Math.round(value)} ms`;
}

function formatOptionalPercent(value: number | null | undefined): string {
  return value == null ? "--" : `${value.toFixed(1)}%`;
}

function formatWatts(value: number | null | undefined): string {
  return value == null ? "--" : `${value.toFixed(value < 10 ? 1 : 0)} W`;
}

function formatBytes(value: number | null | undefined): string {
  if (value == null) return "--";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

function formatUptime(value: number | null | undefined): string {
  if (value == null) return "--";
  if (value < 3_600) return `${Math.floor(value / 60)}m`;
  if (value < 86_400) return `${Math.floor(value / 3_600)}h ${Math.floor(value % 3_600 / 60)}m`;
  return `${Math.floor(value / 86_400)}d ${Math.floor(value % 86_400 / 3_600)}h`;
}

function relativeTimestamp(value: string | null | undefined, nowMs: number): string {
  if (!value) return "--";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? `${formatDuration(Math.max(0, nowMs - timestamp))} ago` : "--";
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

function transportRecovery(path: MonitorMediaPath | undefined): string {
  const retransmitted = path?.transport?.packetsRetransmitted;
  const received = path?.transport?.packetsReceived;
  return retransmitted != null && received != null ? percent(retransmitted, received) : "--";
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

function browserLivenessLabel(liveness: MonitorBrowserLiveness): string {
  if (liveness.state === "LIVE") return "viewer live";
  if (liveness.state === "STATUS_MISSING") return "viewer status missing";
  if (liveness.state === "CLOSED") return `viewer closed ${formatDuration(liveness.heartbeatAgeMs ?? 0)} ago`;
  return "viewer closed";
}

function browserLivenessDetail(liveness: MonitorBrowserLiveness): string {
  if (liveness.state === "LIVE") return "A current program reader and fresh browser status are both present.";
  if (liveness.state === "STATUS_MISSING") return "A program reader exists, but its browser status is no longer updating.";
  if (liveness.state === "CLOSED") return `The last browser status was received ${formatDuration(liveness.heartbeatAgeMs ?? 0)} ago. Historical counters are not shown as current.`;
  return "No program browser has reported yet.";
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

function visualLabel(content: MonitorCourt["contentAnalysis"]): string {
  if (!content || content.state !== "ANALYZING" || !content.visual.sampledAt) return "picture check unavailable";
  if (content.visual.blackDurationMs > 0) return `black ${formatDuration(content.visual.blackDurationMs)}`;
  if (content.visual.frozenDurationMs > 0) return `still ${formatDuration(content.visual.frozenDurationMs)}`;
  if (!content.audio.trackPresent) return "camera audio missing";
  if ((content.audio.clippedSampleRatio ?? 0) > 0.05) return "camera audio clipping";
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
