import { z } from "zod";
import { isSetComplete } from "./scoring";

export type ManualSetScore = {
  setNumber: number;
  teamAScore: number;
  teamBScore: number;
  isComplete: boolean;
};

export type ManualScoreState = {
  team_a_score: number;
  team_b_score: number;
  team_a_sets: number;
  team_b_sets: number;
  current_set: number;
  set_scores: ManualSetScore[];
  serving_team: "A" | "B" | null;
  timeouts: Record<string, unknown>;
  status: string;
};

export type ManualFormat = {
  bestOf: number;
  pointsPerSet: number[];
  winByTwo: boolean;
  cap: number | null;
  setsToWin: number;
};

export const manualEditSchema = z.object({
  teamAScore: z.coerce.number().int().min(0).max(99).optional(),
  teamBScore: z.coerce.number().int().min(0).max(99).optional(),
  teamASets: z.coerce.number().int().min(0).max(5).optional(),
  teamBSets: z.coerce.number().int().min(0).max(5).optional(),
  currentSet: z.coerce.number().int().min(1).max(5).optional(),
  servingTeam: z.enum(["A", "B", "none"]).optional(),
  setScores: z.array(z.object({
    setNumber: z.coerce.number().int().min(1).max(5),
    teamAScore: z.coerce.number().int().min(0).max(99),
    teamBScore: z.coerce.number().int().min(0).max(99),
    isComplete: z.coerce.boolean()
  })).optional(),
  status: z.string().max(40).optional()
});

export function defaultManualState(): ManualScoreState {
  return {
    team_a_score: 0,
    team_b_score: 0,
    team_a_sets: 0,
    team_b_sets: 0,
    current_set: 1,
    set_scores: [],
    serving_team: null,
    timeouts: {},
    status: "In Progress"
  };
}

export function normalizeManualState(row: Record<string, unknown> | null | undefined): ManualScoreState {
  if (!row) return defaultManualState();
  return {
    team_a_score: numberValue(row.team_a_score) ?? 0,
    team_b_score: numberValue(row.team_b_score) ?? 0,
    team_a_sets: numberValue(row.team_a_sets) ?? 0,
    team_b_sets: numberValue(row.team_b_sets) ?? 0,
    current_set: numberValue(row.current_set) ?? 1,
    set_scores: Array.isArray(row.set_scores) ? row.set_scores as ManualSetScore[] : [],
    serving_team: row.serving_team === "A" || row.serving_team === "B" ? row.serving_team : null,
    timeouts: recordValue(row.timeouts) ?? {},
    status: typeof row.status === "string" ? row.status : "In Progress"
  };
}

export function formatFromMatch(match: { format?: Record<string, unknown> | null } | null | undefined): ManualFormat {
  const format = match?.format ?? {};
  const bestOf = numberValue(format.bestOf) ?? 3;
  const points = Array.isArray(format.pointsPerSet)
    ? format.pointsPerSet.map(numberValue).filter((value): value is number => value != null)
    : [21, 21, 15];
  return {
    bestOf,
    pointsPerSet: points.length ? points : [21, 21, 15],
    winByTwo: format.winByTwo !== false,
    cap: numberValue(format.cap),
    setsToWin: numberValue(format.setsToWin) ?? Math.ceil(bestOf / 2)
  };
}

export function applyManualAction(
  state: ManualScoreState,
  action: "point-a" | "point-b" | "set-complete" | "match-complete" | "toggle-serve" | "timeout-a" | "timeout-b" | "side-switch",
  format: ManualFormat
): ManualScoreState {
  const next = cloneState(state);
  if (next.status.toLowerCase().includes("final") && action !== "toggle-serve") {
    return next;
  }

  if (action === "point-a") {
    next.team_a_score += 1;
  } else if (action === "point-b") {
    next.team_b_score += 1;
  } else if (action === "toggle-serve") {
    next.serving_team = next.serving_team === "A" ? "B" : next.serving_team === "B" ? null : "A";
    return next;
  } else if (action === "timeout-a" || action === "timeout-b") {
    const key = action === "timeout-a" ? "A" : "B";
    next.timeouts = { ...next.timeouts, [key]: (numberValue(next.timeouts[key]) ?? 0) + 1 };
    return next;
  } else if (action === "side-switch") {
    next.timeouts = { ...next.timeouts, sideSwitchCount: (numberValue(next.timeouts.sideSwitchCount) ?? 0) + 1 };
    return next;
  } else if (action === "match-complete") {
    next.status = "Final";
    syncCurrentSet(next, format, true);
    return next;
  }

  const forceSetComplete = action === "set-complete";
  syncCurrentSet(next, format, forceSetComplete);
  return next;
}

export function applyManualEdit(state: ManualScoreState, edit: z.infer<typeof manualEditSchema>, format: ManualFormat): ManualScoreState {
  const next = cloneState(state);
  if (edit.teamAScore != null) next.team_a_score = edit.teamAScore;
  if (edit.teamBScore != null) next.team_b_score = edit.teamBScore;
  if (edit.teamASets != null) next.team_a_sets = edit.teamASets;
  if (edit.teamBSets != null) next.team_b_sets = edit.teamBSets;
  if (edit.currentSet != null) next.current_set = edit.currentSet;
  if (edit.servingTeam != null) next.serving_team = edit.servingTeam === "none" ? null : edit.servingTeam;
  if (edit.setScores != null) next.set_scores = edit.setScores;
  if (edit.status != null) next.status = edit.status;
  syncCurrentSet(next, format, false);
  return next;
}

function syncCurrentSet(state: ManualScoreState, format: ManualFormat, forceSetComplete: boolean) {
  const target = state.current_set >= format.bestOf
    ? Math.min(format.pointsPerSet[state.current_set - 1] ?? 15, 15)
    : format.pointsPerSet[state.current_set - 1] ?? format.pointsPerSet[0] ?? 21;
  const complete = forceSetComplete || isSetComplete(state.team_a_score, state.team_b_score, target, format.winByTwo ? format.cap : target);

  const nextSetScores = state.set_scores.filter((set) => set.setNumber !== state.current_set);
  nextSetScores.push({
    setNumber: state.current_set,
    teamAScore: state.team_a_score,
    teamBScore: state.team_b_score,
    isComplete: complete
  });
  nextSetScores.sort((a, b) => a.setNumber - b.setNumber);
  state.set_scores = nextSetScores;

  if (complete) {
    const completed = state.set_scores.filter((set) => set.isComplete);
    state.team_a_sets = completed.filter((set) => set.teamAScore > set.teamBScore).length;
    state.team_b_sets = completed.filter((set) => set.teamBScore > set.teamAScore).length;
    if (state.team_a_sets >= format.setsToWin || state.team_b_sets >= format.setsToWin) {
      state.status = "Final";
      return;
    }
    state.current_set += 1;
    state.team_a_score = 0;
    state.team_b_score = 0;
    state.status = "In Progress";
  } else {
    state.status = "In Progress";
  }
}

function cloneState(state: ManualScoreState): ManualScoreState {
  return JSON.parse(JSON.stringify(state)) as ManualScoreState;
}

function numberValue(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
