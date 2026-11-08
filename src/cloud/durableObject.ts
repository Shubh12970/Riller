/**
 * RateLimiterDO - the shared store, as a Cloudflare Durable Object.
 *
 * The problem this solves: each Worker isolate has its own memory, so an
 * in-memory bucket Map enforces only "its share" of the traffic - two copies
 * of the worker each allow the full limit. A Durable Object is a named,
 * single-threaded object every isolate can reach, so all copies of the worker
 * spend from the SAME buckets. This is the "many servers need a shared store"
 * lesson from the docs, done the Cloudflare way (the Redis equivalent here).
 *
 * Two design points worth explaining:
 *
 * 1. The decision happens INSIDE the object. The worker sends {limiter, key,
 *    capacity, refillPerSecond}; the Durable Object runs the same pure
 *    consumeToken() math the local limiter uses, stores the result, and
 *    answers. Because the object is single-threaded, the whole check-and-
 *    spend is atomic - two isolates can never both spend the last token,
 *    which a remote get-then-set could not guarantee.
 *
 * 2. Memory stays bounded. Bucket states persist in the object's storage
 *    (SQLite-backed on the free tier) with a small hot cache in front, capped
 *    at 10,000 keys with 10-minute idle eviction - the same policy as
 *    MemoryStore - so a flood of random IPs or usernames cannot grow memory
 *    without bound. Storage is pruned of idle buckets at most once a minute,
 *    and the stats feed keeps only the last two minutes.
 */

import { consumeToken, type BucketState } from '../core/tokenBucket.js';
import { MemoryStore } from '../core/memoryStore.js';
import type { RateLimitResult } from '../core/types.js';

const BUCKET_PREFIX = 'bucket:';
const STATS_PREFIX = 'stats:';
const STATS_WINDOW_SECONDS = 120;
const IDLE_PRUNE_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;

interface ConsumeBody {
  limiter: string;
  key: string;
  capacity: number;
  refillPerSecond: number;
}

interface StatsSlot {
  allowed: number;
  rejected: number;
}

export interface StatsSnapshot {
  seconds: Array<{ t: number; allowed: number; rejected: number }>;
  totals: { allowed: number; rejected: number };
}

export class RateLimiterDO {
  /** Hot cache in front of storage; applies the same cap + idle eviction. */
  private readonly cache = new MemoryStore();
  private lastPruneMs = 0;

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/consume' && request.method === 'POST') {
      return this.handleConsume((await request.json()) as ConsumeBody);
    }
    if (url.pathname === '/stats') {
      return json(await this.statsSnapshot());
    }
    return new Response('not found', { status: 404 });
  }

  private async handleConsume(body: ConsumeBody): Promise<Response> {
    if (!body || typeof body.limiter !== 'string' || typeof body.key !== 'string'
      || !(body.capacity >= 1) || !(body.refillPerSecond > 0)) {
      return json({ error: 'consume needs { limiter, key, capacity >= 1, refillPerSecond > 0 }' }, 400);
    }

    const now = Date.now();
    const storageKey = `${BUCKET_PREFIX}${body.limiter}:${body.key}`;

    let current = this.cache.get(storageKey);
    if (!current) {
      current = await this.state.storage.get<BucketState>(storageKey);
    }

    const { state, result } = consumeToken(
      current ?? { tokens: body.capacity, lastRefillMs: now },
      body.capacity,
      body.refillPerSecond,
      now,
    );

    this.cache.set(storageKey, state);
    await this.state.storage.put(storageKey, state);
    await this.record(result.allowed, now);
    await this.pruneIdleBucketsIfDue(now);
    return json(result satisfies RateLimitResult);
  }

  private async record(allowed: boolean, nowMs: number): Promise<void> {
    const t = Math.floor(nowMs / 1000);
    const key = `${STATS_PREFIX}${t}`;
    const slot = (await this.state.storage.get<StatsSlot>(key)) ?? { allowed: 0, rejected: 0 };
    if (allowed) slot.allowed += 1;
    else slot.rejected += 1;
    await this.state.storage.put(key, slot);
  }

  private async statsSnapshot(nowMs: number = Date.now()): Promise<StatsSnapshot> {
    const nowT = Math.floor(nowMs / 1000);
    const oldestT = nowT - STATS_WINDOW_SECONDS + 1;
    const stored = await this.state.storage.list<StatsSlot>({ prefix: STATS_PREFIX });

    const seconds: StatsSnapshot['seconds'] = [];
    let allowed = 0;
    let rejected = 0;
    for (let t = oldestT; t <= nowT; t++) {
      const slot = stored.get(`${STATS_PREFIX}${t}`) ?? { allowed: 0, rejected: 0 };
      seconds.push({ t, allowed: slot.allowed, rejected: slot.rejected });
      allowed += slot.allowed;
      rejected += slot.rejected;
    }

    const expired: string[] = [];
    for (const key of stored.keys()) {
      if (Number(key.slice(STATS_PREFIX.length)) < oldestT) expired.push(key);
    }
    if (expired.length > 0) await this.state.storage.delete(expired);

    return { seconds, totals: { allowed, rejected } };
  }

  private async pruneIdleBucketsIfDue(nowMs: number): Promise<void> {
    if (nowMs - this.lastPruneMs < PRUNE_INTERVAL_MS) return;
    this.lastPruneMs = nowMs;
    const stored = await this.state.storage.list<BucketState>({ prefix: BUCKET_PREFIX });
    const idle: string[] = [];
    for (const [key, value] of stored) {
      if (nowMs - value.lastRefillMs > IDLE_PRUNE_MS) idle.push(key);
    }
    if (idle.length > 0) await this.state.storage.delete(idle);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
