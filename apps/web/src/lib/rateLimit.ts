type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();
// Long-lived processes (worker, local dev) accumulate one bucket per key
// forever without a sweep; serverless instances never get close to this.
const MAX_BUCKETS = 10_000;

function pruneExpired(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size >= MAX_BUCKETS) {
    pruneExpired(now);
  }
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= limit) {
    return false;
  }
  current.count += 1;
  return true;
}
