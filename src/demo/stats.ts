/**
 * StatsRecorder - makes an invisible system visible.
 *
 * The limiter normally leaves no trace; this recorder keeps a per-second tally
 * of allowed vs rejected decisions for the last `windowSeconds`, so the demo
 * dashboard can draw the live chart. In-memory and approximate on purpose:
 * it is a teaching instrument, not a monitoring system.
 */

export interface StatsSecond {
  /** Unix seconds. */
  t: number;
  allowed: number;
  rejected: number;
}

export class StatsRecorder {
  private readonly windowSeconds: number;
  private readonly bySecond = new Map<number, { allowed: number; rejected: number }>();

  constructor(windowSeconds = 120) {
    this.windowSeconds = windowSeconds;
  }

  record(allowed: boolean, nowMs: number = Date.now()): void {
    const t = Math.floor(nowMs / 1000);
    const slot = this.bySecond.get(t) ?? { allowed: 0, rejected: 0 };
    if (allowed) slot.allowed += 1;
    else slot.rejected += 1;
    this.bySecond.set(t, slot);

    const cutoff = t - this.windowSeconds;
    for (const key of this.bySecond.keys()) {
      if (key < cutoff) this.bySecond.delete(key);
    }
  }

  snapshot(nowMs: number = Date.now()): { seconds: StatsSecond[]; totals: { allowed: number; rejected: number } } {
    const nowT = Math.floor(nowMs / 1000);
    const seconds: StatsSecond[] = [];
    let allowed = 0;
    let rejected = 0;
    for (let t = nowT - this.windowSeconds + 1; t <= nowT; t++) {
      const slot = this.bySecond.get(t) ?? { allowed: 0, rejected: 0 };
      seconds.push({ t, allowed: slot.allowed, rejected: slot.rejected });
      allowed += slot.allowed;
      rejected += slot.rejected;
    }
    return { seconds, totals: { allowed, rejected } };
  }
}
