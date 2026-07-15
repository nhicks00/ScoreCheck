"use client";

import {
  ExternalLink,
  KeyRound,
  MonitorOff,
  MonitorPlay,
  Play,
  Radio,
  Square,
  Youtube
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { StreamPlayer } from "@/components/StreamPlayer";
import { broadcastChipForEgress, egressForCourt } from "@/lib/opsConsole";
import { formatRelativeTime } from "@/lib/timeLabels";
import type { BroadcastChip } from "@/lib/opsConsole";
import type {
  ConsoleCourt,
  ConsoleHeartbeat,
  ControllerStatus,
  MediamtxStatus,
  ProductionSnapshot,
  WorkerSummary
} from "@/lib/productionStatus";
import type { StreamSources } from "@/lib/video";

/**
 * Client half of /admin/production: renders the server-assembled snapshot,
 * re-polls /api/admin/production/status every 10s, and drives the mutating
 * actions (broadcast start/stop, YouTube key set/replace) through the
 * admin-guarded proxy routes. No secrets live here — program links and
 * controller state arrive pre-gated, YouTube keys pre-masked.
 */

const POLL_INTERVAL_MS = 10_000;

export type CourtClientConfig = {
  courtNumber: number;
  /** Pre-resolved MediaMTX playback sources; null when video env is unset. */
  sources: StreamSources | null;
  /** Token-gated /program/court/N link; null unless PROGRAM_PAGE_TOKEN is set. */
  programUrl: string | null;
};

type StatusPayload = ProductionSnapshot & {
  controller: ControllerStatus;
  mediamtx: MediamtxStatus;
};

type CourtFeedback = { tone: "ok" | "warn" | "error"; text: string };

const CONTROLLER_OFFLINE_HINT =
  "Compositor controller offline — see infra/compositor/GATING_EXPERIMENT.md";

export function ProductionConsoleClient({
  initialSnapshot,
  courtConfigs,
  controllerConfigured,
  videoConfigured,
  courtCount
}: {
  initialSnapshot: ProductionSnapshot;
  courtConfigs: CourtClientConfig[];
  controllerConfigured: boolean;
  videoConfigured: boolean;
  courtCount: number;
}) {
  const [snapshot, setSnapshot] = useState<ProductionSnapshot>(initialSnapshot);
  // null until the first status poll answers — probes only run in the route.
  const [controller, setController] = useState<ControllerStatus | null>(null);
  const [mediamtx, setMediamtx] = useState<MediamtxStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [monitorsOn, setMonitorsOn] = useState<Record<number, boolean>>({});
  const [busyCourt, setBusyCourt] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<Record<number, CourtFeedback | undefined>>({});
  const [editingKeyCourt, setEditingKeyCourt] = useState<number | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [editingVideoCourt, setEditingVideoCourt] = useState<number | null>(null);
  const [videoDraft, setVideoDraft] = useState("");
  const [videoSaving, setVideoSaving] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);

  const configByCourt = new Map(courtConfigs.map((config) => [config.courtNumber, config]));

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/production/status", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as StatusPayload | { error?: string } | null;
      if (!res.ok || !json || !("courts" in json)) {
        const message = json && "error" in json && json.error ? json.error : `Status poll failed (${res.status})`;
        throw new Error(message);
      }
      setSnapshot(json);
      setController(json.controller ?? null);
      setMediamtx(json.mediamtx ?? null);
      setPollError(null);
    } catch (error) {
      setPollError(error instanceof Error ? error.message : "Status poll failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // Live env state wins once the first poll answers; before that, trust the
  // server render's env check.
  const controllerReady = controller ? controller.configured : controllerConfigured;
  const controllerReachable = controller?.reachable === true;

  function setCourtFeedback(courtNumber: number, value: CourtFeedback | undefined) {
    setFeedback((current) => ({ ...current, [courtNumber]: value }));
  }

  async function broadcast(courtNumber: number, action: "start" | "stop") {
    setBusyCourt(courtNumber);
    setCourtFeedback(courtNumber, undefined);
    try {
      const res = await fetch(`/api/admin/production/courts/${courtNumber}/${action}`, { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { error?: string; monitoringWarning?: string };
      if (!res.ok) {
        setCourtFeedback(courtNumber, {
          tone: "error",
          text: json.error ?? `Controller responded ${res.status}`
        });
      } else {
        setCourtFeedback(courtNumber, {
          tone: json.monitoringWarning ? "warn" : "ok",
          text: json.monitoringWarning ?? (action === "start" ? "Broadcast starting — egress spinning up." : "Broadcast stopping.")
        });
        void refresh();
      }
    } catch {
      setCourtFeedback(courtNumber, { tone: "error", text: "Request failed — network error." });
    } finally {
      setBusyCourt(null);
    }
  }

  function openKeyEditor(courtNumber: number) {
    setEditingKeyCourt(courtNumber);
    setKeyDraft("");
    setKeyError(null);
  }

  async function saveKey(courtNumber: number, value: string | null) {
    setKeySaving(true);
    setKeyError(null);
    try {
      const res = await fetch(`/api/admin/production/courts/${courtNumber}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ youtubeStreamKey: value })
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; youtubeKeyMasked?: string | null };
      if (!res.ok) {
        setKeyError(json.error ?? `Save failed (${res.status})`);
        return;
      }
      setSnapshot((current) => ({
        ...current,
        courts: current.courts.map((court) =>
          court.courtNumber === courtNumber ? { ...court, youtubeKeyMasked: json.youtubeKeyMasked ?? null } : court
        )
      }));
      setEditingKeyCourt(null);
      setKeyDraft("");
    } catch {
      setKeyError("Save failed — network error.");
    } finally {
      setKeySaving(false);
    }
  }

  function openVideoEditor(courtNumber: number, currentId: string | null) {
    setEditingVideoCourt(courtNumber);
    // Video ids are public (unlike stream keys), so prefill for easy edits.
    setVideoDraft(currentId ?? "");
    setVideoError(null);
  }

  async function saveVideoId(courtNumber: number, value: string | null) {
    setVideoSaving(true);
    setVideoError(null);
    try {
      const res = await fetch(`/api/admin/production/courts/${courtNumber}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ youtubeVideoId: value })
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; youtubeVideoId?: string | null };
      if (!res.ok) {
        setVideoError(json.error ?? `Save failed (${res.status})`);
        return;
      }
      setSnapshot((current) => ({
        ...current,
        courts: current.courts.map((court) =>
          court.courtNumber === courtNumber ? { ...court, youtubeVideoId: json.youtubeVideoId ?? null } : court
        )
      }));
      setEditingVideoCourt(null);
      setVideoDraft("");
    } catch {
      setVideoError("Save failed — network error.");
    } finally {
      setVideoSaving(false);
    }
  }

  return (
    <main className="shell">
      <div className="container stack">
        <div className="topbar">
          <span className="brand-mark">Score<em>Check</em></span>
          <nav className="topbar-nav" aria-label="Admin">
            <Link className="button ghost" href="/admin/monitor">Monitor</Link>
            <Link className="button ghost" href="/admin/events">Events</Link>
            <Link className="button ghost" href="/admin/commentary">Commentary</Link>
            <Link className="button ghost" href="/chat">Live Chat</Link>
          </nav>
        </div>

        <header className="admin-dashboard-header">
          <div>
            <p className="eyebrow">Producer tools</p>
            <h1>Production Console</h1>
            <p className="muted">
              Per-court program health, preview monitors, broadcast control, and YouTube stream keys.
            </p>
          </div>
          <span className={snapshot.event ? "status live" : "status warn"}>
            <Radio size={14} aria-hidden="true" /> {snapshot.event ? snapshot.event.name : "No active event"}
          </span>
        </header>

        <section className="panel production-health" aria-label="Platform health">
          <div className="production-health-grid">
            <HealthItem
              label="Worker"
              chip={workerChip(snapshot.worker)}
              note={snapshot.worker.lastSeenAt ? `beat ${formatRelativeTime(snapshot.worker.lastSeenAt)}` : undefined}
            />
            <HealthItem
              label="Program pages"
              chip={
                snapshot.freshHeartbeats > 0
                  ? { className: "status success", label: `${snapshot.freshHeartbeats}/${courtCount} fresh` }
                  : { className: "status info", label: `0/${courtCount} fresh` }
              }
              note={snapshot.heartbeatsAvailable ? undefined : "heartbeats table missing — apply migration 012"}
            />
            <HealthItem label="Controller" chip={controllerHealthChip(controller, controllerConfigured)} note={controller?.error ?? undefined} />
            <HealthItem label="Video server" chip={mediamtxChip(mediamtx)} />
          </div>
          <p className="production-health-meta muted">
            {pollError ? <span className="production-health-error">Status poll failing: {pollError}</span> : null}
            Updated {formatRelativeTime(snapshot.generatedAt, { fallback: "just now" })} · raw JSON at{" "}
            <a href="/api/health" target="_blank" rel="noreferrer"><code>/api/health</code></a>
          </p>
        </section>

        {!controllerReady && (
          <section className="panel production-offline" role="status">
            <div className="production-offline-head">
              <strong>Compositor controller offline</strong>
              <span className="status info">Expected pre-fleet</span>
            </div>
            <p className="muted">
              <code>CONTROLLER_URL</code> / <code>CONTROLLER_TOKEN</code> are not configured, so broadcast
              start/stop is disabled — see <code>infra/compositor/GATING_EXPERIMENT.md</code>. Program health,
              preview monitors, and YouTube keys work either way.
            </p>
          </section>
        )}

        <section className="production-grid" aria-label="Courts">
          {snapshot.courts.map((court) => {
            const config = configByCourt.get(court.courtNumber);
            const monitorOn = Boolean(monitorsOn[court.courtNumber]);
            const busy = busyCourt === court.courtNumber;
            const courtFeedback = feedback[court.courtNumber];
            const editingKey = editingKeyCourt === court.courtNumber;
            const editingVideo = editingVideoCourt === court.courtNumber;
            const broadcastChip = controllerReachable
              ? broadcastChipForEgress(egressForCourt(controller?.egresses, court.courtNumber))
              : null;
            const heartbeat = heartbeatChip(court.heartbeat);

            return (
              <article className="panel production-court-card" key={court.courtNumber}>
                <header className="production-court-head">
                  <div>
                    <h2>{court.displayName}</h2>
                    <p className="production-court-sub">
                      Stream {court.courtNumber} · preview <code>{court.previewStreamPath}</code> · program <code>{court.programStreamPath}</code>
                    </p>
                  </div>
                  <div className="production-chips">
                    <span className={heartbeat.className}>{heartbeat.label}</span>
                    {broadcastChip && <span className={broadcastChipClass(broadcastChip)}>{broadcastChip.label}</span>}
                  </div>
                </header>

                {courtHeartbeatDetail(court.heartbeat) && (
                  <p className="production-heartbeat-detail">{courtHeartbeatDetail(court.heartbeat)}</p>
                )}

                <div className="production-match">
                  {court.match ? (
                    <>
                      <p className="production-match-teams">
                        <strong>{court.match.teamA ?? "TBD"}</strong>
                        <span>vs</span>
                        <strong>{court.match.teamB ?? "TBD"}</strong>
                      </p>
                      {court.score ? (
                        <p className="production-score">
                          <strong>
                            {court.score.teamAScore}–{court.score.teamBScore}
                          </strong>
                          <span>
                            sets {court.score.teamASets}–{court.score.teamBSets} · set {court.score.currentSet}
                            {court.score.stale ? " · stale" : ""}
                          </span>
                        </p>
                      ) : (
                        <p className="muted">No score snapshot yet.</p>
                      )}
                      {(court.match.roundName || court.match.matchNumber) && (
                        <p className="muted production-match-meta">
                          {[court.match.roundName, court.match.matchNumber ? `Match ${court.match.matchNumber}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="muted">No current match.</p>
                  )}
                </div>

                <div className="production-monitor">
                  {!videoConfigured || !config?.sources ? (
                    <div className="production-monitor-off">
                      <MonitorOff size={18} aria-hidden="true" />
                      <span>Video not configured — set MEDIAMTX_WHEP_BASE_URL / MEDIAMTX_HLS_BASE_URL.</span>
                    </div>
                  ) : monitorOn ? (
                    <StreamPlayer courtNumber={court.courtNumber} sources={config.sources} chromeless />
                  ) : (
                    <button
                      type="button"
                      className="production-monitor-toggle"
                      onClick={() => setMonitorsOn((current) => ({ ...current, [court.courtNumber]: true }))}
                    >
                      <MonitorPlay size={20} aria-hidden="true" />
                      <span>Show preview</span>
                      <small>Muted monitor — loads on demand</small>
                    </button>
                  )}
                </div>

                <div className="production-actions">
                  {monitorOn && (
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => setMonitorsOn((current) => ({ ...current, [court.courtNumber]: false }))}
                    >
                      <MonitorOff size={14} aria-hidden="true" /> Hide preview
                    </button>
                  )}
                  <button
                    type="button"
                    className="button primary"
                    disabled={!controllerReady || busy}
                    title={controllerReady ? undefined : CONTROLLER_OFFLINE_HINT}
                    onClick={() => void broadcast(court.courtNumber, "start")}
                  >
                    <Play size={14} aria-hidden="true" /> {busy ? "Working…" : "Start broadcast"}
                  </button>
                  <button
                    type="button"
                    className="button danger"
                    disabled={!controllerReady || busy}
                    title={controllerReady ? undefined : CONTROLLER_OFFLINE_HINT}
                    onClick={() => void broadcast(court.courtNumber, "stop")}
                  >
                    <Square size={14} aria-hidden="true" /> Stop
                  </button>
                  {config?.programUrl && (
                    <a className="button ghost" href={config.programUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={14} aria-hidden="true" /> Program page
                    </a>
                  )}
                </div>

                {courtFeedback && (
                  <p className={`production-feedback ${courtFeedback.tone === "ok" ? "is-ok" : courtFeedback.tone === "warn" ? "is-warn" : "is-error"}`} role="status">
                    {courtFeedback.text}
                  </p>
                )}

                <div className="production-key-row">
                  <span className="production-key-label">
                    <KeyRound size={14} aria-hidden="true" /> YouTube key
                  </span>
                  {editingKey ? (
                    <form
                      className="production-key-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const trimmed = keyDraft.trim();
                        if (!trimmed) {
                          setKeyError("Enter a key, or use Clear to remove it.");
                          return;
                        }
                        void saveKey(court.courtNumber, trimmed);
                      }}
                    >
                      <input
                        type="password"
                        autoComplete="off"
                        placeholder="Paste full stream key"
                        value={keyDraft}
                        onChange={(event) => setKeyDraft(event.target.value)}
                        disabled={keySaving}
                        maxLength={200}
                      />
                      <button className="button primary" type="submit" disabled={keySaving}>
                        {keySaving ? "Saving…" : "Save"}
                      </button>
                      {court.youtubeKeyMasked && (
                        <button
                          className="button warn"
                          type="button"
                          disabled={keySaving}
                          onClick={() => void saveKey(court.courtNumber, null)}
                        >
                          Clear
                        </button>
                      )}
                      <button
                        className="button ghost"
                        type="button"
                        disabled={keySaving}
                        onClick={() => {
                          setEditingKeyCourt(null);
                          setKeyDraft("");
                          setKeyError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <span className="production-key-value">
                      <code>{court.youtubeKeyMasked ?? "Not set"}</code>
                      <button type="button" className="button ghost" onClick={() => openKeyEditor(court.courtNumber)}>
                        {court.youtubeKeyMasked ? "Replace" : "Set key"}
                      </button>
                    </span>
                  )}
                </div>
                {editingKey && keyError && (
                  <p className="production-feedback is-error" role="alert">{keyError}</p>
                )}

                <div className="production-key-row">
                  <span className="production-key-label">
                    <Youtube size={14} aria-hidden="true" /> YouTube video ID
                  </span>
                  {editingVideo ? (
                    <form
                      className="production-key-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const trimmed = videoDraft.trim();
                        if (!trimmed) {
                          setVideoError("Enter a video ID, or use Clear to remove it.");
                          return;
                        }
                        void saveVideoId(court.courtNumber, trimmed);
                      }}
                    >
                      <input
                        type="text"
                        autoComplete="off"
                        placeholder="Video ID from youtube.com/watch?v=…"
                        value={videoDraft}
                        onChange={(event) => setVideoDraft(event.target.value)}
                        disabled={videoSaving}
                        maxLength={100}
                      />
                      <button className="button primary" type="submit" disabled={videoSaving}>
                        {videoSaving ? "Saving…" : "Save"}
                      </button>
                      {court.youtubeVideoId && (
                        <button
                          className="button warn"
                          type="button"
                          disabled={videoSaving}
                          onClick={() => void saveVideoId(court.courtNumber, null)}
                        >
                          Clear
                        </button>
                      )}
                      <button
                        className="button ghost"
                        type="button"
                        disabled={videoSaving}
                        onClick={() => {
                          setEditingVideoCourt(null);
                          setVideoDraft("");
                          setVideoError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <span className="production-key-value">
                      <code>{court.youtubeVideoId ?? "Not set"}</code>
                      <button
                        type="button"
                        className="button ghost"
                        onClick={() => openVideoEditor(court.courtNumber, court.youtubeVideoId)}
                      >
                        {court.youtubeVideoId ? "Replace" : "Set ID"}
                      </button>
                    </span>
                  )}
                </div>
                {editingVideo && videoError && (
                  <p className="production-feedback is-error" role="alert">{videoError}</p>
                )}
              </article>
            );
          })}
        </section>

        <section className="grid two">
          <div className="panel stack">
            <h2>Commentary &amp; sync</h2>
            <p className="muted">
              Each court has an isolated LiveKit room, Web Audio gain controls, and a persisted fine-delay trim.
            </p>
            <div className="production-actions">
              <Link className="button" href="/admin/commentary">
                <ExternalLink size={14} aria-hidden="true" /> Commentary rooms
              </Link>
            </div>
          </div>
          <div className="panel stack production-runbook">
            <h2>Sync runbook — the three knobs</h2>
            <dl>
              <div>
                <dt>SRT pull latency</dt>
                <dd>Coarse video delay at MediaMTX — sets the overall program delay.</dd>
              </div>
              <div>
                <dt>Commentary delay</dt>
                <dd>Fine audio alignment in the program scene Web Audio graph.</dd>
              </div>
              <div>
                <dt>Commentary gain</dt>
                <dd>Live level control without changing the commentator connection.</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>
    </main>
  );
}

/* ---------------------------------------------------------------------------
   Presentational helpers (pure — the decision logic lives in lib/opsConsole)
--------------------------------------------------------------------------- */

type ChipView = { className: string; label: string };

function HealthItem({ label, chip, note }: { label: string; chip: ChipView; note?: string }) {
  return (
    <div className="production-health-item">
      <span>{label}</span>
      <span className={`${chip.className} production-health-chip`}>
        <span className="production-health-chip-label">{chip.label}</span>
      </span>
      {note && <span className="production-health-note">{note}</span>}
    </div>
  );
}

function heartbeatChip(heartbeat: ConsoleHeartbeat): ChipView {
  switch (heartbeat.freshness) {
    case "fresh":
      return {
        className: "status live",
        label: heartbeat.ageSeconds != null ? `Program · ${heartbeat.ageSeconds}s` : "Program live"
      };
    case "stale":
      return {
        className: "status stale",
        label: `Program stale${heartbeat.lastSeenAt ? ` · ${formatRelativeTime(heartbeat.lastSeenAt)}` : ""}`
      };
    default:
      return { className: "status", label: "No program page" };
  }
}

function courtHeartbeatDetail(heartbeat: ConsoleHeartbeat): string | null {
  if (heartbeat.freshness === "never") return null;
  const parts: string[] = [];
  if (heartbeat.videoState) parts.push(`video ${heartbeat.videoState}`);
  if (heartbeat.framesRendered != null) parts.push(`${heartbeat.framesRendered.toLocaleString()} frames`);
  if (heartbeat.commentaryRoomConnected != null) {
    parts.push(heartbeat.commentaryRoomConnected ? "audio room connected" : "audio room disconnected");
  }
  if (heartbeat.commentaryAudioTrackCount != null) parts.push(`${heartbeat.commentaryAudioTrackCount} commentary track(s)`);
  if (heartbeat.commentaryRmsDb != null) parts.push(`${heartbeat.commentaryRmsDb.toFixed(1)} dB commentary`);
  if (heartbeat.secondsSinceCommentaryAudio != null) parts.push(`${Math.round(heartbeat.secondsSinceCommentaryAudio)}s since speech`);
  if (heartbeat.commentarySyncStatus) parts.push(`sync ${heartbeat.commentarySyncStatus}`);
  if (heartbeat.commentaryDelayAppliedMs != null) {
    parts.push(`${Math.round(heartbeat.commentaryDelayAppliedMs)}ms commentary delay`);
  }
  if (heartbeat.commentarySyncRttMs != null) parts.push(`${Math.round(heartbeat.commentarySyncRttMs)}ms sync RTT`);
  return parts.length ? parts.join(" · ") : null;
}

function broadcastChipClass(chip: BroadcastChip): string {
  switch (chip.tone) {
    case "live":
      return "status live";
    case "pending":
      return "status pending";
    case "stale":
      return "status stale";
    default:
      return "status";
  }
}

function workerChip(worker: WorkerSummary): ChipView {
  switch (worker.state) {
    case "ok":
      return { className: "status success", label: worker.status ? `OK · ${worker.status}` : "OK" };
    case "stale":
      return { className: "status stale", label: "Stale" };
    case "missing":
      return { className: "status warn", label: "No heartbeat" };
    default:
      return { className: "status error", label: "Query failed" };
  }
}

function controllerHealthChip(controller: ControllerStatus | null, configuredAtRender: boolean): ChipView {
  if (!controller) {
    return configuredAtRender
      ? { className: "status pending", label: "Checking…" }
      : { className: "status info", label: "Offline — not configured" };
  }
  if (!controller.configured) return { className: "status info", label: "Offline — not configured" };
  if (controller.reachable && !controller.error) return { className: "status success", label: "Reachable" };
  if (controller.reachable) return { className: "status warn", label: "Responding with errors" };
  return { className: "status error", label: "Unreachable" };
}

function mediamtxChip(mediamtx: MediamtxStatus | null): ChipView {
  if (!mediamtx) return { className: "status pending", label: "Checking…" };
  if (!mediamtx.configured) return { className: "status info", label: "Not configured" };
  return mediamtx.up
    ? { className: "status success", label: "Reachable" }
    : { className: "status error", label: "Unreachable" };
}
