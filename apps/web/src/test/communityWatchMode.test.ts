import { describe, expect, it } from "vitest";
import {
  storedVideoPreference
} from "../app/score/session/communityWatchMode";

describe("community watch mode", () => {
  it("defaults to watch mode only when video exists and honors score-only preference", () => {
    expect(storedVideoPreference(null, true)).toBe(true);
    expect(storedVideoPreference("watch", true)).toBe(true);
    expect(storedVideoPreference("score-only", true)).toBe(false);
    expect(storedVideoPreference("watch", false)).toBe(false);
  });
});
