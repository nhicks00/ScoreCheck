"use client";

import { ArrowLeft, ArrowRight, Pencil, RotateCcw, Save } from "lucide-react";
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
    format?: Record<string, unknown> | null;
  } | null;
  score: {
    team_a_score: number;
    team_b_score: number;
    team_a_sets: number;
    team_b_sets: number;
    current_set: number;
    set_scores: ManualSetScore[];
    serving_team: "A" | "B" | null;
    status: string;
  };
};

type ManualSetScore = {
  setNumber: number;
  teamAScore: number;
  teamBScore: number;
  isComplete: boolean;
};

type DraftScore = {
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  currentSet: number;
  setScores: ManualSetScore[];
  servingTeam: "A" | "B" | "none";
  status: string;
};

type ManualFormat = {
  bestOf: number;
  setsToWin: number;
};

export function ScorerClient({ courtId, initialToken }: { courtId: string; initialToken: string }) {
  const [token] = useState(initialToken);
  const [state, setState] = useState<ScorerState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftScore | null>(null);
  const [dirty, setDirty] = useState(false);
  const [dirtyVersion, setDirtyVersion] = useState(0);
  const [draftHistory, setDraftHistory] = useState<DraftScore[]>([]);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "retrying">("idle");
  const [retryCount, setRetryCount] = useState(0);
  const [tapFeedback, setTapFeedback] = useState<{ team: "A" | "B"; id: number } | null>(null);
  const tapFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef<DraftScore | null>(null);
  const dirtyRef = useRef(false);
  const dirtyVersionRef = useRef(0);
  const undoStackRef = useRef<DraftScore[]>([]);
  const retryCountRef = useRef(0);
  const saveInFlightRef = useRef(false);
  const saveScoreRef = useRef<(manual?: boolean) => Promise<void>>(async () => {});
  const teamA = state?.match?.team_a ?? "Team A";
  const teamB = state?.match?.team_b ?? "Team B";
  const format = useMemo(() => formatFromMatch(state?.match ?? null), [state?.match]);

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
    const savedDraft = draftFromState(json);
    setState(json);
    setDraft(savedDraft);
    draftRef.current = savedDraft;
    undoStackRef.current = [];
    setDraftHistory([]);
    setDirty(false);
    dirtyRef.current = false;
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

  function markUnsaved() {
    dirtyRef.current = true;
    dirtyVersionRef.current += 1;
    setDirty(true);
    setDirtyVersion(dirtyVersionRef.current);
  }

  function scorePoint(team: "A" | "B") {
    const current = draftRef.current;
    if (!current) {
      return;
    }
    triggerTapFeedback(team);
    const next = {
      ...current,
      teamAScore: team === "A" ? current.teamAScore + 1 : current.teamAScore,
      teamBScore: team === "B" ? current.teamBScore + 1 : current.teamBScore
    };
    undoStackRef.current = [...undoStackRef.current.slice(-49), current];
    setDraftHistory(undoStackRef.current);
    draftRef.current = next;
    setDraft(next);
    markUnsaved();
    setError(null);
  }

  function changeSet(direction: "next" | "previous") {
    const current = draftRef.current;
    if (!current) {
      return;
    }
    const next = direction === "next" ? advanceSet(current, format) : retreatSet(current, format);
    if (!next) {
      setError(direction === "next" ? "Enter a non-tied set score before moving to the next set." : "Already on the first set.");
      return;
    }
    undoStackRef.current = [...undoStackRef.current.slice(-49), current];
    setDraftHistory(undoStackRef.current);
    draftRef.current = next;
    setDraft(next);
    markUnsaved();
    setError(null);
  }

  async function undoScore() {
    if (undoStackRef.current.length) {
      const nextStack = undoStackRef.current.slice(0, -1);
      const previous = undoStackRef.current[undoStackRef.current.length - 1];
      undoStackRef.current = nextStack;
      setDraftHistory(nextStack);
      draftRef.current = previous;
      setDraft(previous);
      markUnsaved();
      setError(null);
      return;
    }
    await mutate("undo", `/api/score/courts/${courtId}/undo`);
  }

  async function saveScore(manual = true) {
    if (!draftRef.current || !dirtyRef.current) {
      return;
    }
    await saveDraft(draftRef.current, dirtyVersionRef.current, manual);
  }
  saveScoreRef.current = saveScore;

  async function saveDraft(scoreToSave: DraftScore, versionToSave: number, manual: boolean) {
    if (saveInFlightRef.current) {
      return;
    }
    saveInFlightRef.current = true;
    setSaveStatus(retryCountRef.current > 0 && !manual ? "retrying" : "saving");
    if (manual) {
      setError(null);
    }

    try {
      const res = await fetch(`/api/score/courts/${courtId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, actionId: crypto.randomUUID(), ...scoreToSave })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !savedResponseMatchesDraft(json.score, scoreToSave)) {
        throw new Error(json.error ?? "Score save did not finish");
      }

      saveInFlightRef.current = false;
      setSaveStatus("idle");
      retryCountRef.current = 0;
      setRetryCount(0);
      setSavedAt(new Date());
      if (dirtyVersionRef.current === versionToSave) {
        setState((current) => stateWithSavedScore(current, json.score));
        setDraft(scoreToSave);
        draftRef.current = scoreToSave;
        setDirty(false);
        dirtyRef.current = false;
      } else {
        scheduleAutoSave(120);
      }
    } catch {
      saveInFlightRef.current = false;
      setSaveStatus("retrying");
      retryCountRef.current += 1;
      setRetryCount(retryCountRef.current);
      setError("Score has not reached the overlay yet. Retrying automatically; tap Save Score to retry now.");
      scheduleAutoSave(retryDelay(retryCountRef.current));
    }
  }

  const scheduleAutoSave = useCallback((delayMs = 650) => {
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
    }
    autoSaveTimer.current = setTimeout(() => {
      if (draftRef.current && dirtyRef.current) {
        void saveScoreRef.current(false);
      }
    }, delayMs);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    dirtyVersionRef.current = dirtyVersion;
    if (dirty && draft) {
      scheduleAutoSave(650);
    }
  }, [dirty, dirtyVersion, draft, scheduleAutoSave]);

  useEffect(() => {
    return () => {
      if (tapFeedbackTimer.current) {
        clearTimeout(tapFeedbackTimer.current);
      }
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
      }
    };
  }, []);

  if (error && !state) {
    return (
      <main className="scorer-screen">
        <section className="panel ms-center">
          <h1>Scorer Link</h1>
          <p className="muted">{error}</p>
        </section>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="scorer-screen">
        <div className="scorer-wrap" aria-label="Loading scorer">
          <span className="skeleton skeleton-chip" />
          <span className="skeleton skeleton-block" />
          <span className="skeleton skeleton-block" />
          <span className="skeleton skeleton-cta" />
        </div>
      </main>
    );
  }

  const isFinal = Boolean(state?.score.status?.toLowerCase().includes("final"));

  return (
    <main className="scorer-screen">
      <div className="scorer-wrap">
        <section className="ms-top">
          <div>
            <h1>{state?.court.displayName ?? "Court"}</h1>
            <p>{state?.match?.round_name ?? "Manual Session"} {state?.match?.match_number ? `- ${state.match.match_number}` : ""}</p>
          </div>
          <span className={`status ${isFinal ? "info" : "live"}`}>{state?.score.status ?? "Loading"}</span>
        </section>

        <section className="ms-scoreboard">
          <TeamBlock
            side="a"
            name={teamA}
            score={draft?.teamAScore ?? state?.score.team_a_score ?? 0}
            sets={draft?.teamASets ?? state?.score.team_a_sets ?? 0}
            serving={state?.score.serving_team === "A"}
            onPoint={() => scorePoint("A")}
            disabled={!draft || busy === "save"}
            feedbackId={tapFeedback?.team === "A" ? tapFeedback.id : 0}
          />
          <TeamBlock
            side="b"
            name={teamB}
            score={draft?.teamBScore ?? state?.score.team_b_score ?? 0}
            sets={draft?.teamBSets ?? state?.score.team_b_sets ?? 0}
            serving={state?.score.serving_team === "B"}
            onPoint={() => scorePoint("B")}
            disabled={!draft || busy === "save"}
            feedbackId={tapFeedback?.team === "B" ? tapFeedback.id : 0}
          />
        </section>

        <section className={`ms-save-status ${dirty ? "unsaved" : "saved"}`} aria-live="polite">
          <strong>{dirty ? "Unsaved score changes" : "Score saved"}</strong>
          <span>{saveStatus === "saving" ? "Saving to overlay..." : saveStatus === "retrying" ? `Retrying save${retryCount ? ` (${retryCount})` : ""}...` : dirty ? "Auto-saving. Tap Save Score to retry now." : savedAt ? `Last saved ${savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Ready for scoring."}</span>
        </section>

        <section className="ms-actions">
          <button className="primary ms-save" onClick={() => saveScore(true)} disabled={!dirty || busy != null}><Save size={22} /> Save Score</button>
          <button onClick={() => changeSet("previous")} disabled={!draft || busy != null || (draft.currentSet <= 1 && !draft.setScores.length)}><ArrowLeft size={20} /> Previous Set</button>
          <button onClick={() => changeSet("next")} disabled={!draft || busy != null || draft.status.toLowerCase().includes("final")}><ArrowRight size={20} /> Next Set</button>
          <button className="warn" onClick={undoScore} disabled={busy != null || (!dirty && !state)}><RotateCcw size={20} /> Undo</button>
          <button onClick={() => setEditing(true)} disabled={!state || busy != null}><Pencil size={20} /> Edit</button>
        </section>

        {error && <div className="scorer-alert danger" role="alert">{error}</div>}
        {busy && <div className="scorer-alert">Saving</div>}
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
      </div>
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
    setScores: Array.isArray(state.score.set_scores) ? state.score.set_scores : [],
    servingTeam: state.score.serving_team ?? "none",
    status: state.score.status
  };
}

function formatFromMatch(match: ScorerState["match"]): ManualFormat {
  const raw = match?.format ?? {};
  const bestOf = numberValue(raw.bestOf) ?? 3;
  return {
    bestOf,
    setsToWin: numberValue(raw.setsToWin) ?? Math.ceil(bestOf / 2)
  };
}

function advanceSet(current: DraftScore, format: ManualFormat) {
  if (current.teamAScore === current.teamBScore) {
    return null;
  }
  const completedCurrent = {
    setNumber: current.currentSet,
    teamAScore: current.teamAScore,
    teamBScore: current.teamBScore,
    isComplete: true
  };
  const setScores = [
    ...current.setScores.filter((set) => set.setNumber !== current.currentSet),
    completedCurrent
  ].sort((a, b) => a.setNumber - b.setNumber);
  const teamASets = setScores.filter((set) => set.isComplete && set.teamAScore > set.teamBScore).length;
  const teamBSets = setScores.filter((set) => set.isComplete && set.teamBScore > set.teamAScore).length;
  const isFinal = teamASets >= format.setsToWin || teamBSets >= format.setsToWin || current.currentSet >= format.bestOf;
  return {
    ...current,
    teamAScore: isFinal ? current.teamAScore : 0,
    teamBScore: isFinal ? current.teamBScore : 0,
    teamASets,
    teamBSets,
    currentSet: isFinal ? current.currentSet : current.currentSet + 1,
    setScores,
    status: isFinal ? "Final" : "In Progress"
  };
}

function retreatSet(current: DraftScore, format: ManualFormat) {
  const currentSetIsComplete = current.setScores.some((set) => set.setNumber === current.currentSet && set.isComplete);
  const targetSetNumber = currentSetIsComplete ? current.currentSet : current.currentSet - 1;
  if (targetSetNumber < 1) {
    return null;
  }
  const previousSet = current.setScores.find((set) => set.setNumber === targetSetNumber);
  const setScores = current.setScores
    .filter((set) => set.setNumber < targetSetNumber)
    .sort((a, b) => a.setNumber - b.setNumber);
  const teamASets = setScores.filter((set) => set.isComplete && set.teamAScore > set.teamBScore).length;
  const teamBSets = setScores.filter((set) => set.isComplete && set.teamBScore > set.teamAScore).length;
  return {
    ...current,
    teamAScore: previousSet?.teamAScore ?? 0,
    teamBScore: previousSet?.teamBScore ?? 0,
    teamASets,
    teamBSets,
    currentSet: Math.min(targetSetNumber, format.bestOf),
    setScores,
    status: "In Progress"
  };
}

function savedResponseMatchesDraft(score: unknown, draft: DraftScore) {
  if (!score || typeof score !== "object") {
    return false;
  }
  const row = score as Record<string, unknown>;
  return (
    Number(row.team_a_score) === draft.teamAScore &&
    Number(row.team_b_score) === draft.teamBScore &&
    Number(row.team_a_sets) === draft.teamASets &&
    Number(row.team_b_sets) === draft.teamBSets &&
    Number(row.current_set) === draft.currentSet &&
    (typeof row.status !== "string" || row.status === draft.status) &&
    ((row.serving_team === null || row.serving_team === undefined ? "none" : row.serving_team) === draft.servingTeam)
  );
}

function stateWithSavedScore(state: ScorerState | null, score: unknown) {
  if (!state || !score || typeof score !== "object") {
    return state;
  }
  const row = score as Record<string, unknown>;
  const servingTeam: "A" | "B" | null = row.serving_team === "A" || row.serving_team === "B" ? row.serving_team : null;
  return {
    ...state,
    score: {
      ...state.score,
      team_a_score: Number(row.team_a_score),
      team_b_score: Number(row.team_b_score),
      team_a_sets: Number(row.team_a_sets),
      team_b_sets: Number(row.team_b_sets),
      current_set: Number(row.current_set),
      set_scores: Array.isArray(row.set_scores) ? row.set_scores as ManualSetScore[] : state.score.set_scores,
      serving_team: servingTeam,
      status: typeof row.status === "string" ? row.status : state.score.status
    }
  };
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function retryDelay(retryCount: number) {
  return Math.min(1000 * 2 ** Math.max(0, retryCount - 1), 8000);
}

function TeamBlock({ side, name, score, sets, serving, onPoint, disabled, feedbackId }: { side: "a" | "b"; name: string; score: number; sets: number; serving: boolean; onPoint: () => void; disabled: boolean; feedbackId: number }) {
  const hasFeedback = feedbackId > 0;
  return (
    <button className={`ms-team-button ms-team-${side} ${hasFeedback ? "tap-active" : ""}`} onClick={onPoint} disabled={disabled}>
      {hasFeedback && <span key={feedbackId} className="ms-tap-flash" aria-hidden="true" />}
      <span className="ms-team-name">{serving ? "● " : ""}{name}</span>
      <span className="ms-team-score">{score}</span>
      <span className="ms-team-sets">{sets} sets · Tap to add a point</span>
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
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Edit score">
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
