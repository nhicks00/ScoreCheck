import { describe, expect, it } from "vitest";
import {
  incrementProgramReconnect,
  readProgramSessionCounters,
  recordProgramPageLoad
} from "../lib/programDiagnostics";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

describe("program session diagnostics", () => {
  it("does not count the first navigation as a reload", () => {
    const storage = memoryStorage();
    const counters = recordProgramPageLoad(storage, 1, { type: "navigate", timeOrigin: 1000 });
    expect(counters).toEqual({ reconnectCount: 0, reloadCount: 0, lastNavigationTimeOrigin: 1000 });
  });

  it("counts each browser reload once and preserves reconnects", () => {
    const storage = memoryStorage();
    recordProgramPageLoad(storage, 1, { type: "navigate", timeOrigin: 1000 });
    incrementProgramReconnect(storage, 1);
    incrementProgramReconnect(storage, 1);

    expect(recordProgramPageLoad(storage, 1, { type: "reload", timeOrigin: 2000 }))
      .toEqual({ reconnectCount: 2, reloadCount: 1, lastNavigationTimeOrigin: 2000 });
    expect(recordProgramPageLoad(storage, 1, { type: "reload", timeOrigin: 2000 }).reloadCount).toBe(1);
    expect(recordProgramPageLoad(storage, 1, { type: "reload", timeOrigin: 3000 }).reloadCount).toBe(2);
  });

  it("isolates counters by court and repairs malformed storage", () => {
    const storage = memoryStorage();
    storage.setItem("scorecheck-program-session:v1:court-1", "not-json");
    incrementProgramReconnect(storage, 2);
    expect(readProgramSessionCounters(storage, 1)).toEqual({
      reconnectCount: 0,
      reloadCount: 0,
      lastNavigationTimeOrigin: null
    });
    expect(readProgramSessionCounters(storage, 2).reconnectCount).toBe(1);
  });
});
