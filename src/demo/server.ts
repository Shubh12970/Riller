/**
 * Demo API - a small Express server whose routes are protected by the limiter.
 *
 * Three routes with three different limits, to show that limiting is
 * per-route policy, not one global switch:
 *
 *   GET  /api/data   loose read endpoint: 30 requests burst, refilling at 10/sec
 *   POST /api/login  strict on purpose: 5/min per IP+username, so password
 *                    guessing becomes impractical while real users never notice
 *   GET  /api/heavy  per-API-key: 10/min and each call costs 3 tokens
 *                    (cost-based limiting: an expensive route spends more of
 *                    your budget than a cheap one); each x-api-key gets its
 *                    own bucket, so one noisy caller cannot starve the others
 *   GET  /api/ledger tiered plans: a realistic paid-API endpoint. The caller's
 *                    x-api-key selects the free plan (10/min) or the pro plan
 *                    (100/min); unknown keys get free. Two keys side by side
 *                    exhaust at visibly different limits, and one tenant's
 *                    traffic never touches another tenant's bucket.
 *
 * GET /__rl/stats.json feeds the live dashboard in public/index.html.
 *
 * Where the buckets live is a choice, injected through makeLimiter: locally
 * each limiter wraps a MemoryStore; on Cloudflare Workers the same routes get
 * DurableObjectLimiter, which spends from the shared store. The routes, the
 * middleware and the headers are identical either way - that swap-ability is
 * the point of the store interface.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TokenBucketLimiter } from '../core/tokenBucket.js';
import { MemoryStore } from '../core/memoryStore.js';
import { PLANS, planForApiKey } from '../core/plans.js';
import { rateLimit } from '../middleware/rateLimit.js';
import type { RateLimiter } from '../core/types.js';
import { StatsRecorder } from './stats.js';

export interface LimiterSpec {
  id: string;
  capacity: number;
  refillPerSecond: number;
}

export interface BuildAppOptions {
  /**
   * Local stats recorder. Pass null to disable in-process recording - on
   * Cloudflare the shared store records decisions globally instead, and the
   * worker serves /__rl/stats.json from it directly.
   */
  stats?: StatsRecorder | null;
  /** How each route's limiter is built. Default: token bucket + MemoryStore. */
  makeLimiter?: (spec: LimiterSpec) => RateLimiter;
}

/**
 * Minimal JSON body parser. Express's built-in express.json() pulls in
 * body-parser -> raw-body -> iconv-lite, and iconv-lite's stream usage does
 * not run on Cloudflare Workers. This API only ever accepts UTF-8 JSON, so
 * twenty lines replace that whole dependency chain and the same code runs on
 * both Node and Workers. Tradeoffs, stated honestly: no charset handling
 * beyond UTF-8, and the 1 MB cap below rejects bigger bodies where
 * body-parser's limit is configurable.
 */
function jsonBody() {
  const MAX_BODY_BYTES = 1024 * 1024;
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
      next();
      return;
    }
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        res.status(413).json({ error: 'Body too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (data.length > 0) {
        try {
          req.body = JSON.parse(data);
        } catch {
          if (!res.headersSent) res.status(400).json({ error: 'Invalid JSON body' });
          return;
        }
      }
      next();
    });
    req.on('error', next);
  };
}

export function buildApp(options: BuildAppOptions = {}) {
  const stats = options.stats === undefined ? new StatsRecorder() : options.stats;
  const makeLimiter =
    options.makeLimiter ??
    ((spec: LimiterSpec) =>
      new TokenBucketLimiter({
        capacity: spec.capacity,
        refillPerSecond: spec.refillPerSecond,
        store: new MemoryStore(),
      }));

  const app = express();
  app.use(jsonBody());

  const hook = stats
    ? (decision: { result: { allowed: boolean } }) => stats.record(decision.result.allowed)
    : undefined;

  const dataLimiter = makeLimiter({ id: 'data', capacity: 30, refillPerSecond: 10 });
  const loginLimiter = makeLimiter({ id: 'login', capacity: 5, refillPerSecond: 5 / 60 });
  const heavyLimiter = makeLimiter({ id: 'heavy', capacity: 10, refillPerSecond: 10 / 60 });

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
      // Cost-based limiting: this route is expensive, so each call spends
      // 3 of the caller's 10 tokens - three calls, then wait.
      cost: 3,
      onDecision: hook,
    }),
    (_req, res) => {
      res.json({ ok: true, result: 'Expensive computation finished.' });
    },
  );

  // Tiered plans: one limiter instance per plan, picked per request from the
  // caller's API key. The DO keys buckets by limiter id + caller key, so a
  // free tenant and a pro tenant never share a bucket.
  const planLimiters: Record<string, RateLimiter> = {};
  for (const plan of Object.values(PLANS)) {
    planLimiters[plan.name] = makeLimiter({
      id: `ledger:${plan.name}`,
      capacity: plan.capacity,
      refillPerSecond: plan.refillPerSecond,
    });
  }
  const planOf = (req: express.Request) => planForApiKey(req.header('x-api-key'));

  app.get(
    '/api/ledger',
    rateLimit({
      limiter: (req) => planLimiters[planOf(req).name],
      keyGenerator: (req) => req.header('x-api-key') ?? req.ip ?? 'unknown-ip',
      onDecision: hook,
      rejectedExtra: (req) => {
        const plan = planOf(req);
        return {
          plan: plan.name,
          limit_per_minute: plan.capacity,
          ...(plan.name === 'free'
            ? { upgrade: 'A pro API key raises this limit to 100/minute (try demo key: demo-pro-key).' }
            : {}),
        };
      },
    }),
    (req, res) => {
      const plan = planOf(req);
      res.setHeader('X-RateLimit-Plan', plan.name);
      res.json({ ok: true, plan: plan.name, ledger: ['payment-1', 'payment-2'] });
    },
  );

  app.get('/__rl/stats.json', (_req, res) => {
    if (!stats) {
      // Worker mode: the worker serves this route from the shared store
      // before it reaches Express, so landing here means misconfiguration.
      res.status(404).json({ error: 'stats are recorded in the shared store in this deployment' });
      return;
    }
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
