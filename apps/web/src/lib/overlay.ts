import { OverlayLayout, OverlayPhase, OverlayState } from "./types";
import { coerceOverlayState } from "./overlayState";

type OverlayInput = {
  event: { id: string; settings?: Record<string, unknown> | null };
  court: {
    id: string;
    event_id: string;
    court_number: number;
    display_name?: string | null;
    vbl_court_label?: string | null;
    vbl_court_number?: string | null;
    mode: "api" | "manual" | "hybrid";
    frozen: boolean;
    status: string;
    last_update_at: string | null;
  };
  match: {
    id: string;
    match_number: string | null;
    round_name: string | null;
    scheduled_time: string | null;
    team_a: string | null;
    team_b: string | null;
    team_a_seed: string | null;
    team_b_seed: string | null;
    team_a_players: string[] | null;
    team_b_players: string[] | null;
    format: Record<string, unknown> | null;
  } | null;
  score: {
    team_a_score: number;
    team_b_score: number;
    team_a_sets: number;
    team_b_sets: number;
    current_set: number;
    set_scores: unknown;
    serving_team: string | null;
    status: string;
    stale: boolean;
    message: string | null;
    last_api_poll_at: string | null;
    updated_at: string | null;
  } | null;
};

export function buildOverlayState(input: OverlayInput): OverlayState {
  const phase = resolvePhase(input.court, input.match, input.score);
  const matchFormat = input.match?.format ?? null;
  const rawPointsPerSet = matchFormat?.pointsPerSet;
  const rawSetScores = input.score?.set_scores;
  return coerceOverlayState({
    eventId: input.court.event_id,
    courtId: input.court.id,
    courtNumber: input.court.court_number,
    courtLabel: courtLabel(input.court),
    layout: overlayLayout(input.event.settings),
    phase,
    mode: input.court.mode,
    frozen: input.court.frozen,
    match: {
      id: input.match?.id ?? null,
      matchNumber: input.match?.match_number ?? null,
      roundName: input.match?.round_name ?? null,
      scheduledTime: input.match?.scheduled_time ?? null,
      teamA: {
        name: teamName(input.match?.team_a),
        seed: input.match?.team_a_seed ?? null,
        players: input.match?.team_a_players ?? []
      },
      teamB: {
        name: teamName(input.match?.team_b),
        seed: input.match?.team_b_seed ?? null,
        players: input.match?.team_b_players ?? []
      },
      format: {
        bestOf: numberValue(matchFormat?.bestOf) ?? 3,
        setsToWin: numberValue(matchFormat?.setsToWin),
        pointsPerSet: Array.isArray(rawPointsPerSet) ? rawPointsPerSet as number[] : [21, 21, 15],
        winByTwo: matchFormat?.winByTwo !== false,
        cap: numberValue(matchFormat?.cap),
        rawText: stringValue(matchFormat?.rawText)
      }
    },
    score: {
      teamAScore: input.score?.team_a_score ?? 0,
      teamBScore: input.score?.team_b_score ?? 0,
      teamASets: input.score?.team_a_sets ?? 0,
      teamBSets: input.score?.team_b_sets ?? 0,
      currentSet: input.score?.current_set ?? 1,
      setScores: Array.isArray(rawSetScores) ? rawSetScores as OverlayState["score"]["setScores"] : [],
      servingTeam: input.score?.serving_team === "A" || input.score?.serving_team === "B" ? input.score.serving_team : null
    },
    health: {
      lastUpdateAt: input.score?.updated_at ?? input.court.last_update_at,
      lastApiPollAt: input.score?.last_api_poll_at ?? null,
      apiOnline: !(input.score?.stale ?? false),
      stale: input.score?.stale ?? false,
      message: input.score?.message ?? null
    }
  }, input.court.court_number);
}

function courtLabel(court: OverlayInput["court"]): string {
  const vblLabel = stringValue(court.vbl_court_label);
  if (vblLabel) return vblLabel;

  const vblCourtNumber = stringValue(court.vbl_court_number);
  if (vblCourtNumber) return /^court\b/i.test(vblCourtNumber) ? vblCourtNumber : `Court ${vblCourtNumber}`;

  const displayName = stringValue(court.display_name);
  if (displayName) return displayName;

  return `Court ${court.court_number}`;
}

export function overlayLayout(settings: Record<string, unknown> | null | undefined): OverlayLayout {
  return settings?.overlayLayout === "bottom-left" ? "bottom-left" : "top-left";
}

function resolvePhase(
  court: OverlayInput["court"],
  match: OverlayInput["match"],
  score: OverlayInput["score"]
): OverlayPhase {
  if (score?.stale) return "STALE";
  if (court.status === "error") return "ERROR";
  if (!match) return "IDLE";
  if (score?.status?.toLowerCase().includes("final")) return "POSTMATCH";
  if ((score?.team_a_score ?? 0) > 0 || (score?.team_b_score ?? 0) > 0 || (score?.team_a_sets ?? 0) > 0 || (score?.team_b_sets ?? 0) > 0) {
    return "LIVE";
  }
  return "PREMATCH";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function numberValue(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function teamName(value: string | null | undefined) {
  return value?.trim() || "TBD";
}
