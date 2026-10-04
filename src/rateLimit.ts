/**
 * In-memory token-bucket rate limiter. State is per process: run a single
 * instance (the shipped deploy configs do) or back this with Redis to scale out.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Try to take one token from `key`, whose bucket holds `perMinute` tokens and refills continuously. */
  take(key: string, perMinute: number): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    const ratePerMs = perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: perMinute, updated: now };
    b.tokens = Math.min(perMinute, b.tokens + (now - b.updated) * ratePerMs);
    b.updated = now;
    this.buckets.set(key, b);

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.ceil((1 - b.tokens) / ratePerMs / 1000) };
  }

  /** Drop buckets that have fully refilled; call periodically to bound memory. */
  sweep(maxIdleMs = 10 * 60_000): void {
    const cutoff = this.now() - maxIdleMs;
    for (const [k, b] of this.buckets) if (b.updated < cutoff) this.buckets.delete(k);
  }
}
