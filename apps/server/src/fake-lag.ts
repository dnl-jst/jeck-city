import type { FakeLag } from './config';

/** Dev-only: how long a stalled message is held back on top of the normal delay (looks like a lost TCP packet). */
export const STALL_MS = 200;

/**
 * One direction of one client's connection under fake lag. Each message is delayed by ms ± jitterMs; with
 * probability stallPct % it waits STALL_MS longer. Delivery order is always the order of push(), so nothing overtakes
 * a stalled message (TCP behaviour: 1 % loss shows up as a late burst, not as reordering).
 */
export class LagLine {
  private lastDue = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly lag: FakeLag, private readonly rand: () => number = Math.random) {}

  /** Runs `deliver` after the simulated delay. */
  push(deliver: () => void, nowMs: number = Date.now()): void {
    const { ms, jitterMs, stallPct } = this.lag;
    let delay = Math.max(0, ms + (this.rand() * 2 - 1) * jitterMs);
    if (this.rand() * 100 < stallPct) delay += STALL_MS;
    const due = Math.max(nowMs + delay, this.lastDue);
    this.lastDue = due;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      deliver();
    }, due - nowMs);
    this.timers.add(timer);
  }

  /** Drops everything still in flight (the client is gone). */
  cancel(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
