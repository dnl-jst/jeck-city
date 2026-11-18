/** Ticks per check (5 s at 60 Hz). */
const WINDOW = 300;
/** Above this tick p95 (ms) the NPC density goes down, below LOW it goes up again (spec: 14/10; see the load test note). */
const HIGH = 15, LOW = 12.5;
const STEP = 0.1, MIN = 0.1;

/**
 * The NPCs' safety net: every 5 s the p95 of the tick times of the last 5 s decides whether the NPC cap (factor × NPC_MAX) goes down
 * (> 15 ms) or up (< 12.5 ms) by 0.1, within 0.1..1 (1.7 ms below the 16.7 ms budget). Measured on the machine the server runs on.
 */
export class LoadBrake {
  private readonly ms = new Float64Array(WINDOW);
  private n = 0;
  private f = 1;

  record(tickMs: number): void {
    this.ms[this.n++] = tickMs;
    if (this.n < WINDOW) return;
    this.n = 0;
    const sorted = Array.from(this.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(WINDOW * 0.95) - 1]!;
    if (p95 > HIGH) this.f = Math.max(MIN, Math.round((this.f - STEP) * 10) / 10);
    else if (p95 < LOW) this.f = Math.min(1, Math.round((this.f + STEP) * 10) / 10);
  }

  factor(): number {
    return this.f;
  }
}
