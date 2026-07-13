import { describe, expect, it } from "vitest";
import { BrowserCounterAccumulator, type BrowserCounterSample } from "./browserCounterAccumulator.js";

const FIRST_PAGE = "2026-07-13T12:00:00.000Z";

function sample(patch: Partial<BrowserCounterSample> = {}): BrowserCounterSample {
  return {
    pageLoadedAt: FIRST_PAGE,
    framesReceived: 1_000,
    framesDecoded: 990,
    framesDropped: 10,
    freezeCount: 2,
    totalFreezesDurationMs: 500,
    ...patch
  };
}

describe("browser counter accumulator", () => {
  it("uses the first observation as a baseline and ignores repeated polls", () => {
    const accumulator = new BrowserCounterAccumulator();
    expect(accumulator.observe(1, sample())).toEqual(zeroDelta());
    expect(accumulator.observe(1, sample())).toEqual(zeroDelta());
  });

  it("emits only positive monotonic deltas", () => {
    const accumulator = new BrowserCounterAccumulator();
    accumulator.observe(1, sample());
    expect(accumulator.observe(1, sample({
      framesReceived: 1_150,
      framesDecoded: 1_135,
      framesDropped: 15,
      freezeCount: 3,
      totalFreezesDurationMs: 750
    }))).toEqual({
      framesReceived: 150,
      framesDecoded: 145,
      framesDropped: 5,
      freezeCount: 1,
      totalFreezesDurationMs: 250
    });
  });

  it("re-baselines a new page and a reset peer connection without fabricating increments", () => {
    const accumulator = new BrowserCounterAccumulator();
    accumulator.observe(1, sample());
    expect(accumulator.observe(1, sample({
      pageLoadedAt: "2026-07-13T12:05:00.000Z",
      framesReceived: 20,
      framesDecoded: 20,
      framesDropped: 0,
      freezeCount: 0,
      totalFreezesDurationMs: 0
    }))).toEqual(zeroDelta());
    expect(accumulator.observe(1, sample({
      pageLoadedAt: "2026-07-13T12:05:00.000Z",
      framesReceived: 5,
      framesDecoded: 5,
      framesDropped: 0,
      freezeCount: 0,
      totalFreezesDurationMs: 0
    }))).toEqual(zeroDelta());
  });

  it("retains a prior baseline through a temporarily unavailable field", () => {
    const accumulator = new BrowserCounterAccumulator();
    accumulator.observe(1, sample());
    expect(accumulator.observe(1, sample({ framesDropped: null }))).toEqual(zeroDelta());
    expect(accumulator.observe(1, sample({ framesDropped: 14 }))).toMatchObject({ framesDropped: 4 });
  });

  it("isolates baselines by court", () => {
    const accumulator = new BrowserCounterAccumulator();
    accumulator.observe(1, sample());
    accumulator.observe(2, sample({ framesDropped: 50 }));
    expect(accumulator.observe(1, sample({ framesDropped: 12 }))).toMatchObject({ framesDropped: 2 });
    expect(accumulator.observe(2, sample({ framesDropped: 55 }))).toMatchObject({ framesDropped: 5 });
  });
});

function zeroDelta() {
  return {
    framesReceived: 0,
    framesDecoded: 0,
    framesDropped: 0,
    freezeCount: 0,
    totalFreezesDurationMs: 0
  };
}
