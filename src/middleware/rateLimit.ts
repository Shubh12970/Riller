/**
 * Express middleware - the thin HTTP shell around a RateLimiter.
 *
 * Middleware runs before the route handler, so a rejected request costs almost
 * nothing and never touches the real logic or the database. On every request,
 * allowed or not, it emits the standard rate-limit headers so well-behaved
 * clients can slow themselves down before hitting the wall:
 *
 *   X-RateLimit-Limit      the configured limit for this route
 *   X-RateLimit-Remaining  requests still available right now
 *   X-RateLimit-Reset      seconds until the allowance is full again
 *
 * A rejected request gets HTTP 429, a Retry-After header, and a small JSON
 * body: { "error": "Too many requests", "retry_after_seconds": N }.
 *
 * The handler is async because the limiter may talk to a shared store (the
 * Durable Object on Cloudflare). Any store failure goes to Express's error
 * handler via next(err) rather than crashing the process or silently allowing.
 */

import type { NextFunction, Request, Response } from 'express';
import type { RateLimiter, RateLimitResult } from '../core/types.js';

export interface RateLimitDecision {
  route: string;
  key: string;
  result: RateLimitResult;
}

export interface RateLimitOptions {
  /**
   * The limiter to spend from, or a function picking one per request.
   * A function is how tiered plans work: the same route spends from the
   * free-plan bucket or the pro-plan bucket depending on the caller's key.
   */
  limiter: RateLimiter | ((req: Request) => RateLimiter);
  /**
   * Who is being limited. Default: the caller's IP. For authenticated routes
   * pass something like (req) => req.header('x-api-key') ?? req.ip.
   * Login-style routes should key on IP + account name, because an attacker
   * has no account yet - keying by user id alone would not slow them down.
   */
  keyGenerator?: (req: Request) => string;
  /**
   * Tokens this route spends per request (default 1), or a function of the
   * request. Cost-based limiting: expensive routes spend more, so the bucket
   * measures resource use, not just request count.
   */
  cost?: number | ((req: Request) => number);
  /** Observability hook: the demo dashboard records every decision through this. */
  onDecision?: (decision: RateLimitDecision) => void;
  /**
   * Extra fields merged into the 429 body - the tiered-plans route uses this
   * to name the caller's plan and how to get a higher limit.
   */
  rejectedExtra?: (req: Request) => Record<string, unknown>;
}

export function rateLimit(options: RateLimitOptions) {
  const keyGenerator = options.keyGenerator ?? ((req: Request) => req.ip ?? 'unknown-ip');

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const key = keyGenerator(req);
      const limiter = typeof options.limiter === 'function' ? options.limiter(req) : options.limiter;
      const cost = typeof options.cost === 'function' ? options.cost(req) : (options.cost ?? 1);
      const result = await limiter.consume(key, cost);

      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', result.resetSeconds);

      options.onDecision?.({ route: `${req.method} ${req.baseUrl}${req.path}`, key, result });

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfterSeconds);
        res.status(429).json({
          error: 'Too many requests',
          retry_after_seconds: result.retryAfterSeconds,
          ...(options.rejectedExtra?.(req) ?? {}),
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
