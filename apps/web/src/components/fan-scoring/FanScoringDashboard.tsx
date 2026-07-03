"use client";

import { AlertTriangle, Copy, Edit3, Eye, Radio, ShieldAlert, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import { formatRelativeTime } from "@/lib/timeLabels";

type Court = {
  id: string;
  court_number: number;
  display_name: string;
  scoring_open?: boolean | null;
  backup_requested?: boolean | null;
  youtube_video_id?: string | null;
  youtube_live_chat_id?: string | null;
  ivs_channel_arn?: string | null;
  ivs_playback_url?: string | null;
  vbl_court_number?: string | null;
  vbl_court_label?: string | null;
  matches?: Match | Match[] | null;
  score_states?: Score | Score[] | null;
};

type Match = { id: string; team_a: string | null; team_b: string | null; round_name: string | null; match_number: string | null };
type Score = { team_a_score: number; team_b_score: number; team_a_sets: number; team_b_sets: number; current_set: number; status: string; updated_at: string | null };
type Session = {
  id: string;
  court_id: string;
  role: "active" | "backup" | "waiting";
  status: string;
  display_name: string;
  youtube_display_name: string | null;
  youtube_channel_id: string | null;
  last_heartbeat_at: string | null;
  last_action_at: string | null;
  priority_score: number;
};
type Flag = { id: string; court_id: string; severity: string; status: string; type: string; message: string; created_at: string };

export function FanScoringDashboard({
  event,
  courts,
  sessions,
  flags,
  siteUrl
}: {
  event: { id: string; name: string; slug: string };
  courts: Court[];
  sessions: Session[];
  flags: Flag[];
  siteUrl: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const sessionsByCourt = useMemo(() => groupBy(sessions, (session) => session.court_id), [sessions]);
  const flagsByCourt = useMemo(() => groupBy(flags.filter((flag) => flag.status === "open"), (flag) => flag.court_id), [flags]);
  const origin = scorecheckOrigin(siteUrl);
  const openCourts = courts.filter((court) => court.scoring_open !== false).length;
  const activeSessions = sessions.filter((session) => session.role === "active" && ["active", "promoted"].includes(session.status)).length;
  const staleSessions = sessions.filter((session) => session.status === "stale").length;
  const openFlags = flags.filter((flag) => flag.status === "open").length;

  async function updateCourt(courtId: string, body: Record<string, unknown>) {
    setBusy(`court-${courtId}`);
    setMessage(null);
    const res = await fetch(`/api/admin/fan-scoring/courts/${courtId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setMessage(json.error ?? "Court update failed");
      return;
    }
    setMessage("Saved");
    router.refresh();
  }

  async function updateSession(sessionId: string, action: "promote" | "revoke" | "release") {
    setBusy(`session-${sessionId}`);
    setMessage(null);
    const res = await fetch(`/api/admin/fan-scoring/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setMessage(json.error ?? "Session update failed");
      return;
    }
    setMessage("Saved");
    router.refresh();
  }

  async function copyText(label: string, value: string) {
    setMessage(null);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        fallbackCopy(value);
      }
      setMessage(`${label} copied`);
    } catch {
      try {
        fallbackCopy(value);
        setMessage(`${label} copied`);
      } catch {
        setMessage(`${label}: ${value}`);
      }
    }
  }

  function saveMetadata(eventSubmit: FormEvent<HTMLFormElement>, courtId: string) {
    eventSubmit.preventDefault();
    const form = new FormData(eventSubmit.currentTarget);
    void updateCourt(courtId, {
      youtubeVideoId: form.get("youtubeVideoId"),
      youtubeLiveChatId: form.get("youtubeLiveChatId"),
      ivsChannelArn: form.get("ivsChannelArn"),
      ivsPlaybackUrl: form.get("ivsPlaybackUrl"),
      vblCourtNumber: form.get("vblCourtNumber"),
      vblCourtLabel: form.get("vblCourtLabel")
    });
  }

  return (
    <div className="admin-dashboard stack">
      <div className="admin-dashboard-header">
        <div>
          <h1>{event.name} Fan Scoring</h1>
          <p className="muted">Eight-court command center for scoring access, overlays, and private preview metadata.</p>
        </div>
        <button type="button" onClick={() => router.refresh()}>Refresh</button>
      </div>
      <section className="admin-summary-grid" aria-label="Fan scoring overview">
        <div>
          <span>Open Courts</span>
          <strong>{openCourts}/{courts.length}</strong>
        </div>
        <div>
          <span>Live Scorers</span>
          <strong>{activeSessions}</strong>
        </div>
        <div>
          <span>Stale Sessions</span>
          <strong>{staleSessions}</strong>
        </div>
        <div>
          <span>Open Alerts</span>
          <strong>{openFlags}</strong>
        </div>
      </section>
      {message && <div className="panel muted" role="status" aria-live="polite">{message}</div>}
      <section className="admin-command-grid">
        {courts.map((court) => {
          const courtSessions = sessionsByCourt.get(court.id) ?? [];
          const active = courtSessions.find((session) => session.role === "active" && ["active", "promoted", "stale"].includes(session.status));
          const backups = courtSessions.filter((session) => session.role === "backup" && session.status === "active");
          const courtFlags = flagsByCourt.get(court.id) ?? [];
          const match = firstRelation(court.matches);
          const score = firstRelation(court.score_states);
          const scoreUrl = `${origin}/score/court/${court.court_number}`;
          const adminScorePath = `/score/court/${court.court_number}?eventSlug=${encodeURIComponent(event.slug)}&admin=1`;
          const overlayUrl = `${origin}/overlay/stream/${court.court_number}`;
          const status = courtStatus(court, active, backups.length);
          const teamA = displayTeamName(match?.team_a, "TBD");
          const teamB = displayTeamName(match?.team_b, "TBD");
          return (
            <article className={`admin-court-card ${status.tone}`} key={court.id}>
              <header className="admin-court-header">
                <div>
                  <span className={`status ${status.badge}`}>{status.label}</span>
                  <h2>{court.display_name}</h2>
                </div>
                <div className="admin-court-key" aria-label={`Stream key ${court.court_number}`}>
                  <span>Key</span>
                  <strong>{court.court_number}</strong>
                </div>
              </header>
              <div className="admin-match-score" aria-label={`${teamA} versus ${teamB}`}>
                <div className="admin-team-row">
                  <strong>{teamA}</strong>
                  <span>{score?.team_a_score ?? 0}</span>
                </div>
                <div className="admin-vs">vs</div>
                <div className="admin-team-row">
                  <strong>{teamB}</strong>
                  <span>{score?.team_b_score ?? 0}</span>
                </div>
                <div className="admin-match-meta">
                  <span>{score?.status ?? "Pre-Match"}</span>
                  <span>Set {score?.current_set ?? 1}</span>
                  <span>Sets {score?.team_a_sets ?? 0}-{score?.team_b_sets ?? 0}</span>
                </div>
              </div>
              <section className="session-stack" aria-label={`${court.display_name} scoring sessions`}>
                <div className="admin-section-title">
                  <span>Scorer Health</span>
                  {active?.last_heartbeat_at && <small>{formatRelativeTime(active.last_heartbeat_at)}</small>}
                </div>
                <div className="session-row">
                  <ShieldCheck size={16} />
                  <div>
                    <span>Active scorer</span>
                    <strong>{active?.display_name ?? "None"}</strong>
                  </div>
                  {active && <button type="button" onClick={() => void updateSession(active.id, "revoke")} disabled={busy != null}><UserMinus size={14} /> Remove</button>}
                </div>
                {backups.length > 0 ? (
                  <details className="admin-backup-list">
                    <summary>{backups.length} extra scorer{backups.length === 1 ? "" : "s"} available</summary>
                    {backups.map((backup, index) => (
                      <div className="session-row compact" key={backup.id}>
                        <UserPlus size={16} />
                        <div>
                          <span>Contributor #{index + 1}</span>
                          <strong>{backup.display_name}</strong>
                          {backup.last_heartbeat_at && <small>{formatRelativeTime(backup.last_heartbeat_at)}</small>}
                        </div>
                        <button type="button" onClick={() => void updateSession(backup.id, "promote")} disabled={busy != null}>Promote</button>
                      </div>
                    ))}
                  </details>
                ) : (
                  <p className="admin-empty-note">No extra scorers on this court.</p>
                )}
              </section>
              {courtFlags.length > 0 && (
                <details className="admin-alert-panel">
                  <summary>
                    <AlertTriangle size={16} />
                    <span>{courtFlags.length} alert{courtFlags.length === 1 ? "" : "s"}</span>
                  </summary>
                  <div className="flag-list">
                    {courtFlags.slice(0, 6).map((flag) => <span key={flag.id}><ShieldAlert size={14} /> {flag.message}</span>)}
                  </div>
                </details>
              )}
              <div className="admin-action-stack">
                <a className="button warn" href={adminScorePath}><ShieldCheck size={14} /> Test scoring</a>
                <button type="button" onClick={() => void updateCourt(court.id, { scoringOpen: court.scoring_open === false })} disabled={busy != null}>
                  <Radio size={14} /> {court.scoring_open === false ? "Open scoring" : "Close scoring"}
                </button>
                <div className="admin-link-actions">
                  <button type="button" onClick={() => void copyText("Score URL", scoreUrl)}><Copy size={14} /> Score URL</button>
                  <button type="button" onClick={() => void copyText("Overlay URL", overlayUrl)}><Eye size={14} /> Overlay URL</button>
                </div>
              </div>
              <details className="metadata-panel">
                <summary><Edit3 size={16} /> Edit IVS / YouTube / VBL metadata</summary>
                <form className="metadata-form" onSubmit={(eventSubmit) => saveMetadata(eventSubmit, court.id)}>
                  <label>YouTube video ID<input name="youtubeVideoId" defaultValue={court.youtube_video_id ?? ""} /></label>
                  <label>YouTube live chat ID<input name="youtubeLiveChatId" defaultValue={court.youtube_live_chat_id ?? ""} /></label>
                  <label>IVS channel ARN<input name="ivsChannelArn" defaultValue={court.ivs_channel_arn ?? ""} /></label>
                  <label>IVS playback URL<input name="ivsPlaybackUrl" defaultValue={court.ivs_playback_url ?? ""} /></label>
                  <label>VBL court number<input name="vblCourtNumber" defaultValue={court.vbl_court_number ?? ""} placeholder="7" /></label>
                  <label>VBL court label<input name="vblCourtLabel" defaultValue={court.vbl_court_label ?? ""} placeholder="Court 7" /></label>
                  <button className="primary" type="submit" disabled={busy != null}>Save metadata</button>
                </form>
              </details>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function courtStatus(court: Court, active: Session | undefined, backupCount: number) {
  if (court.scoring_open === false) return { label: "Scoring closed", badge: "", tone: "closed" };
  if (!active) return { label: "No scorer", badge: "error", tone: "needs-scorer" };
  if (active.status === "stale") return { label: "Stale", badge: "", tone: "stale" };
  if (backupCount === 0) return { label: "Live scorer", badge: "success", tone: "covered" };
  return { label: "Covered", badge: "success", tone: "covered" };
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const next = map.get(key) ?? [];
    next.push(item);
    map.set(key, next);
  }
  return map;
}

function displayTeamName(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  if (!normalized || /^team on (left|right)$/i.test(normalized)) return fallback;
  return normalized;
}

function scorecheckOrigin(configuredSiteUrl: string) {
  const configured = configuredSiteUrl.trim().replace(/\/$/, "");
  const fallback = typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
  const candidate = configured || fallback;
  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    if (["beachvolleyballmedia.com", "www.beachvolleyballmedia.com", "score.beachvolleyballmedia.com"].includes(parsed.hostname)) {
      return "https://score.beachvolleyballmedia.com";
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

function fallbackCopy(value: string) {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.left = "-9999px";
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Copy command failed");
}
