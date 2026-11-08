import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter } from '../src/core/tokenBucket.js';
import { MemoryStore } from '../src/core/memoryStore.js';

// An injectable clock lets tests simulate minutes passing in milliseconds.
function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advanceMs: (ms: number) => { now += ms; },
  };
}

function makeLimiter(clock: { now: () => number }, capacity = 5, refillPerSecond = 1) {
  return new TokenBucketLimiter({
    capacity,
    refillPerSecond,
    store: new MemoryStore(10_000, 600_000, clock.now),
    now: clock.now,
  });
}

describe('TokenBucketLimiter', () => {
  it('allows up to capacity, then rejects the next request', async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 5, 1);
    for (let i = 0; i < 5; i++) {
      expect((await limiter.consume('user-1')).allowed).toBe(true);
    }
    const sixth = await limiter.consume('user-1');
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('refills tokens over time', async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 5, 1); // 1 token per second
    for (let i = 0; i < 5; i++) await limiter.consume('user-1');
    expect((await limiter.consume('user-1')).allowed).toBe(false);

    clock.advanceMs(2_000); // two seconds -> two tokens
    expect((await limiter.consume('user-1')).allowed).toBe(true);
    expect((await limiter.consume('user-1')).allowed).toBe(true);
    expect((await limiter.consume('user-1')).allowed).toBe(false);
  });

  it('caps the sustained rate at the refill rate, even with bursts', async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 10, 5); // burst 10, sustained 5/sec
    // Spend the whole burst.
    for (let i = 0; i < 10; i++) expect((await limiter.consume('k')).allowed).toBe(true);
    // Over the next second only 5 more should pass, not 10.
    clock.advanceMs(1_000);
    let allowed = 0;
    for (let i = 0; i < 10; i++) if ((await limiter.consume('k')).allowed) allowed++;
    expect(allowed).toBe(5);
  });

  it('keeps callers isolated: one flooding user does not block another', async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 2, 1);
    expect((await limiter.consume('flooder')).allowed).toBe(true);
    expect((await limiter.consume('flooder')).allowed).toBe(true);
    expect((await limiter.consume('flooder')).allowed).toBe(false);
    // A different key still has a full bucket.
    expect((await limiter.consume('quiet-user')).allowed).toBe(true);
    expect((await limiter.consume('quiet-user')).allowed).toBe(true);
  });

  it('never creates tokens from a backwards clock jump', async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 1, 60);
    expect((await limiter.consume('k')).allowed).toBe(true);
    expect((await limiter.consume('k')).allowed).toBe(false);
    clock.advanceMs(-60_000); // NTP correction moves the clock backwards
    expect((await limiter.consume('k')).allowed).toBe(false); // no free refill
  });

  it('reports remaining and reset for headers', async () => {
    const clock = makeClock();
    const limiter = makeLimiter(clock, 3, 1);
    const first = await limiter.consume('k');
    expect(first.remaining).toBe(2);
    expect(first.resetSeconds).toBeGreaterThan(0);
  });
});
