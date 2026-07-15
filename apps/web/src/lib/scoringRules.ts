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

export function removePoint(state: ScoreState, team: TeamSide, format = defaultBeachFormat()): ScoreState {
  if (state.status === "Final") return clone(state);
  const next = normalizeScoreState(state, format);
  if (team === "A") next.teamAScore = Math.max(0, next.teamAScore - 1);
  if (team === "B") next.teamBScore = Math.max(0, next.teamBScore - 1);
  next.status = next.teamAScore === 0 && next.teamBScore === 0 ? "Prematch" : "In Progress";
  return next;
}

export function canCompleteSet(state: ScoreState, format = defaultBeachFormat()): boolean {
  const target = setTargetForFormat(state.currentSet, format);
  const high = Math.max(state.teamAScore, state.teamBScore);
  const low = Math.min(state.teamAScore, state.teamBScore);
  if (high === low) return false;
  if (format.cap && high >= format.cap) return true;
  if (high < target) return false;
  return !format.winByTwo || high - low >= 2;
}

export function completeSet(state: ScoreState, format = defaultBeachFormat()): ScoreState {
  return completeSetWithOptions(state, format);
}

export function forceCompleteSet(state: ScoreState, format = defaultBeachFormat()): ScoreState {
  return completeSetWithOptions(state, format, { force: true });
}

function completeSetWithOptions(state: ScoreState, format = defaultBeachFormat(), options: { force?: boolean } = {}): ScoreState {
  const current = normalizeScoreState(state, format);
  if (!options.force && !canCompleteSet(current, format)) {
    throw new Error("Set cannot be completed from the current score");
  }
  if (!currentSetHasWinner(current)) {
    throw new Error("Set needs a non-tied score before it can be saved");
  }
  const recorded = recordCurrentSet(current);
  if (recorded.teamASets >= format.setsToWin || recorded.teamBSets >= format.setsToWin || recorded.currentSet >= format.bestOf) {
    return {
      ...recorded,
      status: "Final"
    };
  }

  return {
    ...recorded,
    teamAScore: 0,
    teamBScore: 0,
    currentSet: Math.min(recorded.currentSet + 1, format.bestOf),
    servingTeam: null,
    status: "In Progress"
  };
}

function recordCurrentSet(current: ScoreState): ScoreState {
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
  return {
    ...current,
    teamASets,
    teamBSets,
    setScores
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

export function forceCompleteMatch(state: ScoreState, format = defaultBeachFormat()): ScoreState {
  const next = normalizeScoreState(state, format);
  if (currentSetHasWinner(next)) {
    return { ...recordCurrentSet(next), status: "Final" };
  }
  if (next.teamASets === next.teamBSets) {
    throw new Error("Match needs a set winner before it can be finished");
  }
  return { ...next, status: "Final" };
}

export function undoPoint(previousEventLog: Array<{ previousState?: unknown; nextState?: unknown }>): ScoreState {
  const previous = previousEventLog.find((event) => isScoreStateLike(event.previousState))?.previousState;
  if (!previous) return emptyScoreState();
  return normalizeScoreState(previous as Partial<ScoreState>);
}

export function validateManualCorrection(input: Partial<ScoreState>, format = defaultBeachFormat()): ScoreState {
  rejectNegativeField(input.teamAScore, "Scores cannot be negative");
  rejectNegativeField(input.teamBScore, "Scores cannot be negative");
  rejectNegativeField(input.teamASets, "Set counts cannot be negative");
  rejectNegativeField(input.teamBSets, "Set counts cannot be negative");
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

  const setNumbers = new Set<number>();
  let derivedTeamASets = 0;
  let derivedTeamBSets = 0;
  for (const set of next.setScores) {
    if (!Number.isInteger(set.setNumber) || set.setNumber < 1 || set.setNumber > format.bestOf) {
      throw new Error("Set history is outside the match format");
    }
    if (setNumbers.has(set.setNumber)) throw new Error("Set numbers must be unique");
    setNumbers.add(set.setNumber);
    if (!Number.isInteger(set.teamAScore) || !Number.isInteger(set.teamBScore) || set.teamAScore < 0 || set.teamBScore < 0) {
      throw new Error("Set scores must be non-negative whole numbers");
    }
    if (!set.isComplete) continue;
    if (set.teamAScore === set.teamBScore) throw new Error("Completed sets need a winner");
    if (set.teamAScore > set.teamBScore) derivedTeamASets += 1;
    if (set.teamBScore > set.teamAScore) derivedTeamBSets += 1;
  }
  if (next.teamASets !== derivedTeamASets || next.teamBSets !== derivedTeamBSets) {
    throw new Error("Set counts must match completed set history");
  }
  if (next.status === "Final" && next.teamASets === next.teamBSets && next.teamAScore === next.teamBScore) {
    throw new Error("Final score needs a match winner");
  }
  return next;
}

export function shouldSideSwitch(state: ScoreState, format = defaultBeachFormat()): boolean {
  const target = setTargetForFormat(state.currentSet, format);
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
  const defaultPoints = Array.from({ length: bestOf }, (_, index) => index === bestOf - 1 ? 15 : 21);
  const pointsPerSet = Array.isArray(input?.pointsPerSet)
    ? input.pointsPerSet.map(positiveInt).filter((value): value is number => value != null)
    : defaultPoints;
  return {
    bestOf,
    setsToWin: positiveInt(input?.setsToWin) ?? Math.ceil(bestOf / 2),
    pointsPerSet: pointsPerSet.length ? pointsPerSet : defaultPoints,
    winByTwo: input?.winByTwo !== false,
    cap: positiveInt(input?.cap)
  };
}

export function setTargetForFormat(setNumber: number, format: Pick<MatchFormat, "bestOf" | "pointsPerSet">): number {
  return format.pointsPerSet[setNumber - 1] ?? (setNumber >= format.bestOf ? 15 : 21);
}

function currentSetHasWinner(state: ScoreState): boolean {
  return Math.max(state.teamAScore, state.teamBScore) > 0 && state.teamAScore !== state.teamBScore;
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

function rejectNegativeField(value: unknown, message: string) {
  if (value == null) return;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric < 0) throw new Error(message);
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
