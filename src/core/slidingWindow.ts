/**
 * Sliding window log - the accurate-but-heavier third algorithm.
 *
 * Remember the timestamp of every request a key has made in the last window;
 * the count of surviving timestamps is the current usage. No edge bursts like
 * fixed window, but memory grows with request volume per key (every timestamp
 * is stored), which is why high-traffic systems usually accept token bucket's
 * approximation instead. Included so the tradeoff is concrete, not theoretical.
 */

import type { RateLimiter, RateLimitResult } from './types.js';

export class SlidingWindowLimiter implements RateLimiter {
  readonly limit: number;
  private readonly windowMs: number;
  private readonly logs = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(options: { limit: number; windowSeconds: number; now?: () => number }) {
    this.limit = options.limit;
    this.windowMs = options.windowSeconds * 1000;
    this.now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const log = (this.logs.get(key) ?? []).filter((t) => t > cutoff);

    if (log.length < this.limit) {
      log.push(now);
      this.logs.set(key, log);
      const oldestRelevant = log.length > 1 ? log[0] : now;
      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - log.length,
        retryAfterSeconds: 0,
        resetSeconds: Math.max(1, Math.ceil((oldestRelevant + this.windowMs - now) / 1000)),
      };
    }

    this.logs.set(key, log);
    const oldest = log[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      retryAfterSeconds,
      resetSeconds: retryAfterSeconds,
    };
  }
}
