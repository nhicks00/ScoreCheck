export type CourtMode = "api" | "manual" | "hybrid";
export type OverlayLayout = "top-left" | "bottom-left";
export type OverlayPhase = "IDLE" | "PREMATCH" | "LIVE" | "POSTMATCH" | "STALE" | "ERROR";

export type MatchFormat = {
  bestOf: number;
  pointsPerSet: number[];
  winByTwo: boolean;
  cap: number | null;
  rawText?: string;
};

export type SetScore = {
  setNumber: number;
  teamAScore: number;
  teamBScore: number;
  isComplete: boolean;
};

export type ScoreSnapshot = {
  status: string;
  currentSet: number;
  teamAName: string;
  teamBName: string;
  teamASeed?: string | null;
  teamBSeed?: string | null;
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  servingTeam?: "A" | "B" | null;
  setScores: SetScore[];
  source: "api" | "manual" | "override";
  stale: boolean;
  message?: string | null;
};

export type OverlayState = {
  eventId: string;
  courtId: string;
  courtNumber: number;
  layout: OverlayLayout;
  phase: OverlayPhase;
  mode: CourtMode;
  frozen: boolean;
  match: {
    id: string | null;
    matchNumber: string | null;
    roundName: string | null;
    scheduledTime: string | null;
    teamA: { name: string; seed: string | null; players: string[] };
    teamB: { name: string; seed: string | null; players: string[] };
    format: MatchFormat;
  };
  score: {
    teamAScore: number;
    teamBScore: number;
    teamASets: number;
    teamBSets: number;
    currentSet: number;
    setScores: SetScore[];
    servingTeam?: "A" | "B" | null;
  };
  health: {
    lastUpdateAt: string | null;
    lastApiPollAt: string | null;
    apiOnline: boolean;
    stale: boolean;
    message: string | null;
  };
};
