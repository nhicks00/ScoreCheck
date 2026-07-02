"use client";

import { Copy, HeartPulse, Link as LinkIcon, Minus, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, RotateCw, ShieldOff, Snowflake, StepForward, Trophy, Unlock } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { formatRelativeTime, isFreshTimestamp } from "@/lib/timeLabels";

type DashboardEvent = {
  id: string;
  name: string;
  venue: string | null;
  event_date: string | null;
  status: string;
  settings?: Record<string, unknown> | null;
};

type DashboardMatch = {
  id: string;
  source_type?: "vbl" | "manual";
  match_number: string | null;
  round_name: string | null;
  scheduled_time: string | null;
  scheduled_date: string | null;
  court_number: string | null;
  physical_court: string | null;
  team_a: string | null;
  team_b: string | null;
  team_a_seed: string | null;
  team_b_seed: string | null;
};

type DashboardScore = {
  team_a_score: number;
  team_b_score: number;
  team_a_sets: number;
  team_b_sets: number;
  current_set: number;
  serving_team: "A" | "B" | null;
  status: string;
  source: "api" | "manual" | "override";
  source_available?: boolean | null;
  source_priority?: "primary" | "fallback" | "override" | null;
  stale: boolean;
  message?: string | null;
  updated_at: string | null;
  last_api_poll_at: string | null;
};

type DashboardCourt = {
  id: string;
  event_id: string;
  court_number: number;
  display_name: string;
  camera_name: string | null;
  mode: "api" | "manual" | "hybrid";
  status: string;
  frozen: boolean;
  last_update_at: string | null;
  scorer_token_hash?: string | null;
  scorer_token_revoked_at?: string | null;
  vbl_court_number?: string | null;
  vbl_court_label?: string | null;
  matches?: DashboardMatch | DashboardMatch[] | null;
  score_states?: DashboardScore | DashboardScore[] | null;
};

type SourceRow = {
  id: string;
  source_url: string;
  source_type: string;
  status: string;
  last_error: string | null;
};

type QueueRow = {
  id: string;
  court_id: string;
  match_id: string;
  queue_position: number;
  is_active: boolean;
  status: string;
  matches?: DashboardMatch | DashboardMatch[] | null;
};

type HeartbeatRow = {
  worker_id: string;
  status: string;
  event_id: string | null;
  metadata: Record<string, unknown>;
  last_seen_at: string;
};

type PollerErrorRow = {
  id: string;
  court_id: string | null;
  match_id: string | null;
  source_url: string | null;
  message: string;
  created_at: string;
};

type LinkBundle = {
  scorerUrl?: string;
  overlayUrl?: string;
};

type EventDashboardProps = {
  event: DashboardEvent;
  sources: SourceRow[];
  courts: DashboardCourt[];
  matches: DashboardMatch[];
  queues: QueueRow[];
  heartbeats: HeartbeatRow[];
  pollerErrors: PollerErrorRow[];
  schemaWarnings: string[];
  siteUrl: string;
};

type TabKey = "overview" | "automated" | "manual" | "queues" | "health";

export function EventDashboard({ event, sources, courts, matches, queues, heartbeats, pollerErrors, schemaWarnings, siteUrl }: EventDashboardProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [linksByCourt, setLinksByCourt] = useState<Record<string, LinkBundle>>({});
  const pollingRef = useRef(false);

  const matchOptions = useMemo(() => matches.map((match) => ({
    id: match.id,
    label: `${match.match_number ?? "Match"} - ${match.team_a ?? "Team A"} vs ${match.team_b ?? "Team B"}`
  })), [matches]);
  const vblMatches = useMemo(() => matches.filter((match) => (match.source_type ?? "vbl") === "vbl"), [matches]);
  const unmappedVblCourts = useMemo(() => {
    const mapped = new Set(courts.map((court) => court.vbl_court_number).filter(Boolean));
    return [...new Set(vblMatches.map((match) => match.court_number).filter(Boolean) as string[])]
      .filter((courtNumber) => !mapped.has(courtNumber))
      .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  }, [courts, vblMatches]);
  const manualCourts = useMemo(() => courts.filter((court) => {
    const active = firstRelation(court.matches);
    return court.mode === "manual" || court.mode === "hybrid" || active?.source_type === "manual";
  }), [courts]);

  const queueByCourt = useMemo(() => {
    const map = new Map<string, QueueRow[]>();
    for (const row of queues) {
      const next = map.get(row.court_id) ?? [];
      next.push(row);
      map.set(row.court_id, next);
    }
    return map;
  }, [queues]);

  const latestHeartbeat = heartbeats[0];
  const workerIsFresh = isFreshTimestamp(latestHeartbeat?.last_seen_at, 60_000);
  const overlayLayout = event.settings?.overlayLayout === "top-left" ? "top-left" : "bottom-left";

  useEffect(() => {
    setLinksByCourt(loadStoredScorerLinks(event.id));
  }, [event.id]);

  async function call(label: string, url: string, body?: Record<string, unknown>, method = "POST") {
    setBusy(label);
    setMessage(null);
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setMessage(json.error ?? "Request failed");
      return null;
    }
    setMessage(json.discovered != null ? discoveryMessage(json) : "Saved");
    router.refresh();
    return json;
  }

  async function createManualSession(eventSubmit: FormEvent<HTMLFormElement>) {
    eventSubmit.preventDefault();
    const form = new FormData(eventSubmit.currentTarget);
    const body = Object.fromEntries(form.entries());
    const json = await call("manual-session", `/api/events/${event.id}/manual-sessions`, body);
    if (!json?.court?.id) return;
    rememberScorerLinks(json.court.id, { scorerUrl: json.scorerUrl, overlayUrl: json.overlayUrl });
  }

  async function saveVblMapping(eventSubmit: FormEvent<HTMLFormElement>, courtId: string) {
    eventSubmit.preventDefault();
    const form = new FormData(eventSubmit.currentTarget);
    await call(`vbl-map-${courtId}`, `/api/admin/fan-scoring/courts/${courtId}`, {
      vblCourtNumber: form.get("vblCourtNumber"),
      vblCourtLabel: form.get("vblCourtLabel")
    }, "PATCH");
  }

  async function rotateScorer(courtId: string) {
    const json = await call(`rotate-${courtId}`, `/api/courts/${courtId}/scorer-token/rotate`);
    if (!json?.scorerUrl) return;
    rememberScorerLinks(courtId, { scorerUrl: json.scorerUrl });
  }

  function rememberScorerLinks(courtId: string, links: LinkBundle) {
    setLinksByCourt((current) => {
      const next = {
        ...current,
        [courtId]: {
          ...current[courtId],
          ...links
        }
      };
      storeScorerLinks(event.id, next);
      return next;
    });
  }

  async function startPolling() {
    pollingRef.current = true;
    setPolling(true);
    while (pollingRef.current) {
      const result = await call("polling", "/api/poller/start", { eventId: event.id });
      if (!result || !pollingRef.current) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    setPolling(false);
  }

  function overlayUrl(court: DashboardCourt) {
    return `${browserOrigin(siteUrl)}/overlay/stream/${court.court_number}`;
  }

  function eventOverlayUrl(court: DashboardCourt) {
    return `${browserOrigin(siteUrl)}/overlay/court/${court.court_number}?eventId=${event.id}`;
  }

  return (
    <div className="stack">
      <div className="row">
        <div>
          <h1>{event.name}</h1>
          <p className="muted">{event.venue || "No venue"} {event.event_date ? `- ${event.event_date}` : ""}</p>
        </div>
        <div className="row">
          <button className="warn" onClick={() => call("discover", `/api/events/${event.id}/discover-matches`)} disabled={busy != null}>
            <RefreshCw size={16} /> Discover
          </button>
          <button className={polling ? "danger" : "primary"} onClick={() => {
            if (polling) {
              pollingRef.current = false;
              setPolling(false);
            } else {
              void startPolling();
            }
          }}>
            {polling ? <Pause size={16} /> : <Play size={16} />} {polling ? "Stop Local Poller" : "Local Poller"}
          </button>
        </div>
      </div>

      {schemaWarnings.length > 0 && (
        <div className="panel warn-surface">
          Migration `002_remote_manual_scoring_and_worker.sql` has not been applied yet. Queue, worker, and manual scorer features need that migration before live testing.
        </div>
      )}
      {message && <div className="panel muted">{message}</div>}

      <nav className="tabs">
        {[
          ["overview", "Overview"],
          ["automated", "Automated VBL"],
          ["manual", "Manual Sessions"],
          ["queues", "Courts & Queues"],
          ["health", "Health"]
        ].map(([key, label]) => (
          <button key={key} className={activeTab === key ? "active" : ""} onClick={() => setActiveTab(key as TabKey)}>{label}</button>
        ))}
      </nav>

      {activeTab === "overview" && (
        <section className="grid four">
          <Metric label="Courts" value={String(courts.length)} />
          <Metric label="Matches" value={String(matches.length)} />
          <Metric label="Live Courts" value={String(courts.filter((court) => court.status === "live").length)} />
          <Metric label="Worker" value={latestHeartbeat && workerIsFresh ? formatRelativeTime(latestHeartbeat.last_seen_at) : "Offline"} icon={<HeartPulse size={18} />} />
          <div className="panel span-all stack">
            <div className="row wrap">
              <div>
                <h2>Overlay Position</h2>
                <p className="muted">Static stream overlays use this position for every court.</p>
              </div>
              <div className="row wrap">
                <button
                  className={overlayLayout === "top-left" ? "primary" : ""}
                  onClick={() => call("overlay-layout-top-left", `/api/events/${event.id}/settings`, { overlayLayout: "top-left" }, "PATCH")}
                  disabled={busy != null}
                >
                  Top Left
                </button>
                <button
                  className={overlayLayout === "bottom-left" ? "primary" : ""}
                  onClick={() => call("overlay-layout-bottom-left", `/api/events/${event.id}/settings`, { overlayLayout: "bottom-left" }, "PATCH")}
                  disabled={busy != null}
                >
                  Bottom Left
                </button>
              </div>
            </div>
          </div>
          <div className="panel span-all stack">
            <h2>Court Health</h2>
            <p className="muted">Use the static stream overlay URLs in Streamrun. They stay the same across tournaments and resolve to the active event.</p>
            <div className="grid courts">
              {courts.map((court) => <CourtSummary key={court.id} court={court} queueCount={queueByCourt.get(court.id)?.length ?? 0} overlayUrl={overlayUrl(court)} copy={copyText} />)}
            </div>
          </div>
        </section>
      )}

      {activeTab === "automated" && (
        <section className="grid two">
          <form className="panel stack" action={`/api/events/${event.id}/brackets`} method="post">
            <h2>Bracket Sources</h2>
            <label>
              VolleyballLife bracket or pool URL
              <input name="sourceUrl" placeholder="https://volleyballlife.com/event/..." required />
            </label>
            <button type="submit"><LinkIcon size={16} /> Add URL</button>
            <div className="stack">
              {sources.map((source) => (
                <div className="row" key={source.id}>
                  <span className="muted truncate">{source.source_url}</span>
                  <span className={`status ${source.status}`}>{source.status}</span>
                </div>
              ))}
            </div>
          </form>

          <div className="panel stack">
            <h2>Discovered Matches</h2>
            <p className="muted">{vblMatches.length} VBL matches available for assignment. {unmappedVblCourts.length ? `Unmapped physical courts: ${unmappedVblCourts.join(", ")}` : "All discovered physical courts are mapped."}</p>
            <div className="scroll-table">
              <table className="table">
                <thead>
                  <tr><th>Match</th><th>Teams</th><th>Court</th><th>Source</th></tr>
                </thead>
                <tbody>
                  {vblMatches.map((match) => (
                    <tr key={match.id}>
                      <td>{match.match_number ?? ""}</td>
                      <td>{match.team_a ?? "Team A"} vs {match.team_b ?? "Team B"}</td>
                      <td>{match.court_number ?? ""}</td>
                      <td>{match.source_type ?? "vbl"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel span-all stack">
            <h2>VBL Court Mapping</h2>
            <p className="muted">Map VolleyballLife physical court numbers to the eight ScoreCheck stream slots. Unmapped VBL matches stay discovered but are not auto-assigned.</p>
            <div className="mapping-grid">
              {courts.map((court) => (
                <form className="mapping-row" key={court.id} onSubmit={(eventSubmit) => saveVblMapping(eventSubmit, court.id)}>
                  <strong>{court.display_name}</strong>
                  <label>VBL court<input name="vblCourtNumber" defaultValue={court.vbl_court_number ?? ""} placeholder="7" /></label>
                  <label>Label<input name="vblCourtLabel" defaultValue={court.vbl_court_label ?? ""} placeholder={court.display_name} /></label>
                  <button type="submit" disabled={busy != null}>Save</button>
                </form>
              ))}
            </div>
          </div>
        </section>
      )}

      {activeTab === "manual" && (
        <section className="grid two">
          <form className="panel stack" onSubmit={createManualSession}>
            <h2>Create Manual Session</h2>
            <div className="grid two compact">
              <label>Court Number<input name="courtNumber" type="number" min="1" defaultValue="1" required /></label>
              <label>Display Name<input name="displayName" placeholder="Court 1" /></label>
              <label>Team A<input name="teamA" placeholder="Team A" /></label>
              <label>Team B<input name="teamB" placeholder="Team B" /></label>
              <label>Best Of<input name="bestOf" type="number" min="1" max="5" defaultValue="3" /></label>
              <label>Cap<input name="cap" placeholder="none" /></label>
            </div>
            <button className="primary" type="submit" disabled={busy === "manual-session"}>Create Session</button>
          </form>
          <div className="panel stack">
            <h2>Scorer Links</h2>
            <p className="muted">Scorer URLs generated in this browser session survive refreshes. If a scorer URL is missing, rotate the scorer link to generate a new one.</p>
            {manualCourts.length === 0 && <p className="muted">No manual sessions yet.</p>}
            {manualCourts.map((court) => {
              const links = linksByCourt[court.id] ?? {};
              const currentOverlayUrl = links.overlayUrl ?? overlayUrl(court);
              const hasToken = Boolean(court.scorer_token_hash && !court.scorer_token_revoked_at);
              return (
                <div className="link-card" key={court.id}>
                  <strong>{court.display_name}</strong>
                  <span className={hasToken ? "status live" : "status stale"}>{hasToken ? "scorer link active" : "scorer link missing/revoked"}</span>
                  <button onClick={() => links.scorerUrl && copyText(normalizeScorerUrl(links.scorerUrl, siteUrl, court.id))} disabled={!links.scorerUrl}><Copy size={16} /> Copy Scorer URL</button>
                  <button onClick={() => rotateScorer(court.id)} disabled={busy != null}><RotateCw size={16} /> {links.scorerUrl ? "Rotate Scorer URL" : "Generate Scorer URL"}</button>
                  <button onClick={() => copyText(currentOverlayUrl)}><Copy size={16} /> Copy Overlay URL</button>
                  {!links.scorerUrl && <p className="muted">The original secret URL cannot be recovered after leaving this browser session. Generate a new scorer URL if you need to share it again.</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {activeTab === "queues" && (
        <section className="grid courts">
          {courts.map((court) => {
            const active = firstRelation(court.matches);
            const score = firstRelation(court.score_states);
            const courtQueues = queueByCourt.get(court.id) ?? [];
            const links = linksByCourt[court.id];
            return (
              <article className="panel stack" key={court.id}>
                <div className="row">
                  <div>
                    <h3>{court.display_name}</h3>
                    <p className="muted">{court.camera_name || `Court ${court.court_number}`}</p>
                  </div>
                  <span className={`status ${court.frozen ? "stale" : court.status}`}>{court.frozen ? "frozen" : court.status}</span>
                </div>
                <div className="score-line">
                  <strong>{score ? `${score.team_a_score}-${score.team_b_score}` : "0-0"}</strong>
                  <span>{score ? `${score.team_a_sets}-${score.team_b_sets} sets` : "0-0 sets"}</span>
                  <span className="muted">{scoreSourceLabel(court.mode, score)}</span>
                </div>
                <p>{active ? `${active.team_a ?? "Team A"} vs ${active.team_b ?? "Team B"}` : "No active match"}</p>
                <label>
                  Assign active match
                  <select
                    value={active?.id ?? ""}
                    onChange={(change) => call(`assign-${court.id}`, `/api/courts/${court.id}/assign-match`, { matchId: change.target.value })}
                  >
                    <option value="">No match</option>
                    {matchOptions.map((match) => <option key={match.id} value={match.id}>{match.label}</option>)}
                  </select>
                </label>
                <div className="queue-list">
                  {courtQueues.slice(0, 5).map((queue) => {
                    const queuedMatch = firstRelation(queue.matches);
                    return <span key={queue.id}>{queue.is_active ? "Active" : `#${queue.queue_position}`}: {queuedMatch?.team_a ?? "Team A"} vs {queuedMatch?.team_b ?? "Team B"}</span>;
                  })}
                  {courtQueues.length === 0 && <span className="muted">No queued matches</span>}
                </div>
                <div className="row wrap">
                  <button onClick={() => copyText(overlayUrl(court))}><Copy size={16} /> Overlay</button>
                  <button onClick={() => copyText(eventOverlayUrl(court))}><Copy size={16} /> Event Overlay</button>
                  <button onClick={() => rotateScorer(court.id)}><RotateCw size={16} /> Rotate Scorer</button>
                  <button onClick={() => links?.scorerUrl && copyText(normalizeScorerUrl(links.scorerUrl, siteUrl, court.id))} disabled={!links?.scorerUrl}><Copy size={16} /> Scorer</button>
                  <button onClick={() => call(`revoke-${court.id}`, `/api/courts/${court.id}/scorer-token/revoke`)}><ShieldOff size={16} /> Revoke</button>
                  <button onClick={() => call(`next-${court.id}`, `/api/courts/${court.id}/force-next`)}><StepForward size={16} /> Next</button>
                  <button className={court.frozen ? "" : "warn"} onClick={() => call(`freeze-${court.id}`, `/api/courts/${court.id}/${court.frozen ? "unfreeze" : "freeze"}`)}>
                    {court.frozen ? <Unlock size={16} /> : <Snowflake size={16} />} {court.frozen ? "Unfreeze" : "Freeze"}
                  </button>
                </div>
                {active && (
                  <AdminTakeoverPanel
                    court={court}
                    match={active}
                    score={score}
                    busy={busy}
                    call={call}
                  />
                )}
                <p className="muted">Last update: {court.last_update_at ? formatRelativeTime(court.last_update_at) : "never"} · queue {courtQueues.length}</p>
              </article>
            );
          })}
        </section>
      )}

      {activeTab === "health" && (
        <section className="grid two">
          <div className="panel stack">
            <h2>Worker Heartbeat</h2>
            {heartbeats.length === 0 && <p className="muted">No worker heartbeat yet.</p>}
            {heartbeats.map((heartbeat) => (
              <div className="row" key={heartbeat.worker_id}>
                <span>{heartbeat.worker_id}</span>
                <span className={isFreshTimestamp(heartbeat.last_seen_at, 60_000) ? "muted" : "status stale"}>
                  {heartbeat.status} · {formatRelativeTime(heartbeat.last_seen_at)}
                </span>
              </div>
            ))}
          </div>
          <div className="panel stack">
            <h2>Poll Errors</h2>
            {pollerErrors.length === 0 && <p className="muted">No poll errors logged.</p>}
            {pollerErrors.map((error) => (
              <div className="error-row" key={error.id}>
                <strong>{formatRelativeTime(error.created_at)}</strong>
                <span>{error.message}</span>
                {error.source_url && <span className="muted truncate">{error.source_url}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function AdminTakeoverPanel({
  court,
  match,
  score,
  busy,
  call
}: {
  court: DashboardCourt;
  match: DashboardMatch;
  score: DashboardScore | null;
  busy: string | null;
  call: (label: string, url: string, body?: Record<string, unknown>, method?: string) => Promise<Record<string, unknown> | null>;
}) {
  async function submitScore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await call(`admin-score-${court.id}`, `/api/courts/${court.id}/admin-score`, {
      actionId: crypto.randomUUID(),
      actorLabel: "admin dashboard",
      ...Object.fromEntries(form.entries())
    }, "PATCH");
  }

  async function submitMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await call(`admin-match-${court.id}`, `/api/courts/${court.id}/admin-match`, Object.fromEntries(form.entries()), "PATCH");
  }

  async function adminAction(action: string) {
    await call(`admin-${action}-${court.id}`, `/api/courts/${court.id}/admin-score`, {
      action,
      actionId: crypto.randomUUID(),
      actorLabel: "admin dashboard"
    });
  }

  return (
    <details className="takeover-panel">
      <summary><Pencil size={16} /> Admin takeover</summary>
      <div className="takeover-grid">
        <div className="stack">
          <h4>Live Score</h4>
          <div className="admin-score-buttons">
            <button onClick={() => adminAction("point-a")} disabled={busy != null}><Plus size={16} /> A</button>
            <button onClick={() => adminAction("point-b")} disabled={busy != null}><Plus size={16} /> B</button>
            <button onClick={() => adminAction("undo")} disabled={busy != null}><RotateCcw size={16} /> Undo</button>
            <button onClick={() => adminAction("toggle-serve")} disabled={busy != null}><Minus size={16} /> Serve</button>
            <button onClick={() => adminAction("set-complete")} disabled={busy != null}><Trophy size={16} /> Set</button>
            <button className="danger" onClick={() => adminAction("match-complete")} disabled={busy != null}><Trophy size={16} /> Match</button>
          </div>
          <form
            className="admin-edit-form"
            key={`${score?.team_a_score ?? 0}-${score?.team_b_score ?? 0}-${score?.team_a_sets ?? 0}-${score?.team_b_sets ?? 0}-${score?.current_set ?? 1}-${score?.serving_team ?? "none"}`}
            onSubmit={submitScore}
          >
            <label>A Score<input name="teamAScore" type="number" min="0" defaultValue={score?.team_a_score ?? 0} /></label>
            <label>B Score<input name="teamBScore" type="number" min="0" defaultValue={score?.team_b_score ?? 0} /></label>
            <label>A Sets<input name="teamASets" type="number" min="0" defaultValue={score?.team_a_sets ?? 0} /></label>
            <label>B Sets<input name="teamBSets" type="number" min="0" defaultValue={score?.team_b_sets ?? 0} /></label>
            <label>Set<input name="currentSet" type="number" min="1" defaultValue={score?.current_set ?? 1} /></label>
            <label>Serving
              <select name="servingTeam" defaultValue={score?.serving_team ?? "none"}>
                <option value="none">None</option>
                <option value="A">Team A</option>
                <option value="B">Team B</option>
              </select>
            </label>
            <button className="primary" type="submit" disabled={busy != null}>Apply Score</button>
          </form>
        </div>
        <form className="admin-edit-form" onSubmit={submitMatch}>
          <h4>Match Info</h4>
          <label>Team A<input name="teamA" defaultValue={match.team_a ?? ""} /></label>
          <label>Team B<input name="teamB" defaultValue={match.team_b ?? ""} /></label>
          <label>A Seed<input name="teamASeed" defaultValue={match.team_a_seed ?? ""} /></label>
          <label>B Seed<input name="teamBSeed" defaultValue={match.team_b_seed ?? ""} /></label>
          <label>Match #<input name="matchNumber" defaultValue={match.match_number ?? ""} /></label>
          <label>Round<input name="roundName" defaultValue={match.round_name ?? ""} /></label>
          <label>Time<input name="scheduledTime" defaultValue={match.scheduled_time ?? ""} /></label>
          <button className="primary" type="submit" disabled={busy != null}>Save Match Info</button>
        </form>
      </div>
    </details>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="panel metric">
      <span>{label}</span>
      <strong>{icon}{value}</strong>
    </div>
  );
}

function CourtSummary({ court, queueCount, overlayUrl, copy }: { court: DashboardCourt; queueCount: number; overlayUrl: string; copy: (value: string) => void }) {
  const score = firstRelation(court.score_states);
  return (
    <article className="court-summary">
      <div className="row">
        <strong>{court.display_name}</strong>
        <span className={`status ${score?.stale ? "stale" : court.status}`}>{court.frozen ? "frozen" : score?.stale ? "stale" : court.status}</span>
      </div>
      <div className="score-line">
        <strong>{score ? `${score.team_a_score}-${score.team_b_score}` : "0-0"}</strong>
        <span>{scoreSourceLabel(court.mode, score)}</span>
        <span>{queueCount} queued</span>
      </div>
      <button onClick={() => copy(overlayUrl)}><Copy size={16} /> Overlay</button>
    </article>
  );
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function copyText(value: string) {
  void navigator.clipboard.writeText(value);
}

function discoveryMessage(json: Record<string, unknown>) {
  const unmapped = Array.isArray(json.unmappedCourts) ? json.unmappedCourts.filter(Boolean).join(", ") : "";
  const base = `Discovered ${json.discovered} matches, queued ${json.queued ?? 0}, activated ${json.activated ?? 0}`;
  return unmapped ? `${base}. Unmapped VBL courts: ${unmapped}` : base;
}

function browserOrigin(configuredSiteUrl: string) {
  const configured = configuredSiteUrl.trim().replace(/\/$/, "");
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      if (configured.includes(".")) {
        try {
          return new URL(`https://${configured}`).origin;
        } catch {
          // Fall through to current browser origin.
        }
      }
    }
  }
  return typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
}

function normalizeCopiedUrl(value: string, configuredSiteUrl: string) {
  try {
    return new URL(value).toString();
  } catch {
    const origin = browserOrigin(configuredSiteUrl);
    if (value.startsWith("/")) {
      return new URL(value, origin).toString();
    }
    const scorePathIndex = value.indexOf("/score/court/");
    if (scorePathIndex >= 0) {
      return new URL(value.slice(scorePathIndex), origin).toString();
    }
    return new URL(value, origin).toString();
  }
}

function normalizeScorerUrl(value: string, configuredSiteUrl: string, courtId: string) {
  const normalized = normalizeCopiedUrl(value, configuredSiteUrl);
  if (normalized.includes("/score/court/")) {
    return normalized;
  }
  const lastSegment = value.split(/[/?#]/).filter(Boolean).pop();
  if (lastSegment) {
    return new URL(`/score/court/${courtId}?token=${encodeURIComponent(lastSegment)}`, browserOrigin(configuredSiteUrl)).toString();
  }
  return normalized;
}

function scorerLinksStorageKey(eventId: string) {
  return `mcs:scorer-links:${eventId}`;
}

function loadStoredScorerLinks(eventId: string): Record<string, LinkBundle> {
  if (typeof window === "undefined") return {};
  const raw = window.sessionStorage.getItem(scorerLinksStorageKey(eventId));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, LinkBundle> : {};
  } catch {
    return {};
  }
}

function storeScorerLinks(eventId: string, links: Record<string, LinkBundle>) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(scorerLinksStorageKey(eventId), JSON.stringify(links));
}

function scoreSourceLabel(mode: DashboardCourt["mode"], score: DashboardScore | null) {
  if (score?.source === "override") return `${mode} override`;
  if (score?.source === "api" && score.source_priority === "fallback") return `${mode} / VBL standby`;
  if (score?.source === "api" && score.source_available === true) return `${mode} / VBL live`;
  if (score?.source && score.source !== mode) return `${mode} / ${score.source}`;
  return mode;
}
