"use client";

import { AlertTriangle, CheckCircle2, ChevronRight, Lock, Minus, MonitorOff, MonitorPlay, Plus, RotateCcw, Send, StopCircle, Unlock } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IvsPreviewPlayer } from "@/components/IvsPreviewPlayer";

type SetScore = {
  setNumber: number;
  teamAScore: number;
  teamBScore: number;
  isComplete: boolean;
};

type ScoreState = {
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  currentSet: number;
  setScores: SetScore[];
  servingTeam?: "A" | "B" | null;
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
  handoff: {
    pending: boolean;
    officialScore: ScoreState;
    shadowScore: ScoreState;
    reason: string | null;
  };
  scoreCheck: {
    pending: boolean;
    message: string | null;
    backupDisplayName: string | null;
    backupScore: ScoreState | null;
  };
};

type CorrectionDraft = {
  teamAScore: number;
  teamBScore: number;
  currentSet: number;
  setScores: SetScore[];
  servingTeam?: "A" | "B" | null;
  status: string;
};

type TeamSide = "A" | "B";

const MAX_SETS = 3;

export function ScorerSessionClient({ sessionToken }: { sessionToken: string }) {
  const [state, setState] = useState<SessionState | null>(null);
  const [watchMode, setWatchMode] = useState<"website" | "courtside">("courtside");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState<CorrectionDraft>(() => draftFromScore());
  const [draftDirty, setDraftDirty] = useState(false);
  const [unlockedSets, setUnlockedSets] = useState<number[]>([]);
  const [pulseTeam, setPulseTeam] = useState<"A" | "B" | null>(null);
  const [handoffManualMode, setHandoffManualMode] = useState(false);
  const previousRole = useRef<SessionState["session"]["role"] | null>(null);
  const watchModeHydrated = useRef(false);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/scoring/sessions/${encodeURIComponent(sessionToken)}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(friendlyError(json.error ?? "Scorer session could not be loaded."));
      return;
    }
    if (previousRole.current === "backup" && json.session.role === "active") {
      setMessage(json.handoff?.pending
        ? "You are now the live scorekeeper. Choose which score to continue from."
        : "You are now the live scorekeeper. Your taps now update the broadcast scoreboard.");
    }
    previousRole.current = json.session.role;
    setState(json);
    if (!watchModeHydrated.current) {
      setWatchMode(json.session.watchMode ?? "courtside");
      watchModeHydrated.current = true;
    }
    setError(null);
  }, [sessionToken]);

  const heartbeat = useCallback(async (nextWatchMode = watchMode) => {
    await fetch(`/api/scoring/sessions/${encodeURIComponent(sessionToken)}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionStatus: document.visibilityState, watchMode: nextWatchMode })
    }).catch(() => undefined);
  }, [sessionToken, watchMode]);

  const sessionStatus = state?.session.status;
  const sessionLive = sessionStatus === "active" || sessionStatus === "promoted";

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!sessionLive) return;
    const refreshId = window.setInterval(refresh, 2500);
    return () => window.clearInterval(refreshId);
  }, [refresh, sessionLive]);

  useEffect(() => {
    if (!sessionLive) return;
    void heartbeat();
    const id = window.setInterval(() => void heartbeat(), 5000);
    return () => window.clearInterval(id);
  }, [heartbeat, sessionLive]);

  async function action(type: string, payload?: Record<string, unknown>): Promise<boolean> {
    if (busy) return false;
    const pressedTeam = type === "POINT_A" ? "A" : type === "POINT_B" ? "B" : null;
    if (type === "POINT_A" || type === "POINT_B" || type === "UNDO" || type === "SET_COMPLETE" || type.startsWith("HANDOFF_") || type === "SCORE_CHECK_KEEP_OFFICIAL" || type === "SCORE_CHECK_USE_BACKUP") {
      setDraftDirty(false);
      setUnlockedSets([]);
    }
    setBusy(type);
    setError(null);
    setMessage(null);
    if (pressedTeam) setPulseTeam(pressedTeam);
    try {
      const res = await fetch(`/api/scoring/sessions/${encodeURIComponent(sessionToken)}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: crypto.randomUUID(), type, payload })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(friendlyError(json.error ?? "Scoring action failed."));
        return false;
      }
      setMessage(json.message ?? (json.reason === "api_priority" ? "VolleyballLife is updating the broadcast score. Your tap was saved for review." : json.official === false ? "Score saved for review." : "Broadcast score updated."));
      await refresh();
      return true;
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : "Scoring action failed."));
      return false;
    } finally {
      setBusy(null);
      if (pressedTeam) {
        window.setTimeout(() => {
          setPulseTeam((current) => current === pressedTeam ? null : current);
        }, 180);
      }
    }
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
    setState((current) => current ? { ...current, session: { ...current.session, status: "released", leaseExpiresAt: null } } : current);
    setMessage("You are done scoring. Thank you for helping.");
    await refresh();
  }

  async function changeWatchMode(next: "website" | "courtside") {
    if (!sessionLive) return;
    setWatchMode(next);
    await heartbeat(next);
  }

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await action("MANUAL_CORRECTION", { score: correctionPayload(correctionDraft) });
    if (saved) {
      setDraftDirty(false);
      setUnlockedSets([]);
    }
  }

  async function adjustPoint(side: TeamSide, delta: 1 | -1) {
    if (disabled) return;
    if (delta === 1) {
      await action(side === "A" ? "POINT_A" : "POINT_B");
      return;
    }

    const liveDraft = draftFromScore(score);
    const currentValue = side === "A" ? liveDraft.teamAScore : liveDraft.teamBScore;
    if (currentValue <= 0) return;
    const nextDraft: CorrectionDraft = {
      ...liveDraft,
      teamAScore: side === "A" ? currentValue - 1 : liveDraft.teamAScore,
      teamBScore: side === "B" ? currentValue - 1 : liveDraft.teamBScore
    };
    setPulseTeam(side);
    const saved = await action("MANUAL_CORRECTION", { score: correctionPayload(nextDraft) });
    if (saved) {
      setCorrectionDraft(nextDraft);
      setDraftDirty(false);
      setUnlockedSets([]);
    }
    window.setTimeout(() => {
      setPulseTeam((current) => current === side ? null : current);
    }, 180);
  }

  const handoffPending = Boolean(state?.handoff?.pending);
  const scoreCheckPending = Boolean(state?.scoreCheck?.pending);
  const waiting = state?.session.role === "waiting";
  const score = state ? (state.session.role === "backup" || handoffPending ? state.shadowScore : state.officialScore) : undefined;
  const teamA = displayTeamName(state?.match?.team_a, "Team A");
  const teamB = displayTeamName(state?.match?.team_b, "Team B");
  const disabled = busy != null || !state || !sessionLive || waiting || handoffPending || scoreCheckPending;
  const correctionDisabled = busy != null || !state || !sessionLive || waiting || scoreCheckPending || (handoffPending && !handoffManualMode);
  const isBackup = state?.session.role === "backup";
  const isActive = state?.session.role === "active";
  const sessionEnded = Boolean(state && !sessionLive);
  const teamAScore = score?.teamAScore ?? 0;
  const teamBScore = score?.teamBScore ?? 0;
  const teamASets = score?.teamASets ?? 0;
  const teamBSets = score?.teamBSets ?? 0;
  const currentSet = score?.currentSet ?? 1;
  const scoreStatus = score?.status ?? "In Progress";
  const setScores = useMemo(() => normalizeSetScores(score?.setScores), [score?.setScores]);
  const setScoresSignature = setScores.map((set) => `${set.setNumber}:${set.teamAScore}:${set.teamBScore}:${set.isComplete ? 1 : 0}`).join("|");
  const canStartNextSet = sessionLive && scoreStatus.toLowerCase().includes("set complete") && currentSet < MAX_SETS && Math.max(teamASets, teamBSets) < 2;

  useEffect(() => {
    if (!draftDirty) {
      setCorrectionDraft(draftFromScore(score));
    }
  }, [currentSet, draftDirty, score, scoreStatus, setScoresSignature, teamAScore, teamBScore]);

  useEffect(() => {
    setUnlockedSets([]);
  }, [currentSet, setScoresSignature]);

  useEffect(() => {
    if (!handoffPending) setHandoffManualMode(false);
  }, [handoffPending]);

  function updateSetScore(setNumber: number, side: TeamSide, value: number) {
    setDraftDirty(true);
    setCorrectionDraft((draft) => {
      const nextValue = clampInt(value, 0, 99);
      if (setNumber === draft.currentSet) {
        return {
          ...draft,
          teamAScore: side === "A" ? nextValue : draft.teamAScore,
          teamBScore: side === "B" ? nextValue : draft.teamBScore
        };
      }
      const existing = draft.setScores.find((set) => set.setNumber === setNumber);
      const replacement: SetScore = {
        setNumber,
        teamAScore: side === "A" ? nextValue : existing?.teamAScore ?? 0,
        teamBScore: side === "B" ? nextValue : existing?.teamBScore ?? 0,
        isComplete: true
      };
      return {
        ...draft,
        setScores: sortSetScores([...draft.setScores.filter((set) => set.setNumber !== setNumber), replacement])
      };
    });
  }

  function toggleCompletedSet(setNumber: number) {
    setUnlockedSets((sets) => sets.includes(setNumber) ? sets.filter((item) => item !== setNumber) : [...sets, setNumber]);
  }

  function renderSetEditor(setNumber: number) {
    const isCurrent = setNumber === correctionDraft.currentSet;
    const completed = correctionDraft.setScores.find((set) => set.setNumber === setNumber && set.isComplete);
    const isCompleted = Boolean(completed) && !isCurrent;
    const isFuture = setNumber > correctionDraft.currentSet && !completed;
    const unlocked = unlockedSets.includes(setNumber);
    const editable = !correctionDisabled && (isCurrent || unlocked);
    const teamASetScore = isCurrent ? correctionDraft.teamAScore : completed?.teamAScore ?? 0;
    const teamBSetScore = isCurrent ? correctionDraft.teamBScore : completed?.teamBScore ?? 0;
    const stateLabel = isCurrent ? "Current set" : isCompleted ? unlocked ? "Editing completed set" : "Completed set locked" : "Not started";

    return (
      <section className={`set-editor-card ${isCurrent ? "active" : ""} ${isCompleted ? "complete" : ""} ${isFuture ? "future" : ""}`} key={setNumber}>
        <div className="set-editor-header">
          <div>
            <strong>Set {setNumber}</strong>
            <span>{stateLabel}</span>
          </div>
          {isCompleted && (
            <button className="set-lock-button" type="button" onClick={() => toggleCompletedSet(setNumber)} disabled={correctionDisabled}>
              {unlocked ? <Lock size={16} /> : <Unlock size={16} />}
              {unlocked ? "Lock" : "Modify"}
            </button>
          )}
        </div>
        <div className="set-team-editor">
          {renderSetStepper(teamA, setNumber, "A", teamASetScore, editable)}
          {renderSetStepper(teamB, setNumber, "B", teamBSetScore, editable)}
        </div>
      </section>
    );
  }

  function renderSetStepper(label: string, setNumber: number, side: TeamSide, value: number, editable: boolean) {
    const id = `set-${setNumber}-${side}`;
    return (
      <div className="score-field compact">
        <label htmlFor={id}>{label}</label>
        <div className="stepper">
          <button className="icon-button stepper-button" type="button" aria-label={`Decrease ${label} set ${setNumber}`} onClick={() => updateSetScore(setNumber, side, value - 1)} disabled={!editable || value <= 0}>
            <Minus size={18} />
          </button>
          <input
            id={id}
            type="number"
            min={0}
            max={99}
            value={value}
            onChange={(event) => updateSetScore(setNumber, side, Number(event.target.value))}
            disabled={!editable}
          />
          <button className="icon-button stepper-button" type="button" aria-label={`Increase ${label} set ${setNumber}`} onClick={() => updateSetScore(setNumber, side, value + 1)} disabled={!editable || value >= 99}>
            <Plus size={18} />
          </button>
        </div>
      </div>
    );
  }

  function renderTeamScoreControl(side: TeamSide, label: string, value: number, setsWon: number) {
    const sideLabel = side === "A" ? "Team A" : "Team B";
    const pointBusy = busy === `POINT_${side}`;
    const correctionBusy = busy === "MANUAL_CORRECTION" && pulseTeam === side;
    return (
      <article className={`score-team-card team-${side.toLowerCase()} ${pulseTeam === side ? "is-pressed" : ""}`}>
        <div className="team-card-copy">
          <span>{sideLabel}</span>
          <h3>{label}</h3>
          <small>{setsWon} {setsWon === 1 ? "set" : "sets"} won</small>
        </div>
        <output className="team-score-tile" aria-live="polite" aria-label={`${label} score`}>
          {value}
        </output>
        <div className="team-point-controls" aria-label={`${label} point controls`}>
          <button
            className="point-adjust-button minus"
            type="button"
            aria-label={`Remove one point from ${label}`}
            onClick={() => void adjustPoint(side, -1)}
            disabled={disabled || value <= 0}
          >
            <Minus size={34} strokeWidth={2.6} />
            <span>Point</span>
          </button>
          <button
            className="point-adjust-button plus"
            type="button"
            aria-label={`Add one point for ${label}`}
            onClick={() => void adjustPoint(side, 1)}
            disabled={disabled}
          >
            <Plus size={36} strokeWidth={2.8} />
            <span>{pointBusy || correctionBusy ? "Saving" : "Point"}</span>
          </button>
        </div>
      </article>
    );
  }

  function renderScoreSnapshot(label: string, snapshot: ScoreState) {
    return (
      <div className="score-snapshot">
        <span>{label}</span>
        <strong>{snapshot.teamAScore} - {snapshot.teamBScore}</strong>
        <small>Sets {snapshot.teamASets}-{snapshot.teamBSets} · Set {snapshot.currentSet}</small>
      </div>
    );
  }

  function enableHandoffCorrection() {
    if (!state) return;
    setHandoffManualMode(true);
    setDraftDirty(true);
    setCorrectionDraft(draftFromScore(state.handoff.shadowScore));
    setMessage("Adjust the set scores below, then apply the edited score to continue.");
  }

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
                <h1>{sessionEnded ? "Scoring session ended." : waiting ? "This court already has enough scorers." : handoffPending ? "You are now the live scorekeeper." : "You are helping keep score."}</h1>
                <p>
                  {sessionEnded
                    ? "This page is read-only now."
                    : waiting
                      ? "Keep this page open if you want to be available, but this session is view-only for now."
                      : handoffPending
                        ? "Choose which score to continue from before adding more points."
                        : isBackup
                          ? "Please keep scoring. Your updates are saved for the broadcast team."
                          : scoreCheckPending
                            ? "A score check is needed before more points can be added."
                            : "Your taps update the broadcast scoreboard."}
                </p>
              </div>
              <strong>{state.session.displayName}</strong>
            </section>

            <section className="scorer-match">
              <div>
                <span className="muted">{state.match?.round_name ?? state.event.name}</span>
                <h2>{teamA} vs {teamB}</h2>
              </div>
              <div className="set-pill">
                <span>Sets {teamASets}-{teamBSets}</span>
                <small>{scoreStatus}</small>
              </div>
            </section>

            <div className="watch-toggle scorer-toggle mode-toggle" role="group" aria-label="Scoring view">
              <button type="button" className={watchMode === "courtside" ? "primary" : ""} onClick={() => void changeWatchMode("courtside")} disabled={!sessionLive}>
                <span><MonitorOff size={18} /> Score only</span>
              </button>
              <button type="button" className={watchMode === "website" ? "primary" : ""} onClick={() => void changeWatchMode("website")} disabled={!sessionLive}>
                <span><MonitorPlay size={18} /> Watch stream + score</span>
              </button>
            </div>

            <IvsPreviewPlayer sessionToken={sessionToken} courtNumber={state.court.courtNumber} enabled={watchMode === "website"} />

            {handoffPending && (
              <section className="handoff-panel">
                <div>
                  <span className="muted">Promotion handoff</span>
                  <h3>Pick the score to continue with</h3>
                  <p>The broadcast still has one score, but your saved scorer page has another. Nothing else will update the broadcast until you choose.</p>
                </div>
                <div className="handoff-scores">
                  {renderScoreSnapshot("Broadcast score", state.handoff.officialScore)}
                  {renderScoreSnapshot("Your saved score", state.handoff.shadowScore)}
                </div>
                <div className="handoff-actions">
                  <button type="button" onClick={() => void action("HANDOFF_USE_OFFICIAL")} disabled={busy != null}>
                    Continue from broadcast
                  </button>
                  <button className="primary" type="button" onClick={() => void action("HANDOFF_USE_SHADOW")} disabled={busy != null}>
                    Use my score
                  </button>
                  <button className="warn" type="button" onClick={enableHandoffCorrection} disabled={busy != null}>
                    Correct manually
                  </button>
                </div>
              </section>
            )}

            {scoreCheckPending && isActive && !handoffPending && (
              <section className="handoff-panel score-check-panel">
                <div>
                  <span className="muted">Score check</span>
                  <h3>Please confirm the broadcast score</h3>
                  <p>{state.scoreCheck.message ?? "Another scorer has a different score. Confirm before adding more points."}</p>
                </div>
                <div className="handoff-scores">
                  {renderScoreSnapshot("Broadcast score", state.officialScore)}
                  {state.scoreCheck.backupScore && renderScoreSnapshot(`${state.scoreCheck.backupDisplayName ?? "Backup scorer"} score`, state.scoreCheck.backupScore)}
                </div>
                <div className="handoff-actions">
                  <button className="primary" type="button" onClick={() => void action("SCORE_CHECK_KEEP_OFFICIAL")} disabled={busy != null}>
                    Broadcast score is correct
                  </button>
                  {state.scoreCheck.backupScore && (
                    <button className="warn" type="button" onClick={() => void action("SCORE_CHECK_USE_BACKUP")} disabled={busy != null}>
                      Use backup score
                    </button>
                  )}
                  <button className="danger" type="button" onClick={() => void release()} disabled={busy != null}>
                    Stop scoring
                  </button>
                </div>
              </section>
            )}

            <div className="scorer-instruction" aria-live="polite">
              <span>{handoffPending ? "Choose a score above before continuing." : scoreCheckPending ? "Confirm the score check before continuing." : waiting ? "This view-only session is waiting for an open scorer slot." : "Use + for the team that won the rally. Use - to correct one point."}</span>
              {busy && <strong>{busy === "POINT_A" || busy === "POINT_B" ? "Saving point..." : busy === "MANUAL_CORRECTION" ? "Saving correction..." : "Saving..."}</strong>}
            </div>

            <section className="score-control-grid" aria-label="Current set scoring controls">
              {renderTeamScoreControl("A", teamA, teamAScore, teamASets)}
              {renderTeamScoreControl("B", teamB, teamBScore, teamBSets)}
            </section>

            <section className="session-actions">
              <button type="button" onClick={() => void action("UNDO")} disabled={disabled}>
                <RotateCcw size={18} /> Undo point
              </button>
              {canStartNextSet && (
                <button className="warn" type="button" onClick={() => void action("SET_COMPLETE")} disabled={disabled}>
                  <ChevronRight size={18} /> Start set {currentSet + 1}
                </button>
              )}
              <button className="danger" type="button" onClick={() => void release()} disabled={disabled}>
                <StopCircle size={18} /> Stop scoring
              </button>
            </section>

            <section className="correction-panel score-editor" aria-label="Edit scoreboard">
              <div className="editor-header">
                <div>
                  <span className="muted">Correction tools</span>
                  <h3>Set scores</h3>
                </div>
                <span className={`edit-state ${draftDirty ? "dirty" : ""}`}>{draftDirty ? "Edits pending" : "Live score synced"}</span>
              </div>
              <form className="set-editor-form" onSubmit={submitCorrection}>
                <div className="set-editor-list">
                  {[1, 2, 3].map((setNumber) => renderSetEditor(setNumber))}
                </div>
                <button className="primary" type="submit" disabled={correctionDisabled || !draftDirty}><Send size={18} /> Apply edited score</button>
              </form>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function draftFromScore(score?: ScoreState): CorrectionDraft {
  return {
    teamAScore: score?.teamAScore ?? 0,
    teamBScore: score?.teamBScore ?? 0,
    currentSet: clampInt(score?.currentSet ?? 1, 1, MAX_SETS),
    setScores: normalizeSetScores(score?.setScores),
    servingTeam: score?.servingTeam ?? null,
    status: score?.status ?? "In Progress"
  };
}

function displayTeamName(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized || /^team on (left|right)$/i.test(normalized)) return fallback;
  return normalized;
}

function correctionPayload(draft: CorrectionDraft): ScoreState {
  const setScores = normalizeSetScores(draft.setScores).filter((set) => set.isComplete);
  const teamASets = setScores.filter((set) => set.teamAScore > set.teamBScore).length;
  const teamBSets = setScores.filter((set) => set.teamBScore > set.teamAScore).length;
  const status = teamASets >= 2 || teamBSets >= 2
    ? "Final"
    : currentSetIsComplete(draft.currentSet, draft.teamAScore, draft.teamBScore)
      ? "Set Complete"
      : "In Progress";
  return {
    teamAScore: draft.teamAScore,
    teamBScore: draft.teamBScore,
    teamASets,
    teamBSets,
    currentSet: draft.currentSet,
    setScores,
    servingTeam: draft.servingTeam ?? null,
    status
  };
}

function currentSetIsComplete(setNumber: number, teamAScore: number, teamBScore: number): boolean {
  const target = setNumber >= 3 ? 15 : 21;
  const high = Math.max(teamAScore, teamBScore);
  const low = Math.min(teamAScore, teamBScore);
  return high >= target && high - low >= 2;
}

function normalizeSetScores(input?: SetScore[]): SetScore[] {
  if (!Array.isArray(input)) return [];
  return sortSetScores(input.map((set) => ({
    setNumber: clampInt(set.setNumber, 1, MAX_SETS),
    teamAScore: clampInt(set.teamAScore, 0, 99),
    teamBScore: clampInt(set.teamBScore, 0, 99),
    isComplete: set.isComplete !== false
  })));
}

function sortSetScores(setScores: SetScore[]): SetScore[] {
  return setScores
    .filter((set, index, list) => list.findIndex((item) => item.setNumber === set.setNumber) === index)
    .sort((a, b) => a.setNumber - b.setNumber);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function friendlyError(message: string | null): string {
  if (!message) return "Scoring is not ready yet. Please try again in a moment.";
  if (/api key|supabase|service role|jwt|database/i.test(message)) {
    return "Scoring is not ready yet. Please try again in a moment.";
  }
  return message;
}
