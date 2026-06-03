"use client";

import { Pencil, RotateCcw, Save } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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

type DraftScore = {
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  currentSet: number;
  servingTeam: "A" | "B" | "none";
};

export function ScorerClient({ courtId, initialToken }: { courtId: string; initialToken: string }) {
  const [token] = useState(initialToken);
  const [state, setState] = useState<ScorerState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftScore | null>(null);
  const [dirty, setDirty] = useState(false);
  const [draftHistory, setDraftHistory] = useState<DraftScore[]>([]);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [tapFeedback, setTapFeedback] = useState<{ team: "A" | "B"; id: number } | null>(null);
  const tapFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setDraft(draftFromState(json));
    setDraftHistory([]);
    setDirty(false);
    setError(null);
  }, [stateUrl, token]);

  async function mutate(label: string, endpoint: string, extra: Record<string, unknown> = {}, method = "POST") {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, actionId: crypto.randomUUID(), ...extra })
      });
      const json = await res.json().catch(() => ({}));
      setBusy(null);
      if (!res.ok) {
        setError(json.error ?? "Scoring action failed");
        return false;
      }
      await refresh();
      return true;
    } catch {
      setBusy(null);
      setError("Could not save. Keep the scorer page open and try Save Score again.");
      return false;
    }
  }

  function triggerTapFeedback(team: "A" | "B") {
    if (tapFeedbackTimer.current) {
      clearTimeout(tapFeedbackTimer.current);
    }
    setTapFeedback((previous) => ({ team, id: (previous?.id ?? 0) + 1 }));
    tapFeedbackTimer.current = setTimeout(() => setTapFeedback(null), 180);
  }

  function scorePoint(team: "A" | "B") {
    if (!draft || busy === "save") {
      return;
    }
    triggerTapFeedback(team);
    setDraftHistory((history) => [...history.slice(-19), draft]);
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        teamAScore: team === "A" ? current.teamAScore + 1 : current.teamAScore,
        teamBScore: team === "B" ? current.teamBScore + 1 : current.teamBScore
      };
    });
    setDirty(true);
    setError(null);
  }

  async function undoScore() {
    if (dirty && draftHistory.length) {
      const previous = draftHistory[draftHistory.length - 1];
      setDraft(previous);
      setDraftHistory((history) => history.slice(0, -1));
      setDirty(draftHistory.length > 1);
      setError(null);
      return;
    }
    await mutate("undo", `/api/score/courts/${courtId}/undo`);
  }

  async function saveScore() {
    if (!draft || !dirty) {
      return;
    }
    const ok = await mutate("save", `/api/score/courts/${courtId}`, draft, "PATCH");
    if (ok) {
      setSavedAt(new Date());
    }
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (tapFeedbackTimer.current) {
        clearTimeout(tapFeedbackTimer.current);
      }
    };
  }, []);

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
          score={draft?.teamAScore ?? state?.score.team_a_score ?? 0}
          sets={draft?.teamASets ?? state?.score.team_a_sets ?? 0}
          serving={state?.score.serving_team === "A"}
          onPoint={() => scorePoint("A")}
          disabled={!draft || busy === "save"}
          feedbackId={tapFeedback?.team === "A" ? tapFeedback.id : 0}
        />
        <TeamBlock
          name={teamB}
          score={draft?.teamBScore ?? state?.score.team_b_score ?? 0}
          sets={draft?.teamBSets ?? state?.score.team_b_sets ?? 0}
          serving={state?.score.serving_team === "B"}
          onPoint={() => scorePoint("B")}
          disabled={!draft || busy === "save"}
          feedbackId={tapFeedback?.team === "B" ? tapFeedback.id : 0}
        />
      </section>

      <section className={`save-status ${dirty ? "unsaved" : "saved"}`}>
        <strong>{dirty ? "Unsaved score changes" : "Score saved"}</strong>
        <span>{dirty ? "Tap Save Score when the score is correct." : savedAt ? `Last saved ${savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Ready for scoring."}</span>
      </section>

      <section className="score-actions">
        <button className="save" onClick={saveScore} disabled={!dirty || busy != null}><Save size={22} /> Save Score</button>
        <button className="undo" onClick={undoScore} disabled={busy != null || (!dirty && !state)}><RotateCcw size={20} /> Undo</button>
        <button onClick={() => setEditing(true)} disabled={!state || busy != null}><Pencil size={20} /> Edit</button>
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
            setSavedAt(new Date());
          }}
          draft={draft}
        />
      )}
      <ScoreStyles />
    </main>
  );
}

function draftFromState(state: ScorerState): DraftScore {
  return {
    teamAScore: state.score.team_a_score,
    teamBScore: state.score.team_b_score,
    teamASets: state.score.team_a_sets,
    teamBSets: state.score.team_b_sets,
    currentSet: state.score.current_set,
    servingTeam: state.score.serving_team ?? "none"
  };
}

function TeamBlock({ name, score, sets, serving, onPoint, disabled, feedbackId }: { name: string; score: number; sets: number; serving: boolean; onPoint: () => void; disabled: boolean; feedbackId: number }) {
  const hasFeedback = feedbackId > 0;
  return (
    <button className={`team-button ${hasFeedback ? "tap-active" : ""}`} onClick={onPoint} disabled={disabled}>
      {hasFeedback && <span key={feedbackId} className="tap-flash" aria-hidden="true" />}
      <span className="team-name">{serving ? "● " : ""}{name}</span>
      <span className="team-score">{score}</span>
      <span className="team-sets">{sets} sets</span>
    </button>
  );
}

function EditModal({ state, onClose, onSave, draft }: { state: ScorerState; onClose: () => void; onSave: (payload: Record<string, unknown>) => Promise<void>; draft: DraftScore | null }) {
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
          <label>Team A Score<input name="teamAScore" type="number" min="0" defaultValue={draft?.teamAScore ?? state.score.team_a_score} /></label>
          <label>Team B Score<input name="teamBScore" type="number" min="0" defaultValue={draft?.teamBScore ?? state.score.team_b_score} /></label>
          <label>Team A Sets<input name="teamASets" type="number" min="0" defaultValue={draft?.teamASets ?? state.score.team_a_sets} /></label>
          <label>Team B Sets<input name="teamBSets" type="number" min="0" defaultValue={draft?.teamBSets ?? state.score.team_b_sets} /></label>
          <label>Current Set<input name="currentSet" type="number" min="1" defaultValue={draft?.currentSet ?? state.score.current_set} /></label>
          <label>Serving
            <select name="servingTeam" defaultValue={draft?.servingTeam ?? state.score.serving_team ?? "none"}>
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
        overflow: hidden;
        padding: 0;
        position: relative;
        touch-action: manipulation;
        transition: border-color 80ms linear, box-shadow 80ms linear, filter 80ms linear;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
        text-align: left;
        width: 100%;
      }
      .team-button:active,
      .team-button.tap-active {
        border-color: #f8d84a;
        box-shadow: 0 0 0 4px rgba(248, 216, 74, .3);
        filter: brightness(.98);
      }
      .team-button:disabled {
        opacity: .68;
      }
      .tap-flash {
        animation: tap-flash 180ms linear;
        background: rgba(248, 216, 74, .24);
        inset: 0;
        opacity: 0;
        pointer-events: none;
        position: absolute;
        z-index: 0;
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
        z-index: 1;
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
        z-index: 1;
      }
      .team-sets {
        background: #111827;
        color: white;
        font-size: 18px;
        font-weight: 900;
        grid-column: 1 / -1;
        padding: 8px 18px;
        text-transform: uppercase;
        z-index: 1;
      }
      .save-status {
        align-items: center;
        border: 2px solid;
        border-radius: 8px;
        display: flex;
        gap: 8px 14px;
        justify-content: space-between;
        margin: 12px auto 0;
        max-width: 900px;
        padding: 11px 13px;
      }
      .save-status strong {
        font-size: 15px;
        font-weight: 950;
        text-transform: uppercase;
      }
      .save-status span {
        font-size: 14px;
        font-weight: 750;
      }
      .save-status.unsaved {
        background: #fff7ed;
        border-color: #fb923c;
        color: #7c2d12;
      }
      .save-status.saved {
        background: #ecfdf5;
        border-color: #34d399;
        color: #065f46;
      }
      .score-actions {
        display: grid;
        gap: 8px;
        grid-template-columns: 1fr;
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
        min-height: 56px;
      }
      .score-actions .save {
        background: #047857;
        font-size: 18px;
        min-height: 64px;
      }
      .score-actions .save:disabled {
        background: #9ca3af;
        color: #f9fafb;
      }
      .score-actions .undo { background: #ea580c; }
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
        overflow-y: auto;
        padding: 16px;
        position: fixed;
        z-index: 1000;
      }
      .edit-modal {
        background: white;
        border-radius: 8px;
        max-width: 540px;
        padding: 18px;
        position: relative;
        width: 100%;
        z-index: 1001;
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
        .save-status {
          align-items: flex-start;
          flex-direction: column;
        }
        .edit-grid { grid-template-columns: 1fr; }
        .modal-backdrop {
          align-items: flex-start;
        }
      }
      @keyframes tap-flash {
        0% { opacity: 1; }
        100% { opacity: 0; }
      }
    `}</style>
  );
}
