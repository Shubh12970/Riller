/**
 * Tests for the Durable Object shared store, run against a fake storage
 * backed by a Map - no Cloudflare runtime needed. What is being proven:
 * the object enforces limits across "different isolates" (two limiter
 * clients talking to the same object), it persists state (a fresh object
 * over the same storage keeps the buckets), and its stats feed matches the
 * shape the dashboard chart expects.
 */

import { describe, expect, it } from 'vitest';
import { RateLimiterDO } from '../src/cloud/durableObject.js';
import { DurableObjectLimiter } from '../src/cloud/durableObjectLimiter.js';
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

function makeDO(storage = new FakeStorage()) {
  const state = { storage } as unknown as DurableObjectState;
  return new RateLimiterDO(state);
}

function consumeBody(limiter: string, key: string, capacity = 3, refillPerSecond = 1 / 3600) {
  // Slow refill so tests stay deterministic: no meaningful refill mid-test.
  return {
    method: 'POST',
    body: JSON.stringify({ limiter, key, capacity, refillPerSecond }),
  };
}

async function consume(durable: RateLimiterDO, limiter: string, key: string, capacity = 3) {
  const res = await durable.fetch(new Request('https://do/consume', consumeBody(limiter, key, capacity)));
  return (await res.json()) as RateLimitResult;
}

describe('RateLimiterDO', () => {
  it('enforces the limit and then rejects with retry math', async () => {
    const durable = makeDO();
    for (let i = 0; i < 3; i++) {
      expect((await consume(durable, 'login', 'ip:user')).allowed).toBe(true);
    }
    const fourth = await consume(durable, 'login', 'ip:user');
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(fourth.limit).toBe(3);
  });

  it('shares state across clients: two isolates spend from one bucket', async () => {
    const storage = new FakeStorage();
    const durable = makeDO(storage);
    // Two separate limiter objects (as two isolates would hold), same DO stub.
    const stub = { fetch: (input: string, init?: { method?: string; body?: string }) => durable.fetch(new Request(input, init)) };
    const isolateA = new DurableObjectLimiter(stub, 'data', 2, 1 / 3600);
    const isolateB = new DurableObjectLimiter(stub, 'data', 2, 1 / 3600);

    expect((await isolateA.consume('caller')).allowed).toBe(true);
    expect((await isolateB.consume('caller')).allowed).toBe(true);
    // The bucket held 2 tokens TOTAL - not 2 per isolate.
    expect((await isolateA.consume('caller')).allowed).toBe(false);
    expect((await isolateB.consume('caller')).allowed).toBe(false);
  });

  it('keeps limiters and keys isolated from each other', async () => {
    const durable = makeDO();
    for (let i = 0; i < 3; i++) await consume(durable, 'login', 'ip:user');
    expect((await consume(durable, 'login', 'ip:user')).allowed).toBe(false);
    // A different key on the same route, and the same key on another route, are unaffected.
    expect((await consume(durable, 'login', 'ip:other')).allowed).toBe(true);
    expect((await consume(durable, 'data', 'ip:user')).allowed).toBe(true);
  });

  it('persists buckets in storage: a fresh object over the same storage remembers', async () => {
    const storage = new FakeStorage();
    const first = makeDO(storage);
    for (let i = 0; i < 3; i++) await consume(first, 'login', 'ip:user');

    // Simulate the object being evicted and recreated: same storage, new memory.
    const second = makeDO(storage);
    expect((await consume(second, 'login', 'ip:user')).allowed).toBe(false);
  });

  it('records per-second stats in the shape the dashboard chart expects', async () => {
    const durable = makeDO();
    await consume(durable, 'data', 'a'); // allowed
    await consume(durable, 'data', 'a'); // allowed
    await consume(durable, 'data', 'a'); // allowed
    await consume(durable, 'data', 'a'); // rejected (capacity 3)

    const res = await durable.fetch(new Request('https://do/stats'));
    const snapshot = (await res.json()) as {
      seconds: Array<{ t: number; allowed: number; rejected: number }>;
      totals: { allowed: number; rejected: number };
    };
    expect(snapshot.seconds.length).toBe(120);
    expect(snapshot.totals).toEqual({ allowed: 3, rejected: 1 });
  });

  it('rejects malformed consume requests with 400', async () => {
    const durable = makeDO();
    const res = await durable.fetch(
      new Request('https://do/consume', { method: 'POST', body: JSON.stringify({ limiter: 'x' }) }),
    );
    expect(res.status).toBe(400);
  });
});
