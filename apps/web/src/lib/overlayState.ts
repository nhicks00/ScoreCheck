import type { OverlayLayout, OverlayPhase, OverlayState, SetScore } from "./types";

const VALID_PHASES: OverlayPhase[] = ["IDLE", "PREMATCH", "LIVE", "POSTMATCH", "STALE", "ERROR"];

export function fallbackOverlayState(courtNumber = 1): OverlayState {
  const safeCourtNumber = numberValue(courtNumber, 1, 1);
  return {
    eventId: "",
    courtId: "",
    courtNumber: safeCourtNumber,
    courtLabel: `Court ${safeCourtNumber}`,
    layout: "bottom-left",
    phase: "IDLE",
    mode: "api",
    frozen: false,
    match: {
      id: null,
      matchNumber: null,
      roundName: `Court ${safeCourtNumber}`,
      scheduledTime: null,
      teamA: { name: "TBD", seed: null, players: [] },
      teamB: { name: "TBD", seed: null, players: [] },
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], winByTwo: true, cap: null }
    },
    score: {
      teamAScore: 0,
      teamBScore: 0,
      teamASets: 0,
      teamBSets: 0,
      currentSet: 1,
      setScores: [],
      servingTeam: null
    },
    health: {
      lastUpdateAt: null,
      lastApiPollAt: null,
      apiOnline: false,
      stale: false,
      message: null
    }
  };
}

export function coerceOverlayState(input: unknown, courtNumber = 1): OverlayState {
  const base = fallbackOverlayState(courtNumber);
  const value = recordValue(input);
  if (!value) return base;

  const match = recordValue(value.match);
  const score = recordValue(value.score);
  const health = recordValue(value.health);
  const teamA = recordValue(match?.teamA);
  const teamB = recordValue(match?.teamB);
  const format = recordValue(match?.format);

  return {
    eventId: stringValue(value.eventId) ?? base.eventId,
    courtId: stringValue(value.courtId) ?? base.courtId,
    courtNumber: numberValue(value.courtNumber, base.courtNumber, 1),
    courtLabel: nullableString(value.courtLabel) ?? base.courtLabel,
    layout: value.layout === "top-left" ? "top-left" : "bottom-left",
    phase: validPhase(value.phase) ?? base.phase,
    mode: value.mode === "manual" || value.mode === "hybrid" ? value.mode : "api",
    frozen: Boolean(value.frozen),
    match: {
      id: nullableString(match?.id),
      matchNumber: nullableString(match?.matchNumber),
      roundName: nullableString(match?.roundName),
      scheduledTime: nullableString(match?.scheduledTime),
      teamA: {
        name: stringValue(teamA?.name) ?? base.match.teamA.name,
        seed: nullableString(teamA?.seed),
        players: stringArray(teamA?.players)
      },
      teamB: {
        name: stringValue(teamB?.name) ?? base.match.teamB.name,
        seed: nullableString(teamB?.seed),
        players: stringArray(teamB?.players)
      },
      format: {
        bestOf: numberValue(format?.bestOf, base.match.format.bestOf, 1, 5),
        pointsPerSet: pointTargets(format?.pointsPerSet),
        winByTwo: format?.winByTwo !== false,
        cap: nullableNumber(format?.cap),
        rawText: stringValue(format?.rawText)
      }
    },
    score: {
      teamAScore: numberValue(score?.teamAScore, base.score.teamAScore, 0, 99),
      teamBScore: numberValue(score?.teamBScore, base.score.teamBScore, 0, 99),
      teamASets: numberValue(score?.teamASets, base.score.teamASets, 0, 5),
      teamBSets: numberValue(score?.teamBSets, base.score.teamBSets, 0, 5),
      currentSet: numberValue(score?.currentSet, base.score.currentSet, 1, 5),
      setScores: coerceSetScores(score?.setScores),
      servingTeam: score?.servingTeam === "A" || score?.servingTeam === "B" ? score.servingTeam : null
    },
    health: {
      lastUpdateAt: nullableString(health?.lastUpdateAt),
      lastApiPollAt: nullableString(health?.lastApiPollAt),
      apiOnline: health?.apiOnline !== false,
      stale: Boolean(health?.stale),
      message: nullableString(health?.message)
    }
  };
}

export function completedSetScores(setScores: SetScore[]) {
  return coerceSetScores(setScores)
    .filter((set) => set.isComplete)
    .sort((a, b) => a.setNumber - b.setNumber)
    .slice(0, 3);
}

export function displayOverlayName(value: string | null | undefined) {
  const clean = cleanName(value);
  if (!clean || isPlaceholderName(clean)) return "TBD";
  if (clean.length <= 34) return clean;

  const parts = clean.split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    const abbreviated = parts.map((part) => abbreviateNamePart(part)).join(" / ");
    return abbreviated.length <= 42 ? abbreviated : `${abbreviated.slice(0, 39).trim()}...`;
  }

  const abbreviated = abbreviateNamePart(clean);
  return abbreviated.length <= 42 ? abbreviated : `${abbreviated.slice(0, 39).trim()}...`;
}

export function overlayPhaseText(state: OverlayState, connected: boolean) {
  if (!connected || state.health.stale) return "Stale";
  if (state.frozen) return "Frozen";
  if (state.phase === "IDLE") return state.courtLabel ?? `Court ${state.courtNumber}`;
  if (state.phase === "PREMATCH") return "Match starting soon";
  if (state.phase === "POSTMATCH") return "Final";
  if (state.phase === "STALE") return "Stale";
  if (state.phase === "ERROR") return "Error";
  return `Set ${state.score.currentSet || 1}`;
}

export function overlayLayoutValue(value: unknown): OverlayLayout {
  return value === "top-left" ? "top-left" : "bottom-left";
}

function coerceSetScores(value: unknown): SetScore[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = recordValue(item);
      if (!record) return null;
      return {
        setNumber: numberValue(record.setNumber, 1, 1, 5),
        teamAScore: numberValue(record.teamAScore, 0, 0, 99),
        teamBScore: numberValue(record.teamBScore, 0, 0, 99),
        isComplete: Boolean(record.isComplete)
      };
    })
    .filter((item): item is SetScore => Boolean(item));
}

function pointTargets(value: unknown) {
  if (!Array.isArray(value)) return [21, 21, 15];
  const targets = value.map((item) => numberValue(item, 21, 1, 99)).filter((item) => item > 0);
  return targets.length ? targets.slice(0, 5) : [21, 21, 15];
}

function validPhase(value: unknown): OverlayPhase | null {
  return VALID_PHASES.includes(value as OverlayPhase) ? value as OverlayPhase : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null {
  return stringValue(value) ?? null;
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberValue(value: unknown, fallback: number, min?: number, max?: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  let int = Math.trunc(number);
  if (min != null) int = Math.max(min, int);
  if (max != null) int = Math.min(max, int);
  return int;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter((item): item is string => Boolean(item)) : [];
}

function cleanName(value: string | null | undefined) {
  return (value ?? "").replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

function isPlaceholderName(value: string) {
  return /^(team\s*(a|b|on\s+left|on\s+right|left|right)|left\s+team|right\s+team|tbd|to\s+be\s+determined)$/i.test(value);
}

function abbreviateNamePart(value: string) {
  const feedIn = value.match(/^(winner|loser)\s+of\s+match\s+(\d+)$/i);
  if (feedIn) return `M${feedIn[2]} ${titleCase(feedIn[1])}`;

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return value;
  const last = words[words.length - 1];
  const initials = words.slice(0, -1).map((word) => `${word[0].toUpperCase()}.`).join(" ");
  return `${initials} ${last}`;
}

function titleCase(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
}
