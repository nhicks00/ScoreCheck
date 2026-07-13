export type BrowserCounterSample = {
  pageLoadedAt: string;
  framesReceived: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
  freezeCount: number | null;
  totalFreezesDurationMs: number | null;
};

export type BrowserCounterDelta = {
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number;
  totalFreezesDurationMs: number;
};

type CounterField = Exclude<keyof BrowserCounterSample, "pageLoadedAt">;

const COUNTER_FIELDS: CounterField[] = [
  "framesReceived",
  "framesDecoded",
  "framesDropped",
  "freezeCount",
  "totalFreezesDurationMs"
];

const ZERO_DELTA: BrowserCounterDelta = {
  framesReceived: 0,
  framesDecoded: 0,
  framesDropped: 0,
  freezeCount: 0,
  totalFreezesDurationMs: 0
};

export class BrowserCounterAccumulator {
  private readonly baselines = new Map<number, BrowserCounterSample>();

  observe(courtNumber: number, current: BrowserCounterSample): BrowserCounterDelta {
    const previous = this.baselines.get(courtNumber);
    if (!previous || previous.pageLoadedAt !== current.pageLoadedAt) {
      this.baselines.set(courtNumber, { ...current });
      return { ...ZERO_DELTA };
    }

    const next = { ...previous, pageLoadedAt: current.pageLoadedAt };
    const delta = { ...ZERO_DELTA };
    for (const field of COUNTER_FIELDS) {
      const currentValue = current[field];
      if (currentValue == null) continue;
      const previousValue = previous[field];
      next[field] = currentValue;
      if (previousValue == null || currentValue < previousValue) continue;
      delta[field] = currentValue - previousValue;
    }
    this.baselines.set(courtNumber, next);
    return delta;
  }
}
