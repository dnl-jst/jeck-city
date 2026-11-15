import { JOIN_PER_IP_PER_MIN } from '@nn/shared';

const WINDOW_MS = 60_000;
/** Beyond this many tracked addresses, expired ones are swept on the next call. */
const SWEEP_AT = 10_000;

/** Join attempts per address (ipHash) in a sliding 60 s window. */
export class JoinLimiter {
  private readonly seen = new Map<string, number[]>();

  constructor(private readonly perMin = JOIN_PER_IP_PER_MIN) {}

  /** Records a join by `ipHash` at `nowMs` and returns true, or returns false (not recorded) if the limit is reached. */
  allow(ipHash: string, nowMs: number): boolean {
    if (this.seen.size > SWEEP_AT) this.sweep(nowMs);
    const times = (this.seen.get(ipHash) ?? []).filter((t) => t > nowMs - WINDOW_MS);
    const ok = times.length < this.perMin;
    if (ok) times.push(nowMs);
    this.seen.set(ipHash, times);
    return ok;
  }

  private sweep(nowMs: number): void {
    for (const [k, times] of this.seen) if (times.every((t) => t <= nowMs - WINDOW_MS)) this.seen.delete(k);
  }
}
