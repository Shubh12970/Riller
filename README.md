# API Rate Limiter

A token-bucket API rate limiter for Express, with per-route limits, standard
rate-limit headers, correct 429 handling, a live allow/reject demo dashboard,
and a fully tested core. Built to learn - and to be able to explain - the
classic "design a rate limiter" system-design interview question with working
code behind it.

## Quick start

```bash
npm install
npm test          # 14 tests: algorithms + middleware behavior
npm run dev       # demo server on http://localhost:8787
```

Open http://localhost:8787 for the live dashboard: fire single requests,
bursts and floods at three differently-limited routes and watch allowed vs
rejected traffic per second.

## What's inside

| Piece | Where | What it does |
| --- | --- | --- |
| Token bucket | `src/core/tokenBucket.ts` | The main algorithm: bursts allowed, average capped |
| Fixed window | `src/core/fixedWindow.ts` | The simple baseline, kept to show its edge-burst weakness |
| Sliding window | `src/core/slidingWindow.ts` | The accurate-but-heavier third option |
| Memory store | `src/core/memoryStore.ts` | Per-key bucket state with idle eviction; swappable for Redis |
| Middleware | `src/middleware/rateLimit.ts` | Express middleware: headers, 429 + Retry-After, per-route keying |
| Demo API | `src/demo/server.ts` | Three routes with three limits (loose read, strict login, per-API-key) |
| Live dashboard | `public/index.html` | Canvas chart of allowed vs rejected per second, plus fire buttons |
| Tests | `test/` | At-limit behavior, refill math, bursts, per-key isolation, 429 shape |

## The behavior contract

Allowed responses carry:

```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 29
X-RateLimit-Reset: 1
```

A rejected request gets:

```
HTTP 429
Retry-After: 11
{ "error": "Too many requests", "retry_after_seconds": 11 }
```

Rejected requests never reach the route handler - the flood stops at the
middleware, before any real work or database query happens.

## Using the limiter on your own route

```ts
import { TokenBucketLimiter } from './src/core/tokenBucket.js';
import { MemoryStore } from './src/core/memoryStore.js';
import { rateLimit } from './src/middleware/rateLimit.js';

const limiter = new TokenBucketLimiter({
  capacity: 30,          // burst size
  refillPerSecond: 10,   // sustained rate
  store: new MemoryStore(),
});

app.get('/api/data', rateLimit({ limiter }), handler);
```

## Design notes (the interview version)

- **Who is limited** is per-route policy: reads are keyed by IP, the demo
  login route by IP + username (attackers have no account yet, so user-id
  keying would not slow them), the heavy route by API key.
- **Token bucket beats fixed window** because a fixed window lets a burst at
  the end of one window plus a burst at the start of the next through - the
  tests demonstrate 2x the limit passing in two seconds.
- **In-memory is right for one server.** Several servers behind a load
  balancer would each see only part of the traffic; the store is an interface
  so a shared Redis backend can replace it without touching the limiter.
- **The clock is injected and clamped** so a backwards clock jump can never
  mint free tokens.

## Roadmap

- [x] Token bucket, fixed window, sliding window cores with tests
- [x] Express middleware with headers + 429 contract
- [x] Live demo dashboard (allowed vs rejected chart)
- [ ] Redis-backed store for multi-server deployments
- [ ] Cloudflare Workers deployment of the demo
- [ ] Optional: protect StudyFlow's own API with this middleware
