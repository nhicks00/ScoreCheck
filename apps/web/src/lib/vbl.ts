import { z } from "zod";

const API_BASE = "https://volleyballlife-api-dot-net-8.azurewebsites.net";
const VMIX_BASE = "https://api.volleyballlife.com/api/v1.0/matches";

export type VblUrlParts = {
  tournamentId: number | null;
  divisionId: number;
  dayId: number | null;
  isBracket: boolean;
  isPool: boolean;
  poolId: number | null;
};

export type DiscoveredMatch = {
  externalMatchId: string;
  apiUrl: string;
  bracketUrl: string;
  matchNumber: string | null;
  roundName: string | null;
  scheduledTime: string | null;
  scheduledDate: string | null;
  courtNumber: string | null;
  physicalCourt: string | null;
  teamA: string | null;
  teamB: string | null;
  teamASeed: string | null;
  teamBSeed: string | null;
  teamAPlayers: string[];
  teamBPlayers: string[];
  format: {
    bestOf: number;
    pointsPerSet: number[];
    winByTwo: boolean;
    cap: number | null;
    rawText: string;
    setsToWin: number;
    setsToPlay: number | null;
  };
  sourcePayload: Record<string, unknown>;
};

const hydrateSchema = z.record(z.string(), z.unknown());

export function parseVblUrl(url: string): VblUrlParts | null {
  const tournamentId = Number(url.match(/\/event\/(\d+)/)?.[1] ?? NaN);
  const divisionId = Number(url.match(/\/division\/(\d+)/)?.[1] ?? NaN);
  const dayId = Number(url.match(/\/round\/(\d+)/)?.[1] ?? NaN);
  const poolId = Number(url.match(/\/pools\/(\d+)/)?.[1] ?? NaN);
  if (!Number.isFinite(divisionId)) {
    return null;
  }

  const lower = url.toLowerCase();
  return {
    tournamentId: Number.isFinite(tournamentId) ? tournamentId : null,
    divisionId,
    dayId: Number.isFinite(dayId) ? dayId : null,
    poolId: Number.isFinite(poolId) ? poolId : null,
    isBracket: lower.includes("bracket") || lower.includes("playoff"),
    isPool: lower.includes("pool")
  };
}

export async function discoverMatchesFromUrl(sourceUrl: string): Promise<DiscoveredMatch[]> {
  const parts = parseVblUrl(sourceUrl);
  if (!parts) {
    throw new Error("Could not parse VolleyballLife division ID from URL");
  }

  const res = await fetch(`${API_BASE}/division/${parts.divisionId}/hydrate`, {
    headers: {
      accept: "application/json",
      referer: "https://volleyballlife.com/",
      "user-agent": "MultiCourtScore Cloud/0.1"
    },
    cache: "no-store"
  });
  if (!res.ok) {
    throw new Error(`VolleyballLife hydrate failed: HTTP ${res.status}`);
  }

  const hydrate = hydrateSchema.parse(await res.json());
  const teamLookup = buildTeamLookup(hydrate);
  const days = arrayOfRecords(hydrate.days);
  const relevantDays = parts.dayId ? days.filter((day) => numberValue(day.id) === parts.dayId) : days;

  const matches: DiscoveredMatch[] = [];
  for (const day of relevantDays) {
    if (!parts.isPool) {
      matches.push(...extractBracketMatches(day, teamLookup, sourceUrl));
    }
    if (!parts.isBracket) {
      matches.push(...extractPoolMatches(day, teamLookup, sourceUrl, parts.poolId));
    }
  }
  return dedupeMatches(matches);
}

function buildTeamLookup(hydrate: Record<string, unknown>) {
  const lookup = new Map<number, { name: string; seed: string | null; players: string[] }>();
  for (const team of arrayOfRecords(hydrate.teams)) {
    const id = numberValue(team.id);
    if (!id) continue;
    lookup.set(id, {
      name: stringValue(team.name) ?? "Unknown",
      seed: stringValue(team.seed),
      players: arrayOfRecords(team.players).map((player) => stringValue(player.name) ?? "").filter(Boolean)
    });
  }
  return lookup;
}

function extractBracketMatches(
  day: Record<string, unknown>,
  teamLookup: Map<number, { name: string; seed: string | null; players: string[] }>,
  sourceUrl: string
): DiscoveredMatch[] {
  const matches: DiscoveredMatch[] = [];
  for (const bracket of arrayOfRecords(day.brackets)) {
    const bracketName = stringValue(bracket.name) ?? "Bracket";
    const bracketType = (stringValue(bracket.type) ?? "").toLowerCase();
    const roundName = bracketType.includes("double")
      ? "Double Elim"
      : bracketType.includes("single")
        ? "Single Elim"
        : bracketName;
    const settings = arrayOfRecords(recordValue(bracket.winnersMatchSettings)?.gameSettings);
    const format = formatFromSettings(settings);

    for (const [index, match] of arrayOfRecords(bracket.matches).entries()) {
      const matchId = numberValue(match.id);
      if (!matchId || booleanValue(match.isBye)) continue;
      const homeTeam = recordValue(match.homeTeam);
      const awayTeam = recordValue(match.awayTeam);
      const homeInfo = homeTeam ? teamLookup.get(numberValue(homeTeam.teamId) ?? 0) : undefined;
      const awayInfo = awayTeam ? teamLookup.get(numberValue(awayTeam.teamId) ?? 0) : undefined;
      const teamB = awayInfo?.name ?? stringValue(match.awayMap);
      const displayNumber = stringValue(match.displayNumber) ?? stringValue(match.number) ?? String(index + 1);
      const startTime = stringValue(match.startTime);
      matches.push({
        externalMatchId: String(matchId),
        apiUrl: `${VMIX_BASE}/${matchId}/vmix?bracket=true`,
        bracketUrl: sourceUrl,
        matchNumber: displayNumber,
        roundName,
        scheduledTime: formatTime(startTime),
        scheduledDate: formatDate(startTime),
        courtNumber: stringValue(match.court),
        physicalCourt: stringValue(match.court),
        teamA: homeInfo?.name ?? null,
        teamB: teamB ?? null,
        teamASeed: homeTeam ? stringValue(homeTeam.seed) : homeInfo?.seed ?? null,
        teamBSeed: awayTeam ? stringValue(awayTeam.seed) : awayInfo?.seed ?? null,
        teamAPlayers: homeInfo?.players ?? [],
        teamBPlayers: awayInfo?.players ?? [],
        format,
        sourcePayload: match
      });
    }
  }
  return matches;
}

function extractPoolMatches(
  day: Record<string, unknown>,
  teamLookup: Map<number, { name: string; seed: string | null; players: string[] }>,
  sourceUrl: string,
  requestedPoolId: number | null
): DiscoveredMatch[] {
  const matches: DiscoveredMatch[] = [];
  for (const pool of arrayOfRecords(day.pools)) {
    const poolId = numberValue(pool.id);
    if (requestedPoolId && poolId !== requestedPoolId) continue;
    const poolName = stringValue(pool.name) ?? "Pool";
    const settings = arrayOfRecords(recordValue(pool.matchSettings)?.gameSettings);
    const format = formatFromSettings(settings);

    for (const [index, match] of arrayOfRecords(pool.matches).entries()) {
      const matchId = numberValue(match.id);
      if (!matchId) continue;
      const homeTeamId = numberValue(match.homeTeamId ?? recordValue(match.homeTeam)?.teamId);
      const awayTeamId = numberValue(match.awayTeamId ?? recordValue(match.awayTeam)?.teamId);
      const homeInfo = homeTeamId ? teamLookup.get(homeTeamId) : undefined;
      const awayInfo = awayTeamId ? teamLookup.get(awayTeamId) : undefined;
      const startTime = stringValue(match.startTime);
      matches.push({
        externalMatchId: String(matchId),
        apiUrl: `${VMIX_BASE}/${matchId}/vmix?bracket=false`,
        bracketUrl: sourceUrl,
        matchNumber: stringValue(match.displayNumber) ?? stringValue(match.number) ?? String(index + 1),
        roundName: poolName,
        scheduledTime: formatTime(startTime),
        scheduledDate: formatDate(startTime),
        courtNumber: stringValue(match.court),
        physicalCourt: stringValue(match.court),
        teamA: homeInfo?.name ?? null,
        teamB: awayInfo?.name ?? null,
        teamASeed: homeInfo?.seed ?? null,
        teamBSeed: awayInfo?.seed ?? null,
        teamAPlayers: homeInfo?.players ?? [],
        teamBPlayers: awayInfo?.players ?? [],
        format: { ...format, setsToPlay: settings.length || null },
        sourcePayload: match
      });
    }
  }
  return matches;
}

function formatFromSettings(settings: Record<string, unknown>[]) {
  const points = settings.map((setting) => numberValue(setting.to) ?? 21);
  const caps = settings.map((setting) => numberValue(setting.cap)).filter((cap): cap is number => !!cap && cap > 0);
  const gameCount = Math.max(settings.length, 1);
  const setsToWin = gameCount > 1 ? Math.ceil(gameCount / 2) : 1;
  const cap = caps[0] ?? null;
  return {
    bestOf: gameCount,
    pointsPerSet: points.length ? points : [21],
    winByTwo: cap == null,
    cap,
    rawText: settings.length
      ? settings.map((setting, index) => `set ${index + 1} to ${numberValue(setting.to) ?? 21}${numberValue(setting.cap) ? ` cap ${numberValue(setting.cap)}` : ""}`).join(", ")
      : "1 set to 21",
    setsToWin,
    setsToPlay: null
  };
}

function dedupeMatches(matches: DiscoveredMatch[]) {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = match.apiUrl.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatTime(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function numberValue(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}
