import type { OverlayLayout, OverlayPhase, OverlayState, SetScore } from "./types";

const VALID_PHASES: OverlayPhase[] = ["IDLE", "PREMATCH", "LIVE", "POSTMATCH", "STALE", "ERROR"];

export function fallbackOverlayState(courtNumber = 1): OverlayState {
  const safeCourtNumber = numberValue(courtNumber, 1, 1);
  return {
    projection: {
      schemaVersion: 1,
      scoreRevision: 0,
      authorityEpoch: 0,
      sourceRevision: null,
      sourceTimestamp: null,
      materializedAt: null,
      bodyChecksum: null
    },
    eventId: "",
    courtId: "",
    courtNumber: safeCourtNumber,
    courtLabel: `Court ${safeCourtNumber}`,
    layout: "top-left",
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
      format: { bestOf: 3, setsToWin: 2, pointsPerSet: [21, 21, 15], winByTwo: true, cap: null }
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
  const projection = recordValue(value.projection);

  return normalizeFinalOverlayState({
    projection: {
      schemaVersion: 1,
      scoreRevision: nonNegativeInteger(projection?.scoreRevision),
      authorityEpoch: nonNegativeInteger(projection?.authorityEpoch),
      sourceRevision: nullableString(projection?.sourceRevision),
      sourceTimestamp: isoString(projection?.sourceTimestamp),
      materializedAt: isoString(projection?.materializedAt),
      bodyChecksum: sha256Value(projection?.bodyChecksum)
    },
    eventId: stringValue(value.eventId) ?? base.eventId,
    courtId: stringValue(value.courtId) ?? base.courtId,
    courtNumber: numberValue(value.courtNumber, base.courtNumber, 1),
    courtLabel: nullableString(value.courtLabel) ?? base.courtLabel,
    layout: value.layout === "bottom-left" ? "bottom-left" : "top-left",
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
        setsToWin: numberValue(format?.setsToWin, base.match.format.setsToWin ?? 2, 1, 5),
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
  });
}

export function completedSetScores(setScores: SetScore[]) {
  return completedPlayedSetScores(setScores).slice(0, 3);
}

export function scorebugDisplayScores(state: OverlayState) {
  const displaySets = scorebugDisplaySetScores(state);
  const currentDisplaySet = displaySets.at(-1) ?? null;

  return {
    teamAScore: currentDisplaySet?.teamAScore ?? state.score.teamAScore,
    teamBScore: currentDisplaySet?.teamBScore ?? state.score.teamBScore,
    teamASetScores: displaySets.map((set) => set.teamAScore),
    teamBSetScores: displaySets.map((set) => set.teamBScore)
  };
}

function scorebugDisplaySetScores(state: OverlayState) {
  const finalDisplay = isFinalDisplayState(state);
  if (finalDisplay) {
    return finalPlayedSetScores(state.score.setScores, setsToWin(state.match.format)).slice(0, 3);
  }

  const bySetNumber = new Map<number, SetScore>();
  for (const set of completedPlayedSetScores(state.score.setScores)) {
    bySetNumber.set(set.setNumber, set);
  }

  if (state.phase !== "IDLE" && state.phase !== "PREMATCH") {
    const currentSetNumber = numberValue(state.score.currentSet, 1, 1, 3);
    const currentSetFromPayload = coerceSetScores(state.score.setScores)
      .find((set) => set.setNumber === currentSetNumber && !set.isComplete);
    const completedCurrentSet = bySetNumber.get(currentSetNumber);
    if (!completedCurrentSet) {
      bySetNumber.set(currentSetNumber, {
        setNumber: currentSetNumber,
        teamAScore: currentSetFromPayload?.teamAScore ?? state.score.teamAScore,
        teamBScore: currentSetFromPayload?.teamBScore ?? state.score.teamBScore,
        isComplete: false
      });
    }
  }

  return [...bySetNumber.values()].sort((a, b) => a.setNumber - b.setNumber).slice(0, 3);
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
  // PREMATCH intentionally renders no phrase — "starting soon" was often untrue
  // on broadcast (queued matches can sit long past their slot). The bubble bar
  // shows just court label + match number instead.
  if (state.phase === "PREMATCH") return "";
  if (state.phase === "POSTMATCH" || isFinalDisplayState(state)) return "Final";
  if (state.phase === "STALE") return "Stale";
  if (state.phase === "ERROR") return "Error";
  return `Set ${state.score.currentSet || 1}`;
}

export function overlayLayoutValue(value: unknown): OverlayLayout {
  return value === "bottom-left" ? "bottom-left" : "top-left";
}

export function overlayStateUpdatedAtMs(state: OverlayState): number | null {
  const parsed = Date.parse(state.health.lastUpdateAt ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

export type OverlayApplyCursor = {
  scope: string;
  scoreRevision: number;
  sourceTimestampMs: number | null;
  updateTimestampMs: number | null;
};

export function overlayApplyCursor(state: OverlayState): OverlayApplyCursor {
  return {
    scope: [state.eventId, state.courtId, state.match.id ?? "no-match"].join(":"),
    scoreRevision: state.projection.scoreRevision,
    sourceTimestampMs: timestampMs(state.projection.sourceTimestamp),
    updateTimestampMs: overlayStateUpdatedAtMs(state)
  };
}

export function shouldApplyOverlayUpdate(candidate: OverlayState, lastApplied: OverlayApplyCursor | null): boolean {
  if (!lastApplied) return true;
  const next = overlayApplyCursor(candidate);
  if (next.scope !== lastApplied.scope) return true;
  if (next.scoreRevision < lastApplied.scoreRevision) return false;
  if (next.scoreRevision > lastApplied.scoreRevision) return true;
  const candidateTimestamp = next.sourceTimestampMs ?? next.updateTimestampMs;
  const appliedTimestamp = lastApplied.sourceTimestampMs ?? lastApplied.updateTimestampMs;
  if (candidateTimestamp == null) return false;
  return appliedTimestamp == null || candidateTimestamp >= appliedTimestamp;
}

function coerceSetScores(value: unknown): SetScore[] {
  if (!Array.isArray(value)) return [];
  const parsed = value
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
  return dedupeSetScores(parsed);
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isoString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function sha256Value(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function timestampMs(value: string | null): number | null {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function dedupeSetScores(setScores: SetScore[]): SetScore[] {
  const bySetNumber = new Map<number, SetScore>();
  for (const set of setScores) {
    const existing = bySetNumber.get(set.setNumber);
    if (existing && existing.isComplete && !set.isComplete) continue;
    bySetNumber.set(set.setNumber, set);
  }
  return [...bySetNumber.values()].sort((a, b) => a.setNumber - b.setNumber);
}

function normalizeFinalOverlayState(state: OverlayState): OverlayState {
  if (!isFinalDisplayState(state)) return state;
  const playedSets = finalPlayedSetScores(state.score.setScores, setsToWin(state.match.format));
  const lastPlayedSet = playedSets.at(-1);
  if (!lastPlayedSet) return state;
  const setCounts = setWinCounts(playedSets);

  return {
    ...state,
    score: {
      ...state.score,
      teamAScore: lastPlayedSet.teamAScore,
      teamBScore: lastPlayedSet.teamBScore,
      teamASets: setCounts.teamASets,
      teamBSets: setCounts.teamBSets,
      currentSet: lastPlayedSet.setNumber,
      setScores: playedSets
    }
  };
}

function completedPlayedSetScores(setScores: SetScore[]) {
  const bySetNumber = new Map<number, SetScore>();
  for (const set of coerceSetScores(setScores)) {
    if (!set.isComplete || (set.teamAScore === 0 && set.teamBScore === 0)) continue;
    bySetNumber.set(set.setNumber, set);
  }
  return [...bySetNumber.values()].sort((a, b) => a.setNumber - b.setNumber);
}

function finalPlayedSetScores(setScores: SetScore[], requiredSets: number) {
  const playedSets = completedPlayedSetScores(setScores);
  const finalSets: SetScore[] = [];
  let teamASets = 0;
  let teamBSets = 0;

  for (const set of playedSets) {
    finalSets.push(set);
    if (set.teamAScore > set.teamBScore) teamASets += 1;
    if (set.teamBScore > set.teamAScore) teamBSets += 1;
    if (teamASets >= requiredSets || teamBSets >= requiredSets) break;
  }

  return finalSets;
}

function setWinCounts(setScores: SetScore[]) {
  return setScores.reduce((counts, set) => {
    if (set.teamAScore > set.teamBScore) counts.teamASets += 1;
    if (set.teamBScore > set.teamAScore) counts.teamBSets += 1;
    return counts;
  }, { teamASets: 0, teamBSets: 0 });
}

function isFinalDisplayState(state: OverlayState) {
  if (state.phase === "POSTMATCH") return true;
  const requiredSets = setsToWin(state.match.format);
  if (Math.max(state.score.teamASets, state.score.teamBSets) >= requiredSets) return true;
  const completedCounts = setWinCounts(completedPlayedSetScores(state.score.setScores));
  return Math.max(completedCounts.teamASets, completedCounts.teamBSets) >= requiredSets;
}

function setsToWin(format: OverlayState["match"]["format"]) {
  const explicitSetsToWin = numberValue(format.setsToWin, 0, 1, 5);
  return explicitSetsToWin > 0
    ? explicitSetsToWin
    : Math.max(1, Math.ceil(numberValue(format.bestOf, 3, 1, 5) / 2));
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
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberValue(value: unknown, fallback: number, min?: number, max?: number): number {
  if (value == null || value === "") return fallback;
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
