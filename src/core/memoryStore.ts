/**
 * MemoryStore - where rate-limit state lives when there is exactly one server.
 *
 * Why a Map: lookups and writes are O(1) and it needs zero setup, which is the
 * right default for a single process. The tradeoff, explained in the docs:
 * state disappears on restart and is invisible to other server instances, so a
 * multi-server deployment would swap this for a shared store (e.g. Redis)
 * without touching the limiter code - the store is an interface for exactly
 * that reason.
 *
 * One bucket is stored per caller key, so memory grows with the number of
 * distinct callers. To stop a flood of random IPs from growing the Map
 * forever, buckets that have been idle longer than `idleMs` are evicted, and
 * the Map is hard-capped at `maxEntries`.
 */

import type { BucketState, TokenBucketStore } from './tokenBucket.js';

export class MemoryStore implements TokenBucketStore {
  private buckets = new Map<string, BucketState>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly idleMs = 10 * 60 * 1000,
    private readonly nowFn: () => number = Date.now,
  ) {}

  get(key: string): BucketState | undefined {
    return this.buckets.get(key);
  }

  set(key: string, state: BucketState): void {
    // Refresh recency by re-inserting (Map keeps insertion order).
    this.buckets.delete(key);
    this.buckets.set(key, state);
    if (this.buckets.size > this.maxEntries) {
      this.evict();
    }
  }

  size(): number {
    return this.buckets.size;
  }

  private evict(): void {
    const now = this.nowFn();
    for (const [key, state] of this.buckets) {
      if (now - state.lastRefillMs > this.idleMs) {
        this.buckets.delete(key);
      }
    }
    // Still over the cap? Drop the least-recently-touched entries first.
    while (this.buckets.size > this.maxEntries) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
    }
  }
}
