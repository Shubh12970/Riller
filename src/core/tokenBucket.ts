/**
 * Token bucket - the algorithm behind most production API rate limits.
 *
 * Picture a bucket that holds up to `capacity` tokens. Tokens drip in at a
 * steady `refillPerSecond` rate. Every request spends one token. An empty
 * bucket means "wait". This allows short bursts (spend saved-up tokens) while
 * capping the long-term average (the refill rate), which is exactly the
 * behaviour APIs want and why it beats a plain per-minute counter.
 *
 * The actual math lives in `consumeToken`, a pure function: given a stored
 * bucket state and the time, it returns the new state and the decision. Both
 * the local limiter below and the Durable Object shared store call it, so the
 * algorithm is written - and tested - exactly once.
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

/** Shared config guard, used by the local limiter and the Durable Object. */
export function assertValidBucketConfig(capacity: number, refillPerSecond: number): void {
  if (capacity < 1) throw new Error('capacity must be at least 1');
  if (refillPerSecond <= 0) throw new Error('refillPerSecond must be positive');
}

/**
 * The whole token-bucket decision in one pure step. No I/O, no globals: the
 * same code runs in the local limiter, in tests, and inside the Durable
 * Object, which is what makes the shared store trustworthy by construction.
 */
export function consumeToken(
  state: BucketState,
  capacity: number,
  refillPerSecond: number,
  nowMs: number,
): { state: BucketState; result: RateLimitResult } {
  // Clamp to 0: a backwards clock jump must never create tokens.
  const elapsedSeconds = Math.max(0, (nowMs - state.lastRefillMs) / 1000);
  const tokens = Math.min(capacity, state.tokens + elapsedSeconds * refillPerSecond);

  if (tokens >= 1) {
    // Compute reset AFTER the spend: a full bucket that just spent a token
    // is no longer full, so its reset time must be non-zero.
    const afterSpend = tokens - 1;
    return {
      state: { tokens: afterSpend, lastRefillMs: nowMs },
      result: {
        allowed: true,
        limit: capacity,
        remaining: Math.floor(afterSpend),
        retryAfterSeconds: 0,
        resetSeconds: Math.ceil((capacity - afterSpend) / refillPerSecond),
      },
    };
  }

  const secondsToWait = (1 - tokens) / refillPerSecond;
  return {
    state: { tokens, lastRefillMs: nowMs },
    result: {
      allowed: false,
      limit: capacity,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(secondsToWait)),
      resetSeconds: Math.max(1, Math.ceil((capacity - tokens) / refillPerSecond)),
    },
  };
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
    assertValidBucketConfig(options.capacity, options.refillPerSecond);
    this.capacity = options.capacity;
    this.limit = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.store = options.store;
    this.now = options.now ?? Date.now;
  }

  async consume(key: string): Promise<RateLimitResult> {
    const now = this.now();
    const current = this.store.get(key) ?? { tokens: this.capacity, lastRefillMs: now };
    const { state, result } = consumeToken(current, this.capacity, this.refillPerSecond, now);
    this.store.set(key, state);
    return result;
  }
}
