import { describe, expect, it } from "vitest";
import { buildActiveVblSourceSet, matchBelongsToActiveVblSource, normalizeVblSourceUrl } from "../lib/vblSources";

const todaysPools = [
  "https://volleyballlife.com/event/37451/division/136904/round/311708/pools",
  "https://volleyballlife.com/event/37451/division/136905/round/311711/pools"
];

describe("VBL source filtering", () => {
  it("normalizes source URLs before comparing sources", () => {
    expect(normalizeVblSourceUrl(`${todaysPools[0]}/?ignored=1#hash`)).toBe(todaysPools[0]);
  });

  it("allows only VBL matches from the active source URLs", () => {
    const active = buildActiveVblSourceSet(todaysPools);

    expect(matchBelongsToActiveVblSource({
      source_type: "vbl",
      bracket_url: todaysPools[0]
    }, active)).toBe(true);

    expect(matchBelongsToActiveVblSource({
      source_type: "vbl",
      bracket_url: "https://volleyballlife.com/event/37451/division/136905/round/287193/brackets"
    }, active)).toBe(false);
  });

  it("keeps manual matches independent from VBL source filtering", () => {
    const active = buildActiveVblSourceSet(todaysPools);
    expect(matchBelongsToActiveVblSource({ source_type: "manual", bracket_url: null }, active)).toBe(true);
  });
});
