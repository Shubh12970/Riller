import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from '../src/core/fixedWindow.js';

function makeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advanceMs: (ms: number) => { now += ms; },
  };
}

describe('FixedWindowLimiter', () => {
  it('rejects the 101st request in a 100-per-minute window', async () => {
    const clock = makeClock();
    const limiter = new FixedWindowLimiter({ limit: 100, windowSeconds: 60, now: clock.now });
    for (let i = 0; i < 100; i++) {
      expect((await limiter.consume('user')).allowed).toBe(true);
    }
    const oneHundredFirst = await limiter.consume('user');
    expect(oneHundredFirst.allowed).toBe(false);
    expect(oneHundredFirst.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('resets when the next window begins', async () => {
    const clock = makeClock();
    const limiter = new FixedWindowLimiter({ limit: 2, windowSeconds: 60, now: clock.now });
    await limiter.consume('user');
    await limiter.consume('user');
    expect((await limiter.consume('user')).allowed).toBe(false);
    clock.advanceMs(60_000);
    expect((await limiter.consume('user')).allowed).toBe(true);
  });

  it('demonstrates the edge-burst weakness token bucket solves', async () => {
    // Start 59.9 seconds into a window: the limit is 60/minute, but 60 requests
    // at the end of one window plus 60 at the start of the next both pass -
    // 120 requests inside two seconds. This is why the demo routes use a bucket.
    const clock = makeClock(59_900);
    const limiter = new FixedWindowLimiter({ limit: 60, windowSeconds: 60, now: clock.now });
    let allowed = 0;
    for (let i = 0; i < 60; i++) if ((await limiter.consume('user')).allowed) allowed++;
    clock.advanceMs(200); // cross into the next window
    for (let i = 0; i < 60; i++) if ((await limiter.consume('user')).allowed) allowed++;
    expect(allowed).toBe(120);
  });
});
