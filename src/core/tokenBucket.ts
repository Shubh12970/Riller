/**
 * Token bucket - the industry-default rate-limiting algorithm.
 *
 * Picture a bucket that holds up to `capacity` tokens. Tokens drip in at a
 * steady `refillPerSecond` rate. Every request spends one token. An empty
 * bucket means "wait". This allows short bursts (spend saved-up tokens) while
 * capping the long-term average (the refill rate), which is exactly the
 * behaviour APIs want and why it beats a plain per-minute counter.
 *
 * The clock is injected (`now`) for two reasons: tests can simulate minutes
 * passing in milliseconds, and a backwards clock jump (NTP correction) is
 * clamped to zero so refill math can never hand out extra tokens.
 */

import type { RateLimiter, RateLimitResult } from './types.js';

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface TokenBucketStore {
  get(key: string): BucketState | undefined;
  set(key: string, state: BucketState): void;
}

export interface TokenBucketOptions {
  /** Maximum tokens the bucket can hold = maximum burst size. */
  capacity: number;
  /** Tokens added per second; the sustained request rate. */
  refillPerSecond: number;
  store: TokenBucketStore;
  now?: () => number;
}

export class TokenBucketLimiter implements RateLimiter {
  readonly limit: number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly store: TokenBucketStore;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity < 1) throw new Error('capacity must be at least 1');
    if (options.refillPerSecond <= 0) throw new Error('refillPerSecond must be positive');
    this.capacity = options.capacity;
    this.limit = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitResult {
    const now = this.now();
    const state = this.store.get(key) ?? { tokens: this.capacity, lastRefillMs: now };

    // Clamp to 0: a backwards clock jump must never create tokens.
    const elapsedSeconds = Math.max(0, (now - state.lastRefillMs) / 1000);
    const tokens = Math.min(this.capacity, state.tokens + elapsedSeconds * this.refillPerSecond);

    if (tokens >= 1) {
      // Compute reset AFTER the spend: a full bucket that just spent a token
      // is no longer full, so its reset time must be non-zero.
      const afterSpend = tokens - 1;
      this.store.set(key, { tokens: afterSpend, lastRefillMs: now });
      return {
        allowed: true,
        limit: this.capacity,
        remaining: Math.floor(afterSpend),
        retryAfterSeconds: 0,
        resetSeconds: Math.ceil((this.capacity - afterSpend) / this.refillPerSecond),
      };
    }

    const secondsToWait = (1 - tokens) / this.refillPerSecond;
    this.store.set(key, { tokens, lastRefillMs: now });
    return {
      allowed: false,
      limit: this.capacity,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(secondsToWait)),
      resetSeconds: Math.max(1, Math.ceil((this.capacity - tokens) / this.refillPerSecond)),
    };
  }
}
