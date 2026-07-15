export type ManualSessionFormatInput = {
  bestOf?: number;
  pointsSet1?: number;
  pointsSet2?: number;
  pointsSet3?: number;
  cap?: string;
};

const DEFAULT_FORMAT = {
  bestOf: 3,
  pointsPerSet: [21, 21, 15],
  winByTwo: true,
  cap: null as number | null,
  setsToWin: 2
};

export function manualSessionFormat(body: ManualSessionFormatInput) {
  const bestOf = body.bestOf ?? DEFAULT_FORMAT.bestOf;
  const explicitPoints = [body.pointsSet1, body.pointsSet2, body.pointsSet3];
  const pointsPerSet = Array.from({ length: bestOf }, (_, index) =>
    explicitPoints[index] ?? (bestOf > 1 && index === bestOf - 1 ? 15 : 21)
  );
  const cap = body.cap && body.cap !== "none" ? Number(body.cap) : null;
  return {
    ...DEFAULT_FORMAT,
    bestOf,
    pointsPerSet,
    cap: Number.isFinite(cap) ? cap : null,
    setsToWin: Math.ceil(bestOf / 2)
  };
}
