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
 */

import type { NextFunction, Request, Response } from 'express';
import type { RateLimiter, RateLimitResult } from '../core/types.js';

export interface RateLimitDecision {
  route: string;
  key: string;
  result: RateLimitResult;
}

export interface RateLimitOptions {
  limiter: RateLimiter;
  /**
   * Who is being limited. Default: the caller's IP. For authenticated routes
   * pass something like (req) => req.header('x-api-key') ?? req.ip.
   * Login-style routes should key on IP + account name, because an attacker
   * has no account yet - keying by user id alone would not slow them down.
   */
  keyGenerator?: (req: Request) => string;
  /** Observability hook: the demo dashboard records every decision through this. */
  onDecision?: (decision: RateLimitDecision) => void;
}

export function rateLimit(options: RateLimitOptions) {
  const keyGenerator = options.keyGenerator ?? ((req: Request) => req.ip ?? 'unknown-ip');

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyGenerator(req);
    const result = options.limiter.consume(key);

    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetSeconds);

    options.onDecision?.({ route: `${req.method} ${req.baseUrl}${req.path}`, key, result });

    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfterSeconds);
      res.status(429).json({
        error: 'Too many requests',
        retry_after_seconds: result.retryAfterSeconds,
      });
      return;
    }

    next();
  };
}
