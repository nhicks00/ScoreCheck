export type ProgramSessionCounters = {
  reconnectCount: number;
  reloadCount: number;
  lastNavigationTimeOrigin: number | null;
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const EMPTY_COUNTERS: ProgramSessionCounters = {
  reconnectCount: 0,
  reloadCount: 0,
  lastNavigationTimeOrigin: null
};

/**
 * Records browser reloads once per navigation and preserves both diagnostics
 * across reload descendants in the same tab. A normal first navigation is not
 * a reload. sessionStorage gives each program tab an independent lineage.
 */
export function recordProgramPageLoad(
  storage: StorageLike,
  courtNumber: number,
  navigation: { type: string; timeOrigin: number }
): ProgramSessionCounters {
  const current = readProgramSessionCounters(storage, courtNumber);
  const sameNavigation = current.lastNavigationTimeOrigin === navigation.timeOrigin;
  const next = {
    ...current,
    reloadCount: current.reloadCount + (navigation.type === "reload" && !sameNavigation ? 1 : 0),
    lastNavigationTimeOrigin: finiteNonNegative(navigation.timeOrigin)
  };
  writeProgramSessionCounters(storage, courtNumber, next);
  return next;
}

export function incrementProgramReconnect(
  storage: StorageLike,
  courtNumber: number
): ProgramSessionCounters {
  const current = readProgramSessionCounters(storage, courtNumber);
  const next = { ...current, reconnectCount: current.reconnectCount + 1 };
  writeProgramSessionCounters(storage, courtNumber, next);
  return next;
}

export function readProgramSessionCounters(
  storage: StorageLike,
  courtNumber: number
): ProgramSessionCounters {
  try {
    const parsed = JSON.parse(storage.getItem(counterKey(courtNumber)) ?? "null") as Record<string, unknown> | null;
    if (!parsed) return { ...EMPTY_COUNTERS };
    return {
      reconnectCount: finiteCount(parsed.reconnectCount),
      reloadCount: finiteCount(parsed.reloadCount),
      lastNavigationTimeOrigin: finiteNonNegative(parsed.lastNavigationTimeOrigin)
    };
  } catch {
    return { ...EMPTY_COUNTERS };
  }
}

function writeProgramSessionCounters(
  storage: StorageLike,
  courtNumber: number,
  counters: ProgramSessionCounters
) {
  try {
    storage.setItem(counterKey(courtNumber), JSON.stringify(counters));
  } catch {
    // Diagnostics must never destabilize the program page.
  }
}

function counterKey(courtNumber: number) {
  return `scorecheck-program-session:v1:court-${Math.max(1, Math.trunc(courtNumber))}`;
}

function finiteCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function finiteNonNegative(value: unknown): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}
