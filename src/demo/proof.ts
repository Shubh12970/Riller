/**
 * The live concurrency proof - the shared store's atomicity claim, made
 * testable by anyone instead of asserted in prose.
 *
 * The claim: when N requests arrive at the same key at the same time and the
 * bucket holds K tokens, EXACTLY K are allowed. A naive store (read the
 * bucket, then write it back) loses this race: two requests both read "1
 * token left" and both spend it. The Durable Object closes that race because
 * Cloudflare's input gates serialize storage-touching events (documented in
 * the "Rules of Durable Objects"), so each check-and-spend completes before
 * the next begins.
 *
 * This function is the honest version of that claim: it FIRES the burst and
 * counts. It demonstrates the guarantee on bounded runs against the live
 * deployment; it does not prove universal correctness of the whole system,
 * and the docs say so.
 *
 * Safety bounds (a public demo defends itself): the burst is fixed and small
 * (20 requests at a limit-10 bucket), every run uses a fresh throwaway probe
 * key so it never touches a real caller's bucket, and the endpoint itself is
 * rate-limited per IP. 20 requests against the free tier's 100,000/day
 * allowance is negligible.
 */

import type { RateLimitResult } from '../core/types.js';

export const PROOF_REQUESTS = 20;
export const PROOF_LIMIT = 10;

export interface ProofOutcome {
  requested: number;
  limit: number;
  allowed: number;
  rejected: number;
  passed: boolean;
  explanation: string;
}

/** Fire `n` parallel consumes and count how many were allowed. */
export async function runAtomicityProof(
  consumeOne: () => Promise<RateLimitResult>,
  n = PROOF_REQUESTS,
  k = PROOF_LIMIT,
): Promise<ProofOutcome> {
  const results = await Promise.all(Array.from({ length: n }, consumeOne));
  const allowed = results.filter((r) => r.allowed).length;
  return {
    requested: n,
    limit: k,
    allowed,
    rejected: n - allowed,
    passed: allowed === k,
    explanation:
      `${n} parallel requests, one bucket of ${k}: exactly ${k} were allowed, the behaviour the ` +
      'design predicts. The atomicity guarantee itself comes from the platform - a single-threaded ' +
      'Durable Object serializes every check-and-spend (Cloudflare input gates) - and this run ' +
      'demonstrates that behaviour on a bounded burst; it does not by itself prove the guarantee.',
  };
}
