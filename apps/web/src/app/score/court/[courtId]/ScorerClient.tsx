"use client";

import { CheckCircle, Flag, Minus, Pencil, RotateCcw, Timer, Trophy } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type ScorerState = {
  court: {
    id: string;
    eventId: string;
    courtNumber: number;
    displayName: string;
    mode: string;
    status: string;
    frozen: boolean;
  };
  match: {
    id: string;
    team_a: string | null;
    team_b: string | null;
    round_name: string | null;
    match_number: string | null;
  } | null;
  score: {
    team_a_score: number;
    team_b_score: number;
    team_a_sets: number;
    team_b_sets: number;
    current_set: number;
    serving_team: "A" | "B" | null;
    status: string;
  };
};

export function ScorerClient({ courtId, initialToken }: { courtId: string; initialToken: string }) {
  const [token] = useState(initialToken);
  const [state, setState] = useState<ScorerState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const teamA = state?.match?.team_a ?? "Team A";
  const teamB = state?.match?.team_b ?? "Team B";

  const stateUrl = useMemo(() => `/api/score/courts/${courtId}/state?token=${encodeURIComponent(token)}`, [courtId, token]);

  const refresh = useCallback(async () => {
    if (!token) {
      setError("Missing scorer token");
      return;
    }
    const res = await fetch(stateUrl, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? "Scorer link is not valid");
      return;
    }
    setState(json);
    setError(null);
  }, [stateUrl, token]);

  async function mutate(label: string, endpoint: string, extra: Record<string, unknown> = {}, method = "POST") {
    setBusy(label);
    setError(null);
    const res = await fetch(endpoint, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, actionId: crypto.randomUUID(), ...extra })
    });
    const json = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setError(json.error ?? "Scoring action failed");
      return;
    }
    await refresh();
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error && !state) {
    return (
      <main className="score-shell">
        <section className="score-card center">
          <h1>Scorer Link</h1>
          <p>{error}</p>
        </section>
        <ScoreStyles />
      </main>
    );
  }

  return (
    <main className="score-shell">
      <section className="score-top">
        <div>
          <h1>{state?.court.displayName ?? "Court"}</h1>
          <p>{state?.match?.round_name ?? "Manual Session"} {state?.match?.match_number ? `- ${state.match.match_number}` : ""}</p>
        </div>
        <span className={`pill ${state?.score.status?.toLowerCase().includes("final") ? "final" : ""}`}>{state?.score.status ?? "Loading"}</span>
      </section>

      <section className="scoreboard">
        <TeamBlock
          name={teamA}
          score={state?.score.team_a_score ?? 0}
          sets={state?.score.team_a_sets ?? 0}
          serving={state?.score.serving_team === "A"}
          onPoint={() => mutate("point-a", `/api/score/courts/${courtId}/point-a`)}
          busy={busy != null}
        />
        <TeamBlock
          name={teamB}
          score={state?.score.team_b_score ?? 0}
          sets={state?.score.team_b_sets ?? 0}
          serving={state?.score.serving_team === "B"}
          onPoint={() => mutate("point-b", `/api/score/courts/${courtId}/point-b`)}
          busy={busy != null}
        />
      </section>

      <section className="score-actions">
        <button onClick={() => mutate("undo", `/api/score/courts/${courtId}/undo`)} disabled={busy != null}><RotateCcw size={20} /> Undo</button>
        <button onClick={() => mutate("serve", `/api/score/courts/${courtId}`, { action: "toggle-serve" })} disabled={busy != null}><Flag size={20} /> Serve</button>
        <button onClick={() => setEditing(true)} disabled={!state || busy != null}><Pencil size={20} /> Edit</button>
        <button onClick={() => mutate("timeout-a", `/api/score/courts/${courtId}`, { action: "timeout-a" })} disabled={busy != null}><Timer size={20} /> A Timeout</button>
        <button onClick={() => mutate("timeout-b", `/api/score/courts/${courtId}`, { action: "timeout-b" })} disabled={busy != null}><Timer size={20} /> B Timeout</button>
        <button onClick={() => mutate("side-switch", `/api/score/courts/${courtId}`, { action: "side-switch" })} disabled={busy != null}><Minus size={20} /> Switch</button>
        <button onClick={() => mutate("set", `/api/score/courts/${courtId}/set-complete`)} disabled={busy != null}><CheckCircle size={20} /> Set Complete</button>
        <button className="danger" onClick={() => mutate("match", `/api/score/courts/${courtId}/match-complete`)} disabled={busy != null}><Trophy size={20} /> Match Complete</button>
      </section>

      {error && <div className="score-error">{error}</div>}
      {busy && <div className="score-busy">Saving</div>}
      {editing && state && (
        <EditModal
          state={state}
          onClose={() => setEditing(false)}
          onSave={async (payload) => {
            setEditing(false);
            await mutate("edit", `/api/score/courts/${courtId}`, payload, "PATCH");
          }}
        />
      )}
      <ScoreStyles />
    </main>
  );
}

function TeamBlock({ name, score, sets, serving, onPoint, busy }: { name: string; score: number; sets: number; serving: boolean; onPoint: () => void; busy: boolean }) {
  return (
    <button className="team-button" onClick={onPoint} disabled={busy}>
      <span className="team-name">{serving ? "● " : ""}{name}</span>
      <span className="team-score">{score}</span>
      <span className="team-sets">{sets} sets</span>
    </button>
  );
}

function EditModal({ state, onClose, onSave }: { state: ScorerState; onClose: () => void; onSave: (payload: Record<string, unknown>) => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await onSave(Object.fromEntries(form.entries()));
  }

  return (
    <div className="modal-backdrop">
      <form className="edit-modal" onSubmit={submit}>
        <h2>Edit Score</h2>
        <div className="edit-grid">
          <label>Team A Score<input name="teamAScore" type="number" min="0" defaultValue={state.score.team_a_score} /></label>
          <label>Team B Score<input name="teamBScore" type="number" min="0" defaultValue={state.score.team_b_score} /></label>
          <label>Team A Sets<input name="teamASets" type="number" min="0" defaultValue={state.score.team_a_sets} /></label>
          <label>Team B Sets<input name="teamBSets" type="number" min="0" defaultValue={state.score.team_b_sets} /></label>
          <label>Current Set<input name="currentSet" type="number" min="1" defaultValue={state.score.current_set} /></label>
          <label>Serving
            <select name="servingTeam" defaultValue={state.score.serving_team ?? "none"}>
              <option value="none">None</option>
              <option value="A">Team A</option>
              <option value="B">Team B</option>
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}

function ScoreStyles() {
  return (
    <style jsx global>{`
      body { background: #f3f5f7; color: #111827; }
      .score-shell {
        min-height: 100vh;
        padding: 14px;
      }
      .score-top {
        align-items: center;
        display: flex;
        gap: 12px;
        justify-content: space-between;
        margin: 0 auto 12px;
        max-width: 900px;
      }
      .score-top h1 { font-size: 24px; margin: 0; }
      .score-top p { color: #4b5563; margin: 3px 0 0; }
      .pill {
        background: #111827;
        border-radius: 999px;
        color: white;
        font-size: 12px;
        font-weight: 900;
        padding: 8px 10px;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .pill.final { background: #047857; }
      .scoreboard {
        display: grid;
        gap: 12px;
        margin: 0 auto;
        max-width: 900px;
      }
      .team-button {
        align-items: stretch;
        background: white;
        border: 2px solid #d1d5db;
        border-radius: 8px;
        color: #111827;
        display: grid;
        grid-template-columns: minmax(0, 1fr) 120px;
        min-height: 168px;
        padding: 0;
        text-align: left;
        width: 100%;
      }
      .team-name {
        align-items: center;
        display: flex;
        font-size: 30px;
        font-weight: 950;
        overflow: hidden;
        padding: 22px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .team-score {
        align-items: center;
        background: #f8d84a;
        border-left: 2px solid #d1d5db;
        display: flex;
        font-size: 72px;
        font-variant-numeric: tabular-nums;
        font-weight: 950;
        justify-content: center;
      }
      .team-sets {
        background: #111827;
        color: white;
        font-size: 18px;
        font-weight: 900;
        grid-column: 1 / -1;
        padding: 8px 18px;
        text-transform: uppercase;
      }
      .score-actions {
        display: grid;
        gap: 8px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin: 12px auto 0;
        max-width: 900px;
      }
      .score-actions button,
      .modal-actions button {
        align-items: center;
        background: #111827;
        border: 0;
        border-radius: 8px;
        color: white;
        display: inline-flex;
        font-weight: 900;
        gap: 8px;
        justify-content: center;
        min-height: 52px;
      }
      .score-actions .danger { background: #b91c1c; }
      .score-error,
      .score-busy {
        border-radius: 8px;
        font-weight: 800;
        margin: 12px auto 0;
        max-width: 900px;
        padding: 12px;
      }
      .score-error { background: #fee2e2; color: #991b1b; }
      .score-busy { background: #dbeafe; color: #1d4ed8; }
      .center { margin: 12vh auto; max-width: 420px; text-align: center; }
      .modal-backdrop {
        align-items: center;
        background: rgba(0,0,0,.5);
        display: flex;
        inset: 0;
        justify-content: center;
        padding: 16px;
        position: fixed;
      }
      .edit-modal {
        background: white;
        border-radius: 8px;
        max-width: 540px;
        padding: 18px;
        width: 100%;
      }
      .edit-grid {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .edit-modal input,
      .edit-modal select {
        background: #f9fafb;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        color: #111827;
        min-height: 44px;
        padding: 8px;
      }
      .modal-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 14px;
      }
      @media (max-width: 620px) {
        .team-button { grid-template-columns: minmax(0, 1fr) 96px; min-height: 142px; }
        .team-name { font-size: 24px; padding: 16px; }
        .team-score { font-size: 60px; }
        .score-actions { grid-template-columns: 1fr; }
        .edit-grid { grid-template-columns: 1fr; }
      }
    `}</style>
  );
}
