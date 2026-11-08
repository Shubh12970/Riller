/**
 * Shared types for every rate-limiting algorithm in this project.
 *
 * A RateLimiter answers one question: "may this caller make a request right now?"
 * It never knows about HTTP - that is the middleware's job. Keeping the core
 * free of Express means the same algorithms can run in any server, a test, or
 * later inside a Cloudflare Worker.
 */

export interface RateLimitResult {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** The configured limit (bucket capacity or window max) for this key. */
  limit: number;
  /** How many requests the caller can still make immediately. */
  remaining: number;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSeconds: number;
  /** Seconds until the bucket is full again / the window resets. */
  resetSeconds: number;
}

export interface RateLimiter {
  /** The configured limit, exposed so middleware can emit it as a header. */
  readonly limit: number;
  /** Spend one request for `key`. Pure decision: no I/O, no HTTP. */
  consume(key: string): RateLimitResult;
}
