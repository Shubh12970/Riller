/**
 * Cloudflare Worker entry - wraps the same Express demo app so it runs on
 * Cloudflare's free tier. httpServerHandler (from the cloudflare:node runtime
 * module) bridges the Worker's fetch event to a Node-style http.Server, which
 * is what Express speaks. The static dashboard in public/ is served by
 * Workers Static Assets (see wrangler.jsonc); only /api/* and /__rl/*
 * requests reach this worker's own code.
 *
 * State lives in the RateLimiterDO Durable Object: one named, single-threaded
 * store that every isolate of this worker shares, so limits hold globally
 * instead of per-isolate. The dashboard's stats feed is served straight from
 * the same object, which is why the chart shows global traffic. Run locally
 * (npm run dev) and the identical routes use the in-memory store instead -
 * buildApp's makeLimiter hook is the only thing that changes.
 *
 * The Express app is built per request on purpose: Cloudflare binds I/O
 * objects (like the Durable Object stub) to the request whose env created
 * them, so a cached server would answer later requests with a dead stub and
 * 500s. Construction is a few middleware registrations - cheap at demo scale.
 */

import http from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { buildApp, type LimiterSpec } from './demo/server.js';
import { DurableObjectLimiter, type DurableObjectStubLike } from './cloud/durableObjectLimiter.js';
import { runAtomicityProof, PROOF_LIMIT, PROOF_REQUESTS } from './demo/proof.js';
import type { RateLimiter, RateLimitResult } from './core/types.js';

export { RateLimiterDO } from './cloud/durableObject.js';

interface Env {
  RATE_LIMITER: {
    idFromName(name: string): unknown;
    get(id: unknown): DurableObjectStubLike;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('global'));

    const url = new URL(request.url);
    if (url.pathname === '/__rl/stats.json') {
      // Straight from the shared store: global allowed/rejected counts.
      return stub.fetch('https://rate-limiter-do/stats');
    }

    if (url.pathname === '/__rl/atomicity-proof' && request.method === 'POST') {
      // The proof endpoint is itself rate-limited per caller (10 runs/min),
      // because a public demo defends itself.
      const gate = new DurableObjectLimiter(stub, 'proof', 10, 10 / 60);
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown-ip';
      const verdict = await gate.consume(ip);
      if (!verdict.allowed) {
        return Response.json(
          { error: 'Too many proof runs', retry_after_seconds: verdict.retryAfterSeconds },
          { status: 429, headers: { 'retry-after': String(verdict.retryAfterSeconds) } },
        );
      }
      // A fresh throwaway key per run: the proof never touches a real bucket.
      const probeKey = `probe:${crypto.randomUUID()}`;
      const outcome = await runAtomicityProof(
        () =>
          stub
            .fetch('https://rate-limiter-do/consume', {
              method: 'POST',
              body: JSON.stringify({
                limiter: 'probe',
                key: probeKey,
                capacity: PROOF_LIMIT,
                refillPerSecond: 1 / 3600, // no refill during the burst
                cost: 1,
              }),
            })
            .then((r) => r.json()) as Promise<RateLimitResult>,
        PROOF_REQUESTS,
        PROOF_LIMIT,
      );
      return Response.json(outcome);
    }

    const makeLimiter = (spec: LimiterSpec): RateLimiter =>
      new DurableObjectLimiter(stub, spec.id, spec.capacity, spec.refillPerSecond, spec.jail ?? false);
    const handler = httpServerHandler(http.createServer(buildApp({ stats: null, makeLimiter })));
    return handler.fetch(request);
  },
};
