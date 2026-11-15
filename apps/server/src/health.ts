/** Number of ticks /healthz looks back over (10 s at 60 Hz). */
export const HEALTH_WINDOW = 600;

export type Health = { players: number; tickP95Ms: number; dropped: number };

/** Sliding window over the last HEALTH_WINDOW ticks: how long each took and how many steps were dropped. */
export class TickStats {
  private readonly ms = new Float64Array(HEALTH_WINDOW);
  private readonly dropped = new Uint16Array(HEALTH_WINDOW);
  private n = 0;
  private head = -1;

  /** One executed tick that took `ms` milliseconds. */
  record(ms: number): void {
    this.head = (this.head + 1) % HEALTH_WINDOW;
    this.ms[this.head] = ms;
    this.dropped[this.head] = 0;
    this.n = Math.min(this.n + 1, HEALTH_WINDOW);
  }

  /** Steps dropped during the current wall-clock tick (counted against the newest tick in the window). */
  drop(count: number): void {
    if (count <= 0) return;
    if (this.n === 0) this.record(0);
    this.dropped[this.head] = Math.min(65535, this.dropped[this.head]! + count);
  }

  p95Ms(): number {
    if (this.n === 0) return 0;
    const sorted = Array.from(this.ms.subarray(0, this.n)).sort((a, b) => a - b);
    return Math.round(sorted[Math.min(this.n - 1, Math.ceil(this.n * 0.95) - 1)]! * 100) / 100;
  }

  droppedTotal(): number {
    let t = 0;
    for (let i = 0; i < this.n; i++) t += this.dropped[i]!;
    return t;
  }

  health(players: number): Health {
    return { players, tickP95Ms: this.p95Ms(), dropped: this.droppedTotal() };
  }
}
