"use client";

import { Copy, Edit3, Eye, Radio, ShieldAlert, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";

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
  const origin = siteUrl.replace(/\/$/, "");

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
        setMessage(`Could not copy ${label.toLowerCase()}: ${value}`);
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
      ivsPlaybackUrl: form.get("ivsPlaybackUrl")
    });
  }

  return (
    <div className="stack">
      <div className="row wrap">
        <div>
          <h1>{event.name} Fan Scoring</h1>
          <p className="muted">Eight-court command center for parent scorekeepers, overlays, and private preview metadata.</p>
        </div>
        <button type="button" onClick={() => router.refresh()}>Refresh</button>
      </div>
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
          const overlayUrl = `${origin}/overlay/stream/${court.court_number}`;
          return (
            <article className="admin-court-card" key={court.id}>
              <header className="row">
                <div>
                  <span className={`status ${active ? "success" : "error"}`}>{courtStatus(court, active, backups.length)}</span>
                  <h2>{court.display_name}</h2>
                </div>
                <strong className="court-number">{court.court_number}</strong>
              </header>
              <div className="match-line">
                <strong>{match?.team_a ?? "Team on left"}</strong>
                <span>vs</span>
                <strong>{match?.team_b ?? "Team on right"}</strong>
              </div>
              <div className="score-mini admin">
                <span>{score?.team_a_score ?? 0}</span>
                <span>-</span>
                <span>{score?.team_b_score ?? 0}</span>
                <small>{score?.status ?? "Pre-Match"}</small>
              </div>
              <div className="session-stack">
                <div className="session-row">
                  <ShieldCheck size={16} />
                  <span>Active</span>
                  <strong>{active?.display_name ?? "None"}</strong>
                  <small>{active?.last_heartbeat_at ? age(active.last_heartbeat_at) : ""}</small>
                  {active && <button type="button" onClick={() => void updateSession(active.id, "revoke")} disabled={busy != null}><UserMinus size={14} /> Remove</button>}
                </div>
                {backups.map((backup, index) => (
                  <div className="session-row" key={backup.id}>
                    <UserPlus size={16} />
                    <span>Backup #{index + 1}</span>
                    <strong>{backup.display_name}</strong>
                    <small>{backup.last_heartbeat_at ? age(backup.last_heartbeat_at) : ""}</small>
                    <button type="button" onClick={() => void updateSession(backup.id, "promote")} disabled={busy != null}>Promote</button>
                  </div>
                ))}
              </div>
              {courtFlags.length > 0 && (
                <div className="flag-list">
                  {courtFlags.slice(0, 3).map((flag) => <span key={flag.id}><ShieldAlert size={14} /> {flag.message}</span>)}
                </div>
              )}
              <div className="admin-button-row">
                <button type="button" onClick={() => void updateCourt(court.id, { scoringOpen: court.scoring_open === false })} disabled={busy != null}>
                  <Radio size={14} /> {court.scoring_open === false ? "Open scoring" : "Close scoring"}
                </button>
                <button type="button" onClick={() => void copyText("Score URL", scoreUrl)}><Copy size={14} /> Score URL</button>
                <button type="button" onClick={() => void copyText("Overlay URL", overlayUrl)}><Eye size={14} /> Overlay URL</button>
              </div>
              <details className="metadata-panel">
                <summary><Edit3 size={16} /> Edit IVS / YouTube metadata</summary>
                <form className="metadata-form" onSubmit={(eventSubmit) => saveMetadata(eventSubmit, court.id)}>
                  <label>YouTube video ID<input name="youtubeVideoId" defaultValue={court.youtube_video_id ?? ""} /></label>
                  <label>YouTube live chat ID<input name="youtubeLiveChatId" defaultValue={court.youtube_live_chat_id ?? ""} /></label>
                  <label>IVS channel ARN<input name="ivsChannelArn" defaultValue={court.ivs_channel_arn ?? ""} /></label>
                  <label>IVS playback URL<input name="ivsPlaybackUrl" defaultValue={court.ivs_playback_url ?? ""} /></label>
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
  if (court.scoring_open === false) return "Scoring closed";
  if (!active) return "No scorer";
  if (active.status === "stale") return "Stale";
  if (backupCount === 0) return "Backup needed";
  return "Covered";
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

function age(value: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
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
