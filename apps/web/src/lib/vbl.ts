import { z } from "zod";

const API_BASE = "https://volleyballlife-api-dot-net-8.azurewebsites.net";
const VMIX_BASE = "https://api.volleyballlife.com/api/v1.0/matches";
export const VBL_FETCH_TIMEOUT_MS = 8_000;
const VBL_HOSTS = new Set([new URL(API_BASE).hostname, new URL(VMIX_BASE).hostname]);

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

const recordSchema = z.record(z.string(), z.unknown());
const hydrateSchema = recordSchema.and(z.object({
  days: z.array(recordSchema),
  teams: z.array(recordSchema).default([])
}));

type TeamLookupEntry = { name: string; seed: string | null; players: string[] };

type ResolvedTeamSide = {
  name: string | null;
  seed: string | null;
  players: string[];
};

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

export async function discoverMatchesFromUrl(sourceUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiscoveredMatch[]> {
  const parts = parseVblUrl(sourceUrl);
  if (!parts) {
    throw new Error("Could not parse VolleyballLife division ID from URL");
  }

  const hydrate = hydrateSchema.parse(await fetchVblJson(`${API_BASE}/division/${parts.divisionId}/hydrate`, {
    fetchImpl,
    headers: { referer: "https://volleyballlife.com/" }
  }));
  return discoverMatchesFromHydrate(hydrate, sourceUrl, parts);
}

export async function fetchVblJson(url: string, options: { fetchImpl?: typeof fetch; headers?: Record<string, string>; timeoutMs?: number } = {}) {
  const parsed = assertSupportedVblApiUrl(url);
  const response = await (options.fetchImpl ?? fetch)(parsed, {
    headers: {
      accept: "application/json",
      "user-agent": "MultiCourtScore Cloud/0.1",
      ...options.headers
    },
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs ?? VBL_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`VolleyballLife API failed: HTTP ${response.status}`);
  return response.json();
}

export function assertSupportedVblApiUrl(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("VolleyballLife API URL is invalid"); }
  if (url.protocol !== "https:" || !VBL_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new Error("VolleyballLife API URL is outside the approved HTTPS hosts");
  }
  return url;
}

export function assertSupportedVblScorePayload(value: unknown) {
  if (Array.isArray(value)) {
    if (value.length < 2 || !value.slice(0, 2).every(isVmixTeamRow)) {
      throw new Error("VolleyballLife vMix payload schema is unsupported");
    }
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const score = record.score;
    const hasKnownEnvelope = typeof record.status === "string"
      || (score != null && typeof score === "object" && !Array.isArray(score));
    if (hasKnownEnvelope) return value;
  }
  throw new Error("VolleyballLife score payload schema is unsupported");
}

export function vblRetryDelayMs(failureCount: number, identity: string) {
  if (!Number.isInteger(failureCount) || failureCount < 1) throw new Error("VolleyballLife failure count must be positive");
  const base = Math.min(30_000, 1_800 * (2 ** Math.min(failureCount - 1, 5)));
  let hash = 0;
  for (const character of `${identity}:${failureCount}`) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return Math.min(30_000, base + Math.floor(base * 0.2 * (hash / 0xffff_ffff)));
}

export function discoverMatchesFromHydrate(rawHydrate: unknown, sourceUrl: string, parsedParts?: VblUrlParts): DiscoveredMatch[] {
  const parts = parsedParts ?? parseVblUrl(sourceUrl);
  if (!parts) {
    throw new Error("Could not parse VolleyballLife division ID from URL");
  }

  const hydrate = hydrateSchema.parse(rawHydrate);
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
  const lookup = new Map<number, TeamLookupEntry>();
  for (const team of arrayOfRecords(hydrate.teams)) {
    const id = numberValue(team.id);
    if (!id) continue;
    const players = arrayOfRecords(team.players).map((player) => stringValue(player.name) ?? playerFullName(player)).filter(Boolean);
    lookup.set(id, {
      name: stringValue(team.name) ?? (players.join(" / ") || "Unknown"),
      seed: stringValue(team.seed),
      players
    });
  }
  return lookup;
}

function isVmixTeamRow(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["teamName", "players", "isMatch", "game1", "game2", "game3"].some((key) => Object.hasOwn(record, key));
}

function extractBracketMatches(
  day: Record<string, unknown>,
  teamLookup: Map<number, TeamLookupEntry>,
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
      if (!matchId || isByeMatch(match)) continue;
      const home = resolveTeamSide(match, "home", teamLookup);
      const away = resolveTeamSide(match, "away", teamLookup);
      const displayNumber = nonZeroString(match.displayNumber) ?? stringValue(match.number) ?? String(index + 1);
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
        teamA: home.name,
        teamB: away.name,
        teamASeed: home.seed,
        teamBSeed: away.seed,
        teamAPlayers: home.players,
        teamBPlayers: away.players,
        format,
        sourcePayload: match
      });
    }
  }
  return matches;
}

function extractPoolMatches(
  day: Record<string, unknown>,
  teamLookup: Map<number, TeamLookupEntry>,
  sourceUrl: string,
  requestedPoolId: number | null
): DiscoveredMatch[] {
  const matches: DiscoveredMatch[] = [];
  for (const pool of poolsForDay(day)) {
    const poolId = numberValue(pool.id);
    if (requestedPoolId && poolId !== requestedPoolId) continue;
    const poolName = stringValue(pool.name) ?? "Pool";
    const poolSettings = arrayOfRecords(recordValue(pool.matchSettings)?.gameSettings);

    for (const [index, match] of arrayOfRecords(pool.matches).entries()) {
      const matchId = numberValue(match.id);
      if (!matchId || isByeMatch(match)) continue;
      const home = resolveTeamSide(match, "home", teamLookup);
      const away = resolveTeamSide(match, "away", teamLookup);
      const startTime = stringValue(match.startTime);
      const settings = arrayOfRecords(match.games).length ? arrayOfRecords(match.games) : poolSettings;
      const format = formatFromSettings(settings);
      matches.push({
        externalMatchId: String(matchId),
        apiUrl: `${VMIX_BASE}/${matchId}/vmix?bracket=false`,
        bracketUrl: sourceUrl,
        matchNumber: nonZeroString(match.displayNumber) ?? stringValue(match.number) ?? String(index + 1),
        roundName: poolName,
        scheduledTime: formatTime(startTime),
        scheduledDate: formatDate(startTime),
        courtNumber: stringValue(match.court),
        physicalCourt: stringValue(match.court),
        teamA: home.name,
        teamB: away.name,
        teamASeed: home.seed,
        teamBSeed: away.seed,
        teamAPlayers: home.players,
        teamBPlayers: away.players,
        format: { ...format, setsToPlay: settings.length || null },
        sourcePayload: match
      });
    }
  }
  return matches;
}

function resolveTeamSide(match: Record<string, unknown>, side: "home" | "away", teamLookup: Map<number, TeamLookupEntry>): ResolvedTeamSide {
  const teamRecord = recordValue(match[`${side}Team`]);
  const teamId = numberValue(teamRecord?.teamId ?? match[`${side}TeamId`]);
  const lookup = teamId ? teamLookup.get(teamId) : undefined;
  const mapText = normalizePlaceholderText(stringValue(match[`${side}Map`]));
  const directName = stringValue(teamRecord?.name) ?? stringValue(teamRecord?.teamName) ?? stringValue(match[`${side}TeamName`]);
  const seed = nonZeroString(teamRecord?.seed) ?? nonZeroString(match[`${side}Seed`]) ?? lookup?.seed ?? null;

  return {
    name: lookup?.name ?? directName ?? mapText,
    seed,
    players: lookup?.players ?? []
  };
}

function poolsForDay(day: Record<string, unknown>) {
  return [
    ...arrayOfRecords(day.pools),
    ...arrayOfRecords(day.flights).flatMap((flight) => arrayOfRecords(flight.pools))
  ];
}

function isByeMatch(match: Record<string, unknown>) {
  if (booleanValue(match.isBye)) return true;
  const homeTeam = recordValue(match.homeTeam);
  const awayTeam = recordValue(match.awayTeam);
  return (isByeText(stringValue(match.homeMap)) && !homeTeam) || (isByeText(stringValue(match.awayMap)) && !awayTeam);
}

function isByeText(value: string | null) {
  return value?.trim().toLowerCase() === "bye";
}

function normalizePlaceholderText(value: string | null) {
  if (!value || isByeText(value)) return null;
  const clean = value.replace(/\s+/g, " ").trim();
  const winner = clean.match(/^match\s+(.+?)\s+winner$/i);
  if (winner) return `Winner of Match ${winner[1]}`;
  const loser = clean.match(/^match\s+(.+?)\s+loser$/i);
  if (loser) return `Loser of Match ${loser[1]}`;
  return clean;
}

function nonZeroString(value: unknown) {
  const text = stringValue(value);
  if (!text || text === "0") return null;
  return text;
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
  const parts = iso.match(/T(\d{2}):(\d{2})/);
  if (!parts) return null;
  const hour24 = Number(parts[1]);
  const minute = parts[2];
  if (!Number.isFinite(hour24)) return null;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${minute} ${suffix}`;
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  const datePart = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)?.[0];
  if (!datePart) return null;
  const date = new Date(`${datePart}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const weekday = date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${datePart}`;
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
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}

function playerFullName(player: Record<string, unknown>) {
  const first = stringValue(player.firstname);
  const last = stringValue(player.lastname);
  return [first, last].filter(Boolean).join(" ").trim();
}
