// Tiny in-memory sliding-window limiter for the public storefront endpoints (lookup/submit/status).
// It is per process: fine for a single server, and a first line of defence against someone guessing order numbers.
// Behind several instances, move the counters to a shared store.

const hits = new Map<string, number[]>();
let lastSweep = 0;

/** Returns true when `key` has used up `max` calls in the last `windowMs` (and records this call otherwise). */
export function rateLimited(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);

  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, v] of hits) if (!v.some((t) => now - t < 3_600_000)) hits.delete(k); // forget keys idle for an hour
  }
  return false;
}
