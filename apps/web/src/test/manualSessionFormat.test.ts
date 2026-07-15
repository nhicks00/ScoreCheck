import { describe, expect, it } from "vitest";
import { manualSessionFormat } from "../lib/manualSessionFormat";

describe("manual session format", () => {
  it("builds every set in a best-of-five and reserves 15 for the deciding set", () => {
    expect(manualSessionFormat({ bestOf: 5 }).pointsPerSet)
      .toEqual([21, 21, 21, 21, 15]);
  });

  it("respects the explicitly supported first three set targets", () => {
    expect(manualSessionFormat({
      bestOf: 5,
      pointsSet1: 25,
      pointsSet2: 25,
      pointsSet3: 25
    }).pointsPerSet).toEqual([25, 25, 25, 21, 15]);
  });
});
