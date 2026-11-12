import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit } from '../src/middleware/rateLimit.js';
import { TokenBucketLimiter } from '../src/core/tokenBucket.js';
import { MemoryStore } from '../src/core/memoryStore.js';

function buildTestApp(capacity = 3) {
  const app = express();
  app.use(express.json());
  const limiter = new TokenBucketLimiter({
    capacity,
    refillPerSecond: 1 / 60, // slow refill so tests stay deterministic
    store: new MemoryStore(),
  });
  app.get(
    '/limited',
    rateLimit({
      limiter,
      keyGenerator: (req) => req.header('x-api-key') ?? 'anon',
    }),
    (_req, res) => res.json({ ok: true }),
  );
  return app;
}

describe('rateLimit middleware', () => {
  it('passes requests under the limit and emits rate-limit headers', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/limited').set('x-api-key', 'key-a');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('3');
    expect(res.headers['x-ratelimit-remaining']).toBe('2');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('decrements X-RateLimit-Remaining per request', async () => {
    const app = buildTestApp();
    const r1 = await request(app).get('/limited').set('x-api-key', 'key-a');
    const r2 = await request(app).get('/limited').set('x-api-key', 'key-a');
    expect(r1.headers['x-ratelimit-remaining']).toBe('2');
    expect(r2.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('rejects at the limit with 429, Retry-After and a JSON body', async () => {
    const app = buildTestApp();
    for (let i = 0; i < 3; i++) {
      await request(app).get('/limited').set('x-api-key', 'key-a');
    }
    const res = await request(app).get('/limited').set('x-api-key', 'key-a');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(res.body).toEqual({
      error: 'Too many requests',
      retry_after_seconds: expect.any(Number),
    });
  });

  it('isolates keys: a flooded caller does not affect others', async () => {
    const app = buildTestApp(1);
    await request(app).get('/limited').set('x-api-key', 'noisy');
    const flooded = await request(app).get('/limited').set('x-api-key', 'noisy');
    expect(flooded.status).toBe(429);

    const other = await request(app).get('/limited').set('x-api-key', 'quiet');
    expect(other.status).toBe(200);
  });

  it('rejected requests never reach the route handler', async () => {
    const app = express();
    let handlerCalls = 0;
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 1 / 60,
      store: new MemoryStore(),
    });
    app.get('/x', rateLimit({ limiter, keyGenerator: () => 'same' }), (_req, res) => {
      handlerCalls++;
      res.json({ ok: true });
    });
    await request(app).get('/x');
    await request(app).get('/x');
    await request(app).get('/x');
    expect(handlerCalls).toBe(1); // only the first request got through
  });
});

describe('cost option', () => {
  it('decrements X-RateLimit-Remaining by the route cost', async () => {
    const app = express();
    app.use(express.json());
    const limiter = new TokenBucketLimiter({
      capacity: 10,
      refillPerSecond: 1 / 60,
      store: new MemoryStore(),
    });
    app.get(
      '/pricey',
      rateLimit({ limiter, keyGenerator: (req) => req.header('x-api-key') ?? 'anon', cost: 3 }),
      (_req, res) => res.json({ ok: true }),
    );
    const res = await request(app).get('/pricey').set('x-api-key', 'key-a');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-remaining']).toBe('7');
  });
});
