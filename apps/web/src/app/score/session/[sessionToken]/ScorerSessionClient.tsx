"use client";

import { AlertTriangle, CheckCircle2, MonitorPlay, RotateCcw, Send, StopCircle, Trophy, Volleyball } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { IvsPreviewPlayer } from "@/components/IvsPreviewPlayer";

type ScoreState = {
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  currentSet: number;
  status: string;
};

type SessionState = {
  session: {
    role: "active" | "backup" | "waiting";
    status: string;
    displayName: string;
    leaseExpiresAt: string | null;
    watchMode: "website" | "courtside";
  };
  event: { name: string };
  court: { id: string; courtNumber: number; displayName: string; ivsConfigured: boolean };
  match: { team_a: string | null; team_b: string | null; round_name: string | null; match_number: string | null } | null;
  officialScore: ScoreState;
  shadowScore: ScoreState;
};

export function ScorerSessionClient({ sessionToken }: { sessionToken: string }) {
  const [state, setState] = useState<SessionState | null>(null);
  const [watchMode, setWatchMode] = useState<"website" | "courtside">("website");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCorrection, setShowCorrection] = useState(false);
  const previousRole = useRef<SessionState["session"]["role"] | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/scoring/sessions/${encodeURIComponent(sessionToken)}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(friendlyError(json.error ?? "Scorer session could not be loaded."));
      return;
    }
    if (previousRole.current === "backup" && json.session.role === "active") {
      setMessage("You are now the live scorekeeper. Your taps now update the broadcast scoreboard.");
    }
    previousRole.current = json.session.role;
    setState(json);
    setWatchMode(json.session.watchMode ?? "website");
    setError(null);
  }, [sessionToken]);

  const heartbeat = useCallback(async (nextWatchMode = watchMode) => {
    await fetch(`/api/scoring/sessions/${encodeURIComponent(sessionToken)}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionStatus: document.visibilityState, watchMode: nextWatchMode })
    }).catch(() => undefined);
  }, [sessionToken, watchMode]);

  useEffect(() => {
    void refresh();
    const refreshId = window.setInterval(refresh, 2500);
    return () => window.clearInterval(refreshId);
  }, [refresh]);

  useEffect(() => {
    void heartbeat();
    const id = window.setInterval(() => void heartbeat(), 5000);
    return () => window.clearInterval(id);
  }, [heartbeat]);

  async function action(type: string, payload?: Record<string, unknown>) {
    setBusy(type);
    setError(null);
    const res = await fetch(`/api/scoring/sessions/${encodeURIComponent(sessionToken)}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionId: crypto.randomUUID(), type, payload })
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(friendlyError(json.error ?? "Scoring action failed."));
      return;
    }
    setMessage(json.official === false ? "Saved as backup score." : "Broadcast score updated.");
    await refresh();
  }

  async function release() {
    setBusy("release");
    const res = await fetch(`/api/scoring/sessions/${encodeURIComponent(sessionToken)}/release`, { method: "POST" });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(friendlyError(json.error ?? "Could not release scorer session."));
      return;
    }
    setMessage("You are done scoring. Thank you for helping.");
    await refresh();
  }

  async function changeWatchMode(next: "website" | "courtside") {
    setWatchMode(next);
    await heartbeat(next);
  }

  function correction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action("MANUAL_CORRECTION", {
      score: {
        teamAScore: Number(form.get("teamAScore")),
        teamBScore: Number(form.get("teamBScore")),
        teamASets: Number(form.get("teamASets")),
        teamBSets: Number(form.get("teamBSets")),
        currentSet: Number(form.get("currentSet")),
        status: String(form.get("status") || "In Progress")
      }
    });
  }

  const score = state?.session.role === "backup" ? state.shadowScore : state?.officialScore;
  const teamA = state?.match?.team_a ?? "Team on left";
  const teamB = state?.match?.team_b ?? "Team on right";
  const disabled = busy != null || !state || !["active", "promoted"].includes(state.session.status);
  const isBackup = state?.session.role === "backup";

  return (
    <main className="scorer-screen">
      <div className="scorer-wrap">
        {!state && !error && <div className="panel muted">Loading scorer session...</div>}
        {error && <div className="scorer-alert danger"><AlertTriangle size={20} /> {error}</div>}
        {message && <div className="scorer-alert"><CheckCircle2 size={20} /> {message}</div>}
        {state && (
          <>
            <section className={`role-banner ${state.session.role}`}>
              <div>
                <span>{state.court.displayName}</span>
                <h1>{isBackup ? "You are a backup scorekeeper." : "You are the live scorekeeper."}</h1>
                <p>{isBackup ? "Please keep scoring. If the main scorekeeper leaves, you may become live automatically." : "Your taps update the broadcast scoreboard."}</p>
              </div>
              <strong>{state.session.displayName}</strong>
            </section>

            <section className="scorer-match">
              <div>
                <span className="muted">{state.match?.round_name ?? state.event.name}</span>
                <h2>{teamA} vs {teamB}</h2>
              </div>
              <div className="set-pill">Set {score?.currentSet ?? 1}</div>
            </section>

            <div className="watch-toggle scorer-toggle" role="group" aria-label="Watching mode">
              <button type="button" className={watchMode === "website" ? "primary" : ""} onClick={() => void changeWatchMode("website")}>
                <MonitorPlay size={18} /> On this website
              </button>
              <button type="button" className={watchMode === "courtside" ? "primary" : ""} onClick={() => void changeWatchMode("courtside")}>
                <Volleyball size={18} /> Courtside / in person
              </button>
            </div>

            <IvsPreviewPlayer sessionToken={sessionToken} courtNumber={state.court.courtNumber} enabled={watchMode === "website"} />

            <section className="point-grid">
              <button className="point-button team-a" type="button" onClick={() => void action("POINT_A")} disabled={disabled}>
                <span>{teamA}</span>
                <strong>{score?.teamAScore ?? 0}</strong>
                <em>+ POINT</em>
              </button>
              <button className="point-button team-b" type="button" onClick={() => void action("POINT_B")} disabled={disabled}>
                <span>{teamB}</span>
                <strong>{score?.teamBScore ?? 0}</strong>
                <em>+ POINT</em>
              </button>
            </section>

            <section className="session-actions">
              <button type="button" onClick={() => void action("UNDO")} disabled={disabled}>
                <RotateCcw size={18} /> Undo Last Point
              </button>
              <button className="warn" type="button" onClick={() => void action("SET_COMPLETE")} disabled={disabled}>
                <Trophy size={18} /> Set Complete
              </button>
              <button className="danger" type="button" onClick={() => void release()} disabled={disabled}>
                <StopCircle size={18} /> I Need To Stop Scoring
              </button>
            </section>

            <details className="correction-panel" open={showCorrection} onToggle={(event) => setShowCorrection(event.currentTarget.open)}>
              <summary>Need to correct the score?</summary>
              <form className="correction-grid" onSubmit={correction}>
                <label>{teamA} score<input name="teamAScore" type="number" min="0" defaultValue={score?.teamAScore ?? 0} /></label>
                <label>{teamB} score<input name="teamBScore" type="number" min="0" defaultValue={score?.teamBScore ?? 0} /></label>
                <label>{teamA} sets<input name="teamASets" type="number" min="0" max="2" defaultValue={score?.teamASets ?? 0} /></label>
                <label>{teamB} sets<input name="teamBSets" type="number" min="0" max="2" defaultValue={score?.teamBSets ?? 0} /></label>
                <label>Current set<input name="currentSet" type="number" min="1" max="3" defaultValue={score?.currentSet ?? 1} /></label>
                <label>Status<select name="status" defaultValue={score?.status ?? "In Progress"}><option>In Progress</option><option>Set Complete</option><option>Final</option></select></label>
                <button className="primary" type="submit" disabled={disabled}><Send size={18} /> Save correction</button>
              </form>
            </details>
          </>
        )}
      </div>
    </main>
  );
}

function friendlyError(message: string | null): string {
  if (!message) return "Scoring is not ready yet. Please try again in a moment.";
  if (/api key|supabase|service role|jwt|database/i.test(message)) {
    return "Scoring is not ready yet. Please try again in a moment.";
  }
  return message;
}
