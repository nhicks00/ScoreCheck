import { describe, expect, it, vi } from "vitest";
import { loadCourtPipelineRange, parseRangeInput } from "./rangeQueries.js";

describe("allowlisted range queries", () => {
  it("bounds window and density", () => {
    expect(parseRangeInput({ windowSec: "300", stepSec: "15" })).toEqual({ windowSec: 300, stepSec: 15 });
    expect(() => parseRangeInput({ windowSec: 3_600, stepSec: 5 })).toThrow();
    expect(() => parseRangeInput({ windowSec: 60, stepSec: 15 })).toThrow();
  });

  it("returns only bounded numeric court series from fixed PromQL", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      const query = new URL(String(url)).searchParams.get("query");
      expect(query).toMatch(/^scorecheck_/);
      return new Response(JSON.stringify({
        status: "success",
        data: { resultType: "matrix", result: [{ metric: { court: "1" }, values: [[100, "1.5"], [115, "NaN"], [130, "2.5"]] }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await loadCourtPipelineRange("http://prometheus:9090", { windowSec: 300, stepSec: 15 }, 400_000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.courts[0]?.rawBitrate).toEqual([[100, 1.5], [130, 2.5]]);
    expect(result.courts).toHaveLength(8);
  });
});
