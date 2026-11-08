/**
 * Fixed window - the simplest rate limiter, kept in this project as the
 * teaching baseline. Count requests per clock window (e.g. per minute); when
 * the count passes the limit, reject until the next window starts.
 *
 * Its known weakness, demonstrated in the tests: a burst at 10:00:59 and
 * another at 10:01:00 fall in different windows, so twice the limit can pass
 * in two seconds. Token bucket (tokenBucket.ts) does not have this problem,
 * which is why the demo API's important routes use the bucket and this stays
 * as a comparison you can point at in an interview.
 */

import type { RateLimiter, RateLimitResult } from './types.js';

interface WindowState {
  count: number;
  windowStartMs: number;
}

export class FixedWindowLimiter implements RateLimiter {
  readonly limit: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, WindowState>();
  private readonly now: () => number;

  constructor(options: { limit: number; windowSeconds: number; now?: () => number }) {
    this.limit = options.limit;
    this.windowMs = options.windowSeconds * 1000;
    this.now = options.now ?? Date.now;
  }

  async consume(key: string): Promise<RateLimitResult> {
    const now = this.now();
    const windowStartMs = Math.floor(now / this.windowMs) * this.windowMs;
    const windowEndMs = windowStartMs + this.windowMs;
    const resetSeconds = Math.max(1, Math.ceil((windowEndMs - now) / 1000));

    let state = this.windows.get(key);
    if (!state || state.windowStartMs !== windowStartMs) {
      state = { count: 0, windowStartMs };
      this.windows.set(key, state);
    }

    if (state.count < this.limit) {
      state.count += 1;
      return {
        allowed: true,
        limit: this.limit,
        remaining: this.limit - state.count,
        retryAfterSeconds: 0,
        resetSeconds,
      };
    }

    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      retryAfterSeconds: resetSeconds,
      resetSeconds,
    };
  }
}
