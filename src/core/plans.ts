/**
 * Tiered plans - one limiter serving several customers, each with their own
 * limit. This is what turns a rate limiter from a single-bucket counter into
 * API-product shape: limits are PER-TENANT POLICY, not one global constant.
 *
 * The plans registry is deliberately plain data: a plan names a bucket
 * capacity and refill rate, and an API key maps to a plan. Callers without a
 * known key get the free plan - the same choice real freemium APIs make when
 * they allow keyless trial access.
 *
 * The demo keys below are PUBLIC DEMO CREDENTIALS, not secrets: they exist so
 * anyone can try both plans against the live demo, and they are documented as
 * such in the README. A production deployment would issue keys per customer
 * and store hashes, never ship keys in source.
 */

export interface Plan {
  name: string;
  /** Bucket capacity = maximum burst for this plan. */
  capacity: number;
  /** Tokens per second = sustained request rate for this plan. */
  refillPerSecond: number;
}

export const PLANS: Record<string, Plan> = {
  free: { name: 'free', capacity: 10, refillPerSecond: 10 / 60 },
  pro: { name: 'pro', capacity: 100, refillPerSecond: 100 / 60 },
};

/** Demo credentials only - see the file header. Maps API key -> plan name. */
export const DEMO_API_KEYS: Record<string, string> = {
  'demo-free-key': 'free',
  'demo-pro-key': 'pro',
};

/** The plan an incoming API key belongs to; unknown keys get the free plan. */
export function planForApiKey(apiKey: string | undefined): Plan {
  const planName = (apiKey && DEMO_API_KEYS[apiKey]) || 'free';
  return PLANS[planName];
}
