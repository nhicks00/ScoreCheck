export type TeamSide = "A" | "B";

const UNRESOLVED_TEAM_NAMES = new Set([
  "team on left",
  "team on right",
  "team a",
  "team b"
]);

export function displayTeamName(name: string | null | undefined, side: TeamSide): string {
  const clean = cleanTeamName(name);
  if (clean && !isGenericTeamName(clean)) return clean;
  return "TBD";
}

export function teamSideLabel(side: TeamSide): string {
  return side === "A" ? "Team A" : "Team B";
}

export function hasUnresolvedTeamName(name: string | null | undefined): boolean {
  const clean = cleanTeamName(name);
  return !clean || isGenericTeamName(clean);
}

export function matchupLabel(teamA: string | null | undefined, teamB: string | null | undefined): string {
  return `${displayTeamName(teamA, "A")} vs ${displayTeamName(teamB, "B")}`;
}

function cleanTeamName(name: string | null | undefined): string | null {
  const clean = name?.replace(/\s+/g, " ").trim();
  return clean || null;
}

function isGenericTeamName(name: string): boolean {
  return UNRESOLVED_TEAM_NAMES.has(name.toLowerCase());
}
