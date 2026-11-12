/**
 * Escalating penalties ("jail"): the pure escalation math, the local
 * JailingLimiter wrapper, and the Durable Object's shared jail records.
 */

import { describe, expect, it } from 'vitest';
import {
  JailingLimiter,
  JAIL_BASE_SECONDS,
  JAIL_MAX_SECONDS,
  activeBlockSeconds,
  nextPenalty,
} from '../src/core/jail.js';
import { TokenBucketLimiter } from '../src/core/tokenBucket.js';
import { MemoryStore } from '../src/core/memoryStore.js';
import { RateLimiterDO } from '../src/cloud/durableObject.js';

function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceMs: (ms: number) => { now += ms; },
  };
}

describe('nextPenalty escalation math', () => {
  it('doubles the block per violation and caps it', () => {
    const t0 = 1_000_000;
    const first = nextPenalty(undefined, t0);
    expect(first.violations).toBe(1);
    expect(first.blockedUntilMs - t0).toBe(JAIL_BASE_SECONDS * 1000); // 30s

    const second = nextPenalty(first, t0);
    expect(second.violations).toBe(2);
    expect(second.blockedUntilMs - t0).toBe(60_000);

    const third = nextPenalty(second, t0);
    expect(third.blockedUntilMs - t0).toBe(120_000);

    // 30s * 2^n eventually hits the 30-minute cap and stays there.
    let p = third;
    for (let i = 0; i < 20; i++) p = nextPenalty(p, t0);
    expect(p.blockedUntilMs - t0).toBe(JAIL_MAX_SECONDS * 1000);
  });

  it('activeBlockSeconds is 0 when no block is active', () => {
    expect(activeBlockSeconds(undefined, 1000)).toBe(0);
    expect(activeBlockSeconds({ violations: 3, blockedUntilMs: 500 }, 1000)).toBe(0);
    expect(activeBlockSeconds({ violations: 3, blockedUntilMs: 2500 }, 1000)).toBe(2);
  });
});

describe('JailingLimiter (local)', () => {
  function makeJailed(clock: { now: () => number }) {
    // Login-route-like numbers: 5/min, so an empty bucket waits 12s and the
    // 30s jail floor is what a violator actually feels.
    const bucket = new TokenBucketLimiter({
      capacity: 5,
      refillPerSecond: 5 / 60,
      store: new MemoryStore(10_000, 600_000, clock.now),
      now: clock.now,
    });
    return new JailingLimiter(bucket, undefined, clock.now);
  }

  it('after the first rejection, the jail floor drives the wait', async () => {
    const clock = makeClock();
    const limiter = makeJailed(clock);
    for (let i = 0; i < 5; i++) await limiter.consume('ip:user');
    const rejected = await limiter.consume('ip:user');
    expect(rejected.allowed).toBe(false);
    // Bucket alone would say 12s; jail escalates the wait to 30s.
    expect(rejected.retryAfterSeconds).toBe(JAIL_BASE_SECONDS);
  });

  it('refuses during the block, then forgives a success and resets the count', async () => {
    const clock = makeClock();
    const limiter = makeJailed(clock);
    for (let i = 0; i < 5; i++) await limiter.consume('ip:user');
    await limiter.consume('ip:user'); // rejected -> violation 1, 30s block

    clock.advanceMs(5000);
    const during = await limiter.consume('ip:user');
    expect(during.allowed).toBe(false);
    expect(during.retryAfterSeconds).toBe(25);

    // 30s later the block is over and the bucket has refilled past 1 token:
    // allowed, and the success clears the violation record.
    clock.advanceMs(30_000);
    const ok = await limiter.consume('ip:user');
    expect(ok.allowed).toBe(true);

    // Spend the refill, get rejected again: back to violation 1 (30s), not 60s.
    await limiter.consume('ip:user');
    await limiter.consume('ip:user');
    const fresh = await limiter.consume('ip:user');
    expect(fresh.allowed).toBe(false);
    expect(fresh.retryAfterSeconds).toBe(JAIL_BASE_SECONDS);
  });
});

describe('RateLimiterDO jail (shared store)', () => {
  class FakeStorage {
    readonly map = new Map<string, unknown>();
    async get<T>(key: string): Promise<T | undefined> {
      return this.map.get(key) as T | undefined;
    }
    async put(key: string, value: unknown): Promise<void> {
      this.map.set(key, value);
    }
    async delete(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) this.map.delete(k);
    }
    async list<T>(options: { prefix?: string }): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [k, v] of this.map) {
        if (!options.prefix || k.startsWith(options.prefix)) out.set(k, v as T);
      }
      return out;
    }
  }

  function consume(durable: RateLimiterDO, jail: boolean, key: string, capacity = 1) {
    return durable.fetch(
      new Request('https://do/consume', {
        method: 'POST',
        // 1 token per 10s: the bucket wait (10s) stays below the 30s jail floor.
        body: JSON.stringify({ limiter: 'login', key, capacity, refillPerSecond: 1 / 10, jail }),
      }),
    );
  }

  it('jails in shared storage: a fresh object over the same storage still blocks', async () => {
    const storage = new FakeStorage();
    const first = new RateLimiterDO({ storage } as unknown as DurableObjectState);
    await consume(first, true, 'ip:user'); // allowed (capacity 1)
    const rejected = await (await consume(first, true, 'ip:user')).json() as { allowed: boolean; retryAfterSeconds: number };
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBe(JAIL_BASE_SECONDS);

    // Simulate eviction: a new object over the same storage remembers the block.
    const second = new RateLimiterDO({ storage } as unknown as DurableObjectState);
    const stillBlocked = await (await consume(second, true, 'ip:user')).json() as { allowed: boolean };
    expect(stillBlocked.allowed).toBe(false);

    // Non-jail limiters ignore penalty records.
    const noJail = await (await consume(second, false, 'ip:user')).json() as { allowed: boolean };
    expect(noJail.allowed).toBe(false); // bucket is still empty, but NOT blocked by jail
  });
});
