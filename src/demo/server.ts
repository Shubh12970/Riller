/**
 * Demo API - a small Express server whose routes are protected by the limiter.
 *
 * Three routes with three different limits, to show that limiting is
 * per-route policy, not one global switch:
 *
 *   GET  /api/data   loose read endpoint: 30 requests burst, refilling at 10/sec
 *   POST /api/login  strict on purpose: 5/min per IP+username, so password
 *                    guessing becomes impractical while real users never notice
 *   GET  /api/heavy  per-API-key: 10/min; each x-api-key gets its own bucket,
 *                    so one noisy caller cannot starve the others
 *
 * GET /__rl/stats.json feeds the live dashboard in public/index.html.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TokenBucketLimiter } from '../core/tokenBucket.js';
import { MemoryStore } from '../core/memoryStore.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { StatsRecorder } from './stats.js';

export function buildApp(stats: StatsRecorder = new StatsRecorder()) {
  const app = express();
  app.use(express.json());

  const hook = (decision: { result: { allowed: boolean } }) => stats.record(decision.result.allowed);

  const dataLimiter = new TokenBucketLimiter({
    capacity: 30,
    refillPerSecond: 10,
    store: new MemoryStore(),
  });
  const loginLimiter = new TokenBucketLimiter({
    capacity: 5,
    refillPerSecond: 5 / 60,
    store: new MemoryStore(),
  });
  const heavyLimiter = new TokenBucketLimiter({
    capacity: 10,
    refillPerSecond: 10 / 60,
    store: new MemoryStore(),
  });

  app.get(
    '/api/data',
    rateLimit({ limiter: dataLimiter, onDecision: hook }),
    (_req, res) => {
      res.json({ ok: true, data: 'Here is your data.' });
    },
  );

  app.post(
    '/api/login',
    rateLimit({
      limiter: loginLimiter,
      keyGenerator: (req) => `${req.ip}:${req.body?.username ?? 'unknown'}`,
      onDecision: hook,
    }),
    (_req, res) => {
      res.status(401).json({ error: 'Invalid credentials (demo route - nothing to log into).' });
    },
  );

  app.get(
    '/api/heavy',
    rateLimit({
      limiter: heavyLimiter,
      keyGenerator: (req) => req.header('x-api-key') ?? req.ip ?? 'unknown-ip',
      onDecision: hook,
    }),
    (_req, res) => {
      res.json({ ok: true, result: 'Expensive computation finished.' });
    },
  );

  app.get('/__rl/stats.json', (_req, res) => {
    res.json(stats.snapshot());
  });

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');
  app.use(express.static(publicDir));

  return app;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  buildApp().listen(port, () => {
    console.log(`Rate limiter demo listening on http://localhost:${port}`);
    console.log('Open that address for the live dashboard. API routes: /api/data, /api/login, /api/heavy');
  });
}
