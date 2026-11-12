/**
 * The concurrency proof: N parallel requests at one K-token bucket must allow
 * exactly K. Tested two ways: the local in-memory bucket, and the shared
 * store with a queue modeling the Durable Object's documented input gates
 * (storage-touching events are serialized, so check-and-spend is atomic).
 * The live endpoint demonstrates the real deployment; these tests pin the
 * logic. Plus: the proof endpoint limits itself to 10 runs/min per caller.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { runAtomicityProof } from '../src/demo/proof.js';
import { TokenBucketLimiter } from '../src/core/tokenBucket.js';
import { MemoryStore } from '../src/core/memoryStore.js';
import { RateLimiterDO } from '../src/cloud/durableObject.js';
import { buildApp } from '../src/demo/server.js';
import type { RateLimitResult } from '../src/core/types.js';

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

describe('runAtomicityProof', () => {
  it('exactly K of N parallel requests pass a local bucket', async () => {
    const bucket = new TokenBucketLimiter({ capacity: 10, refillPerSecond: 1 / 3600, store: new MemoryStore() });
    const outcome = await runAtomicityProof(() => bucket.consume('probe'), 20, 10);
    expect(outcome).toMatchObject({ requested: 20, limit: 10, allowed: 10, rejected: 10, passed: true });
  });

  it('exactly K of N parallel requests pass the shared store (input gates modeled)', async () => {
    const durable = new RateLimiterDO({ storage: new FakeStorage() } as unknown as DurableObjectState);
    // The real Durable Object serializes storage-touching events via input
    // gates; this queue models that guarantee for the in-memory fake.
    let chain: Promise<unknown> = Promise.resolve();
    const gated = (body: string): Promise<RateLimitResult> => {
      const p = chain
        .then(() => durable.fetch(new Request('https://do/consume', { method: 'POST', body })))
        .then((r) => r.json()) as Promise<RateLimitResult>;
      chain = p.catch(() => {});
      return p;
    };
    const outcome = await runAtomicityProof(
      () => gated(JSON.stringify({ limiter: 'probe', key: 'probe:test', capacity: 10, refillPerSecond: 1 / 3600, cost: 1 })),
      20,
      10,
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.allowed).toBe(10);
  });
});

describe('POST /__rl/atomicity-proof (local app)', () => {
  it('returns a passing proof, and rate-limits the proof endpoint itself', async () => {
    const app = buildApp({ stats: null });
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/__rl/atomicity-proof');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ requested: 20, limit: 10, allowed: 10, rejected: 10, passed: true });
    }
    const limited = await request(app).post('/__rl/atomicity-proof');
    expect(limited.status).toBe(429);
  });
});
