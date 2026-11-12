/**
 * Tiered plans: one route, per-tenant limits. Proves that the caller's API
 * key selects the plan (free 10/min, pro 100/min), that unknown keys get the
 * free plan, and that each tenant spends from their own bucket.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/demo/server.js';
import { planForApiKey } from '../src/core/plans.js';

describe('plans registry', () => {
  it('maps demo keys to their plans and unknown keys to free', () => {
    expect(planForApiKey('demo-pro-key').name).toBe('pro');
    expect(planForApiKey('demo-free-key').name).toBe('free');
    expect(planForApiKey('no-such-key').name).toBe('free');
    expect(planForApiKey(undefined).name).toBe('free');
  });
});

describe('GET /api/ledger (tiered plans)', () => {
  it('a free key exhausts at 10 requests while a pro key keeps going', async () => {
    const app = buildApp({ stats: null });
    // Free plan: 10 allowed, the 11th rejected with the plan named.
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get('/api/ledger').set('x-api-key', 'demo-free-key');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-plan']).toBe('free');
    }
    const rejected = await request(app).get('/api/ledger').set('x-api-key', 'demo-free-key');
    expect(rejected.status).toBe(429);
    expect(rejected.body.plan).toBe('free');
    expect(rejected.body.upgrade).toContain('pro');

    // The pro key has its own bucket: still allowed after the free key died.
    const pro = await request(app).get('/api/ledger').set('x-api-key', 'demo-pro-key');
    expect(pro.status).toBe(200);
    expect(pro.headers['x-ratelimit-plan']).toBe('pro');
    expect(pro.headers['x-ratelimit-limit']).toBe('100');
  });

  it('an unknown key is limited as a free caller under its own bucket', async () => {
    const app = buildApp({ stats: null });
    for (let i = 0; i < 10; i++) {
      await request(app).get('/api/ledger').set('x-api-key', 'random-caller');
    }
    const res = await request(app).get('/api/ledger').set('x-api-key', 'random-caller');
    expect(res.status).toBe(429);
    expect(res.body.plan).toBe('free');
  });
});
