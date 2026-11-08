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

/**
 * Minimal JSON body parser. Express's built-in express.json() pulls in
 * body-parser -> raw-body -> iconv-lite, and iconv-lite's stream usage does
 * not run on Cloudflare Workers. This API only ever accepts UTF-8 JSON, so
 * twenty lines replace that whole dependency chain and the same code runs on
 * both Node and Workers. Tradeoff, stated honestly: no charset handling
 * beyond UTF-8 and no body size limit config (a production API should add
 * one - a giant body currently buffers whole).
 */
function jsonBody() {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
      next();
      return;
    }
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => {
      if (data.length > 0) {
        try {
          req.body = JSON.parse(data);
        } catch {
          res.status(400).json({ error: 'Invalid JSON body' });
          return;
        }
      }
      next();
    });
    req.on('error', next);
  };
}

export function buildApp(stats: StatsRecorder = new StatsRecorder()) {
  const app = express();
  app.use(jsonBody());

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

  // Static dashboard files: served by express.static when running on Node.
  // On Cloudflare Workers, import.meta.url is undefined and the assets binding
  // in wrangler.jsonc serves public/ instead - so this whole block is skipped.
  try {
    const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public');
    app.use(express.static(publicDir));
  } catch {
    // Workers runtime: no module URL, no local filesystem. Assets binding owns static files.
  }

  return app;
}

function modulePath(): string | null {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

const isMain = process.argv[1] && modulePath() === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  buildApp().listen(port, () => {
    console.log(`Rate limiter demo listening on http://localhost:${port}`);
    console.log('Open that address for the live dashboard. API routes: /api/data, /api/login, /api/heavy');
  });
}
