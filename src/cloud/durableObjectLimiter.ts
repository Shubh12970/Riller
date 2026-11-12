/**
 * DurableObjectLimiter - the same RateLimiter contract, backed by the shared
 * store instead of local memory.
 *
 * From the middleware's point of view nothing changes: consume(key) in, a
 * RateLimitResult out. Inside, the decision is delegated to the RateLimiterDO
 * Durable Object over Cloudflare's internal binding call, so every isolate of
 * the worker enforces one shared set of buckets. This is why the RateLimiter
 * interface is async: this store answers over the network, and the interface
 * had to make room for that honestly.
 *
 * The stub type is structural (just the fetch it needs), so tests can fake it
 * without any Cloudflare runtime.
 */

import type { RateLimiter, RateLimitResult } from '../core/types.js';

/** The slice of a Durable Object stub this limiter uses. */
export interface DurableObjectStubLike {
  fetch(input: string, init?: { method?: string; body?: string }): Promise<Response>;
}

export class DurableObjectLimiter implements RateLimiter {
  readonly limit: number;
  private readonly refillPerSecond: number;

  constructor(
    private readonly stub: DurableObjectStubLike,
    private readonly limiterId: string,
    capacity: number,
    refillPerSecond: number,
  ) {
    this.limit = capacity;
    this.refillPerSecond = refillPerSecond;
  }

  async consume(key: string, cost = 1): Promise<RateLimitResult> {
    const res = await this.stub.fetch('https://rate-limiter-do/consume', {
      method: 'POST',
      body: JSON.stringify({
        limiter: this.limiterId,
        key,
        capacity: this.limit,
        refillPerSecond: this.refillPerSecond,
        cost,
      }),
    });
    if (!res.ok) {
      throw new Error(`Shared rate-limit store answered ${res.status}`);
    }
    return (await res.json()) as RateLimitResult;
  }
}
