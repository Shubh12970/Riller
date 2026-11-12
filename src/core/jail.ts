/**
 * Escalating penalties ("jail") - repeat offenders wait progressively longer.
 *
 * A plain rate limit says "slow down"; it treats the first violation and the
 * hundredth the same. A login route faces password spraying: an attacker
 * cycling passwords does not care about a 12-second retry-after when each
 * attempt is nearly free. Jail turns flood protection into an anti-abuse
 * policy: every rejected request lengthens the NEXT block exponentially
 * (30s, 60s, 120s, ... capped at 30 minutes), so sustained abuse becomes
 * exponentially expensive while a real user's one fumbled login costs them
 * seconds.
 *
 * Two design points, the same philosophy as the bucket math:
 *
 * 1. The penalty logic is one pure function (nextPenalty), shared by the
 *    local JailingLimiter below and the Durable Object shared store, so the
 *    escalation policy is written - and tested - exactly once.
 *
 * 2. Jail state lives wherever the buckets live. Locally that is a Map; on
 *    Cloudflare it is Durable Object storage, because a jail that exists only
 *    per-isolate is one an attacker escapes by landing on the next isolate.
 *    A successful request clears the record: legitimate users fat-finger a
 *    password, then log in - their record should not carry a grudge. Idle
 *    records are evicted with the same 10-minute policy as buckets, which
 *    also bounds memory against an attacker generating fresh keys.
 *
 * Honest limit: there is no gradual decay of the violation count short of
 * the idle eviction. Documenting that beats pretending otherwise.
 */

import type { RateLimiter, RateLimitResult } from './types.js';

export interface PenaltyState {
  /** How many consecutive rejections this key has earned. */
  violations: number;
  /** The caller is blocked until this time (epoch ms). */
  blockedUntilMs: number;
}

export const JAIL_BASE_SECONDS = 30;
export const JAIL_MAX_SECONDS = 30 * 60;

/** The penalty after another rejection: double the previous block, capped. */
export function nextPenalty(prev: PenaltyState | undefined, nowMs: number): PenaltyState {
  const violations = (prev?.violations ?? 0) + 1;
  const blockSeconds = Math.min(JAIL_MAX_SECONDS, JAIL_BASE_SECONDS * 2 ** (violations - 1));
  return { violations, blockedUntilMs: nowMs + blockSeconds * 1000 };
}

/** Seconds left on an active block (0 when the caller is not blocked). */
export function activeBlockSeconds(prev: PenaltyState | undefined, nowMs: number): number {
  if (!prev || nowMs >= prev.blockedUntilMs) return 0;
  return Math.ceil((prev.blockedUntilMs - nowMs) / 1000);
}

/** Where jail records live. The DO uses its own storage with the same shape. */
export interface PenaltyStore {
  get(key: string): PenaltyState | undefined;
  set(key: string, state: PenaltyState): void;
  delete(key: string): void;
}

export class PenaltyMemoryStore implements PenaltyStore {
  private readonly map = new Map<string, PenaltyState>();
  get(key: string): PenaltyState | undefined {
    return this.map.get(key);
  }
  set(key: string, state: PenaltyState): void {
    this.map.set(key, state);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}

/**
 * JailingLimiter - wraps any RateLimiter with escalating penalties. The inner
 * limiter still decides allowed/rejected; the wrapper only escalates what a
 * rejection costs and refuses to even ask the bucket while a block is active.
 */
export class JailingLimiter implements RateLimiter {
  readonly limit: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: RateLimiter,
    private readonly store: PenaltyStore = new PenaltyMemoryStore(),
    now?: () => number,
  ) {
    this.limit = inner.limit;
    this.now = now ?? Date.now;
  }

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const now = this.now();
    const prev = this.store.get(key);

    const blocked = activeBlockSeconds(prev, now);
    if (blocked > 0) {
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        retryAfterSeconds: blocked,
        resetSeconds: blocked,
      };
    }

    const result = await this.inner.consume(key, cost);
    if (result.allowed) {
      // A success clears the record: real users are forgiven immediately.
      if (prev?.violations) this.store.delete(key);
      return result;
    }

    const penalty = nextPenalty(prev, now);
    this.store.set(key, penalty);
    const block = activeBlockSeconds(penalty, now);
    return { ...result, retryAfterSeconds: Math.max(result.retryAfterSeconds, block) };
  }
}
