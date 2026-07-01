export type TeamSide = "A" | "B";

export type MatchFormat = {
  bestOf: number;
  setsToWin: number;
  pointsPerSet: number[];
  winByTwo: boolean;
  cap: number | null;
};

export type SetScore = {
  setNumber: number;
  teamAScore: number;
  teamBScore: number;
  isComplete: boolean;
};

export type ScoreState = {
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  currentSet: number;
  setScores: SetScore[];
  servingTeam: TeamSide | null;
  status: "Prematch" | "In Progress" | "Set Complete" | "Final";
};

export function defaultBeachFormat(): MatchFormat {
  return {
    bestOf: 3,
    setsToWin: 2,
    pointsPerSet: [21, 21, 15],
    winByTwo: true,
    cap: null
  };
}

export function emptyScoreState(): ScoreState {
  return {
    teamAScore: 0,
    teamBScore: 0,
    teamASets: 0,
    teamBSets: 0,
    currentSet: 1,
    setScores: [],
    servingTeam: null,
    status: "Prematch"
  };
}

export function scorePoint(state: ScoreState, team: TeamSide, format = defaultBeachFormat()): ScoreState {
  if (state.status === "Final") return clone(state);
  const next = normalizeScoreState(state, format);
  if (team === "A") next.teamAScore += 1;
  if (team === "B") next.teamBScore += 1;
  next.status = canCompleteSet(next, format) ? "Set Complete" : "In Progress";
  return next;
}

export function canCompleteSet(state: ScoreState, format = defaultBeachFormat()): boolean {
  const target = setTarget(state.currentSet, format);
  const high = Math.max(state.teamAScore, state.teamBScore);
  const low = Math.min(state.teamAScore, state.teamBScore);
  if (high === low) return false;
  if (format.cap && high >= format.cap) return true;
  if (high < target) return false;
  return !format.winByTwo || high - low >= 2;
}

export function completeSet(state: ScoreState, format = defaultBeachFormat()): ScoreState {
  const current = normalizeScoreState(state, format);
  if (!canCompleteSet(current, format)) {
    throw new Error("Set cannot be completed from the current score");
  }
  const winner = current.teamAScore > current.teamBScore ? "A" : "B";
  const setScores = current.setScores.filter((set) => set.setNumber !== current.currentSet);
  setScores.push({
    setNumber: current.currentSet,
    teamAScore: current.teamAScore,
    teamBScore: current.teamBScore,
    isComplete: true
  });
  setScores.sort((a, b) => a.setNumber - b.setNumber);

  const teamASets = current.teamASets + (winner === "A" ? 1 : 0);
  const teamBSets = current.teamBSets + (winner === "B" ? 1 : 0);
  if (teamASets >= format.setsToWin || teamBSets >= format.setsToWin) {
    return {
      ...current,
      teamASets,
      teamBSets,
      setScores,
      status: "Final"
    };
  }

  return {
    ...current,
    teamAScore: 0,
    teamBScore: 0,
    teamASets,
    teamBSets,
    currentSet: Math.min(current.currentSet + 1, format.bestOf),
    setScores,
    servingTeam: null,
    status: "In Progress"
  };
}

export function canCompleteMatch(state: ScoreState, format = defaultBeachFormat()): boolean {
  return state.teamASets >= format.setsToWin || state.teamBSets >= format.setsToWin;
}

export function completeMatch(state: ScoreState, format = defaultBeachFormat()): ScoreState {
  const next = normalizeScoreState(state, format);
  if (!canCompleteMatch(next, format) && canCompleteSet(next, format)) {
    return completeSet(next, format);
  }
  if (!canCompleteMatch(next, format)) {
    throw new Error("Match format has not been satisfied");
  }
  return { ...next, status: "Final" };
}

export function undoPoint(previousEventLog: Array<{ previousState?: unknown; nextState?: unknown }>): ScoreState {
  const previous = previousEventLog.find((event) => isScoreStateLike(event.previousState))?.previousState;
  if (!previous) return emptyScoreState();
  return normalizeScoreState(previous as Partial<ScoreState>);
}

export function validateManualCorrection(input: Partial<ScoreState>, format = defaultBeachFormat()): ScoreState {
  const next = normalizeScoreState(input, format);
  if (next.teamAScore < 0 || next.teamBScore < 0) throw new Error("Scores cannot be negative");
  if (next.teamASets < 0 || next.teamBSets < 0) throw new Error("Set counts cannot be negative");
  if (next.teamASets > format.setsToWin || next.teamBSets > format.setsToWin) {
    throw new Error("Set count exceeds match format");
  }
  if (next.currentSet < 1 || next.currentSet > format.bestOf) {
    throw new Error("Current set is outside the match format");
  }
  if (next.teamASets >= format.setsToWin && next.teamBSets >= format.setsToWin) {
    throw new Error("Both teams cannot have won the match");
  }
  return next;
}

export function shouldSideSwitch(state: ScoreState, format = defaultBeachFormat()): boolean {
  const target = setTarget(state.currentSet, format);
  const interval = target <= 15 ? 5 : 7;
  const total = state.teamAScore + state.teamBScore;
  return total > 0 && total % interval === 0;
}

export function normalizeScoreState(input: Partial<ScoreState> | Record<string, unknown> | null | undefined, format = defaultBeachFormat()): ScoreState {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const status = stringStatus(record.status);
  return {
    teamAScore: nonNegativeInt(record.teamAScore ?? record.team_a_score),
    teamBScore: nonNegativeInt(record.teamBScore ?? record.team_b_score),
    teamASets: nonNegativeInt(record.teamASets ?? record.team_a_sets),
    teamBSets: nonNegativeInt(record.teamBSets ?? record.team_b_sets),
    currentSet: clamp(nonNegativeInt(record.currentSet ?? record.current_set) || 1, 1, format.bestOf),
    setScores: Array.isArray(record.setScores ?? record.set_scores)
      ? (record.setScores ?? record.set_scores) as SetScore[]
      : [],
    servingTeam: record.servingTeam === "A" || record.serving_team === "A"
      ? "A"
      : record.servingTeam === "B" || record.serving_team === "B"
        ? "B"
        : null,
    status
  };
}

export function formatFromUnknown(input: Record<string, unknown> | null | undefined): MatchFormat {
  const fallback = defaultBeachFormat();
  const bestOf = positiveInt(input?.bestOf) ?? fallback.bestOf;
  const pointsPerSet = Array.isArray(input?.pointsPerSet)
    ? input.pointsPerSet.map(positiveInt).filter((value): value is number => value != null)
    : fallback.pointsPerSet;
  return {
    bestOf,
    setsToWin: positiveInt(input?.setsToWin) ?? Math.ceil(bestOf / 2),
    pointsPerSet: pointsPerSet.length ? pointsPerSet : fallback.pointsPerSet,
    winByTwo: input?.winByTwo !== false,
    cap: positiveInt(input?.cap)
  };
}

function setTarget(setNumber: number, format: MatchFormat): number {
  return format.pointsPerSet[setNumber - 1] ?? (setNumber >= format.bestOf ? 15 : 21);
}

function stringStatus(value: unknown): ScoreState["status"] {
  if (value === "Final") return "Final";
  if (value === "Set Complete") return "Set Complete";
  if (value === "In Progress") return "In Progress";
  if (typeof value === "string" && value.toLowerCase().includes("final")) return "Final";
  if (typeof value === "string" && value.toLowerCase().includes("set complete")) return "Set Complete";
  if (typeof value === "string" && value.toLowerCase().includes("progress")) return "In Progress";
  return "Prematch";
}

function nonNegativeInt(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function positiveInt(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isScoreStateLike(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && ("teamAScore" in value || "team_a_score" in value));
}
