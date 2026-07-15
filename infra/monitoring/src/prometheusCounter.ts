import type { Counter } from "prom-client";

export function incrementCourtCounter(counter: Counter, labels: { court: string }, value: number): void {
  if (Number.isFinite(value) && value >= 0) counter.inc(labels, value);
}
