import { Counter, Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import { incrementCourtCounter } from "./prometheusCounter.js";

describe("Prometheus counter initialization", () => {
  it("exports a labeled zero series before the first positive delta", async () => {
    const registry = new Registry();
    const counter = new Counter({
      name: "scorecheck_test_counter_total",
      help: "Test counter.",
      labelNames: ["court"],
      registers: [registry]
    });

    incrementCourtCounter(counter, { court: "1" }, 0);

    expect(await registry.metrics()).toContain('scorecheck_test_counter_total{court="1"} 0');
  });

  it("does not export invalid or negative deltas", async () => {
    const registry = new Registry();
    const counter = new Counter({
      name: "scorecheck_invalid_counter_total",
      help: "Test counter.",
      labelNames: ["court"],
      registers: [registry]
    });

    incrementCourtCounter(counter, { court: "1" }, -1);
    incrementCourtCounter(counter, { court: "1" }, Number.NaN);

    expect(await registry.metrics()).not.toContain('scorecheck_invalid_counter_total{court="1"}');
  });
});
